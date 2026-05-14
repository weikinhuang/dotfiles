/**
 * Mode-file parser for `config/pi/extensions/mode.ts`.
 *
 * Pure module — no pi imports — so it can be unit-tested under `vitest`.
 * The frontmatter parser is injected (matches `subagent-loader.ts`) so
 * the extension wires pi's `parseFrontmatter` while tests can drive the
 * loader with a stub.
 *
 * Schema is a strict superset of the agent frontmatter (see
 * `plans/pi-mode-extension.md` → "Mode file schema (frontmatter)").
 * Mode-only fields: `agent`, `writeRoots`, `bashAllow`, `bashDeny`,
 * `appendSystemPrompt`. Validation collects warnings rather than
 * throwing — one bad mode file should never blind the whole catalog.
 */

import { basename } from 'node:path';

const THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type ModeThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ModeSourceLayer = 'shipped' | 'user' | 'project';

/** Raw, untyped frontmatter — every field is `unknown` until validated. */
export interface ModeFrontmatterRaw extends Record<string, unknown> {
  name?: unknown;
  description?: unknown;
  agent?: unknown;
  tools?: unknown;
  writeRoots?: unknown;
  bashAllow?: unknown;
  bashDeny?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  appendSystemPrompt?: unknown;
}

/**
 * Result of validating a mode `.md` file. `tools` is `undefined` when
 * the field is absent in frontmatter — the inheritance pass will pull
 * it from the referenced agent (D5 in the plan).
 */
export interface ParsedMode {
  name: string;
  description?: string;
  agent?: string;
  tools?: string[];
  writeRoots: string[];
  bashAllow: string[];
  bashDeny: string[];
  model?: string;
  thinkingLevel?: ModeThinkingLevel;
  appendSystemPrompt?: string;
  body: string;
  source: string;
}

export interface ModeWarning {
  path: string;
  reason: string;
}

export interface ParseModeOptions {
  path: string;
  source: ModeSourceLayer;
  raw: string;
  knownToolNames: ReadonlySet<string>;
  parseFrontmatter: (raw: string) => { frontmatter: Record<string, unknown>; body: string };
  /** Mutated in place — same pattern as `subagent-loader.ts`. */
  warnings: ModeWarning[];
}

function toStringOrUndefined(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t.length > 0) return t;
  return undefined;
}

/** Validate a string array; drop non-string entries with a per-entry warning. */
function toStringArray(value: unknown, field: string, path: string, warnings: ModeWarning[]): string[] | undefined {
  if (!Array.isArray(value)) {
    warnings.push({ path, reason: `\`${field}\` must be an array of strings` });
    return undefined;
  }
  const kept: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      warnings.push({ path, reason: `\`${field}\` entry "${String(raw)}" is not a string (dropped)` });
      continue;
    }
    kept.push(raw);
  }
  return kept;
}

function stemFromPath(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  if (dot > 0) return base.slice(0, dot);
  return base;
}

/**
 * Parse one mode `.md` file. Returns `null` and pushes a warning when
 * the file is unusable (no frontmatter, parser threw, etc.). Unknown
 * frontmatter keys are tolerated silently.
 */
export function parseModeFile(opts: ParseModeOptions): ParsedMode | null {
  const { path, raw, knownToolNames, parseFrontmatter, warnings } = opts;

  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(raw);
  } catch (e) {
    warnings.push({ path, reason: e instanceof Error ? e.message : String(e) });
    return null;
  }

  if (!parsed.frontmatter || Object.keys(parsed.frontmatter).length === 0) {
    warnings.push({ path, reason: 'missing or empty frontmatter' });
    return null;
  }

  const fm = parsed.frontmatter as ModeFrontmatterRaw;

  // name: explicit FM value, else filename stem.
  const explicitName = toStringOrUndefined(fm.name);
  const name = explicitName ?? stemFromPath(path);

  const description = toStringOrUndefined(fm.description);
  const agent = toStringOrUndefined(fm.agent);

  // tools: undefined when omitted — inheritance pass fills from agent.
  let tools: string[] | undefined;
  if (fm.tools !== undefined) {
    const arr = toStringArray(fm.tools, 'tools', path, warnings);
    if (arr) {
      const kept: string[] = [];
      for (const raw2 of arr) {
        const t = raw2.trim();
        if (t.length === 0) continue;
        if (!knownToolNames.has(t)) {
          warnings.push({ path, reason: `unknown tool "${t}" (dropped)` });
          continue;
        }
        kept.push(t);
      }
      tools = kept;
    }
    // If `arr` is undefined (bad shape), `tools` stays undefined — the
    // mode is still returned, deferring tool resolution to inheritance
    // or to the caller noticing the warning.
  }

  // writeRoots / bashAllow / bashDeny: validated as plain string arrays.
  const writeRoots = fm.writeRoots !== undefined ? toStringArray(fm.writeRoots, 'writeRoots', path, warnings) : [];
  const bashAllow = fm.bashAllow !== undefined ? toStringArray(fm.bashAllow, 'bashAllow', path, warnings) : [];
  const bashDeny = fm.bashDeny !== undefined ? toStringArray(fm.bashDeny, 'bashDeny', path, warnings) : [];

  // model: 'inherit' is a sentinel; otherwise must look like provider/id.
  let model: string | undefined;
  if (fm.model !== undefined) {
    if (typeof fm.model !== 'string') {
      warnings.push({ path, reason: `\`model\` must be a string (got ${typeof fm.model})` });
    } else if (fm.model === 'inherit') {
      model = 'inherit';
    } else if (fm.model.includes('/')) {
      model = fm.model;
    } else {
      warnings.push({ path, reason: `invalid model "${fm.model}" (expected "inherit" or "provider/id")` });
    }
  }

  // thinkingLevel: one of the four canonical values.
  let thinkingLevel: ModeThinkingLevel | undefined;
  if (fm.thinkingLevel !== undefined) {
    if (typeof fm.thinkingLevel === 'string' && (THINKING_LEVELS as readonly string[]).includes(fm.thinkingLevel)) {
      thinkingLevel = fm.thinkingLevel as ModeThinkingLevel;
    } else {
      warnings.push({
        path,
        reason: `invalid thinkingLevel (must be one of: ${THINKING_LEVELS.join(', ')})`,
      });
    }
  }

  const appendSystemPrompt = toStringOrUndefined(fm.appendSystemPrompt);

  return {
    name,
    description,
    agent,
    tools,
    writeRoots: writeRoots ?? [],
    bashAllow: bashAllow ?? [],
    bashDeny: bashDeny ?? [],
    model,
    thinkingLevel,
    appendSystemPrompt,
    body: parsed.body,
    source: path,
  };
}
