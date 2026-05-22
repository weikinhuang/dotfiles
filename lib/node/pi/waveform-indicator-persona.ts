/**
 * Persona loader for the waveform-indicator's dynamic head.
 *
 * Pure module - no pi imports - so it can be unit-tested under
 * `vitest`. The extension wires pi's `parseFrontmatter` and the
 * three persona-layer paths; this helper handles layer resolution
 * and frontmatter parsing.
 *
 * Why a separate module instead of reusing
 * [`config/pi/extensions/persona.ts`](../../../config/pi/extensions/persona.ts):
 * the persona extension loads the full catalog up-front and is
 * tightly coupled to `ExtensionAPI` / `ExtensionContext`. The
 * waveform indicator only needs the markdown body of ONE persona at
 * a time (the configured `dynamicLabel.persona`), and it doesn't
 * care about tools / writeRoots / bashAllow / model / thinkingLevel
 * - those are all enforced upstream by the spawned `waveform-phraser`
 * agent's frontmatter (`tools: []`, etc). This loader returns just
 * the body so the extension can append it to the agent's
 * `appendSystemPrompt` field.
 *
 * Layer order (first hit wins, project highest priority):
 *
 *   1. `<cwd>/.pi/personas/<name>.md`
 *   2. `<home>/.pi/personas/<name>.md`
 *   3. `<extDir>/../personas/<name>.md` (shipped catalog, where the
 *      bundled `daemon-waveform.md` lives)
 *
 * Note: this is the same set of layers the persona extension uses,
 * but the precedence is inverted relative to the persona extension's
 * merge-by-overwrite pass. Both produce the same observable behaviour
 * ("project wins, shipped is the floor") - the persona extension
 * overwrites earlier wins, this loader short-circuits on the first
 * hit. The shipped layer always exists for the default `daemon-waveform`
 * persona, so layer 3 is the safety net that keeps the dynamic head
 * working on a fresh dotfiles install with no user / project
 * personas configured.
 */

import { parsePersonaFile, type PersonaWarning } from './persona/parse.ts';

// ──────────────────────────────────────────────────────────────────────
// Path layers
// ──────────────────────────────────────────────────────────────────────

export interface PersonaLayerPaths {
  /** `<cwd>/.pi/personas` - highest priority. */
  projectDir: string;
  /** `<home>/.pi/personas` - user-global overrides. */
  userDir: string;
  /** `<extDir>/../personas` - shipped catalog (the `daemon-waveform.md` floor). */
  shippedDir: string;
}

export interface PersonaFsAdapter {
  /** Return `true` when `path` exists and is a readable file. */
  exists: (path: string) => boolean;
  /** Read the file contents as UTF-8, or `null` on error. */
  readFile: (path: string) => string | null;
}

/**
 * Walk the layers in priority order and return the first existing
 * `<layer>/<name>.md`, or `null` when no layer carries the persona.
 *
 * Returns the full absolute path so the caller can hand it straight
 * to {@link loadPersonaBody}. Files that exist but are unreadable
 * still count as "found" here - that case is surfaced as a warning
 * inside `loadPersonaBody` rather than as a missed lookup. The
 * distinction matters because a missing file falls through to the
 * next layer, while an unreadable file at a higher layer doesn't.
 */
export function resolvePersonaPath(name: string, layers: PersonaLayerPaths, fs: PersonaFsAdapter): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const filename = `${trimmed}.md`;
  // The layer-walk order is fixed because the plan describes a
  // strict "project → user → shipped" precedence. Using a literal
  // array keeps it grep-able from the resolution-order test.
  const ordered = [layers.projectDir, layers.userDir, layers.shippedDir];
  for (const dir of ordered) {
    const candidate = `${dir}/${filename}`;
    if (fs.exists(candidate)) return candidate;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Body extraction
// ──────────────────────────────────────────────────────────────────────

/** Shape of pi's `parseFrontmatter` - same shape used elsewhere in `lib/node/pi/`. */
export type FrontmatterParser = (raw: string) => { frontmatter: Record<string, unknown>; body: string };

export interface LoadPersonaBodyResult {
  /** Cleaned persona body (markdown overlay), or `null` on any failure. */
  body: string | null;
  /** Source path that produced the body, when a file was actually read. */
  source?: string;
  /**
   * Diagnostic warnings produced by the underlying `parsePersonaFile`.
   * Caller surfaces these via `ctx.ui.notify(..., 'warning')`. A
   * non-empty `warnings` array WITH `body === null` indicates a
   * malformed persona file the caller should treat as "no overlay"
   * (the extension falls back to the neutral system prompt).
   */
  warnings: PersonaWarning[];
}

/**
 * Read `path`, parse the frontmatter, and return the markdown body.
 *
 * Failures (file missing, unreadable, no frontmatter, parse error)
 * all collapse to `{ body: null, warnings: [...] }`. Callers treat
 * `null` as "no persona overlay" and fall back to the neutral
 * system prompt the `waveform-phraser` agent ships with.
 *
 * The empty `knownToolNames` set is deliberate: this loader only
 * cares about the body, not the tools list. The waveform indicator
 * never reuses the persona's tools - the spawned phraser is locked
 * to `tools: []` by its own frontmatter, the spawn site, and the
 * system-prompt rule sheet (the three-layer guarantee the plan
 * calls out). A persona that ships with a populated `tools` array
 * will trip per-tool "unknown tool" warnings here, which is the
 * intended way to surface "this persona has tool semantics the
 * waveform head is silently dropping".
 */
export function loadPersonaBody(
  path: string,
  parseFrontmatter: FrontmatterParser,
  fs: PersonaFsAdapter,
): LoadPersonaBodyResult {
  const warnings: PersonaWarning[] = [];
  const raw = fs.readFile(path);
  if (raw === null) {
    warnings.push({ path, reason: 'persona file unreadable' });
    return { body: null, warnings };
  }
  const parsed = parsePersonaFile({
    path,
    source: 'shipped',
    raw,
    knownToolNames: new Set<string>(),
    parseFrontmatter,
    warnings,
  });
  if (parsed === null) {
    return { body: null, warnings };
  }
  const trimmed = parsed.body.trim();
  if (trimmed.length === 0) {
    warnings.push({ path, reason: 'persona body is empty' });
    return { body: null, source: path, warnings };
  }
  return { body: trimmed, source: path, warnings };
}
