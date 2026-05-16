/**
 * Provenance sidecar writer + reader for research-toolkit artifacts.
 *
 * Every file produced by a research run (plan, findings, report,
 * experiment logs, ...) records who wrote it - model id, thinking
 * level, timestamp, and a hash of the prompt that produced it - so a
 * later reader can audit "which model did this?" without guessing
 * from context. This is the load-bearing piece for the robustness
 * principle's "record which model wrote what" clause.
 *
 * Storage format varies by extension:
 *
 *   - Non-markdown artifacts (`.json`, `.txt`, etc.): a sibling
 *     `<artifact>.provenance.json` file, written atomically. Keeping
 *     provenance outside the artifact lets us machine-validate plans
 *     (`plan.json`) without teaching the schema about metadata.
 *   - Markdown artifacts (`.md`): a YAML frontmatter block at the top
 *     of the file. Render tools (bat, glow, anything wired through
 *     remark) already know how to skip frontmatter, so the doc still
 *     reads cleanly while the metadata rides along.
 *
 * The writer handles the idempotent replace case for markdown: if
 * the file already carries a frontmatter block, we replace it
 * in-place; otherwise we prepend. Non-frontmatter bytes are never
 * rewritten. The sidecar writer for non-markdown is a straight
 * overwrite - collisions are loud (fails validation) rather than
 * silently merged.
 *
 * No pi imports. Uses only `node:crypto`, `node:fs`, and
 * `atomic-write` for all mutating writes.
 */

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteFile } from './atomic-write.ts';
import { isRecord, sha256HexPrefix } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Types.
// ──────────────────────────────────────────────────────────────────────

/**
 * The metadata block attached to every generated artifact.
 *
 * - `model`: provider/id string as returned by pi's `resolveChildModel`
 *   (`anthropic/claude-sonnet-4-5`, `local/qwen3-...`). Callers pass
 *   the same value they passed to the session.
 * - `thinkingLevel`: pi's thinking-level string (`off` / `low` / etc.)
 *   or `null` when the caller intentionally does not want to record it
 *   (e.g. non-LLM-authored artifacts). Never omitted - a null carries
 *   different meaning than "we forgot."
 * - `timestamp`: ISO8601 UTC string. Callers pass `new Date().toISOString()`.
 * - `promptHash`: 12-char sha256 hex prefix of the prompt that produced
 *   the artifact. See `hashPrompt`.
 * - `summary` (optional): short human-readable one-liner describing
 *   what the artifact contains. Populated by the tiny-model adapter's
 *   `summarize-provenance` task when enabled; omitted entirely when
 *   the adapter is off. Cosmetic - makes `grep` over provenance
 *   readable without changing load-bearing behavior, so every
 *   reader must tolerate its absence.
 */
export interface Provenance {
  model: string;
  thinkingLevel: string | null;
  timestamp: string;
  promptHash: string;
  summary?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Prompt hashing.
// ──────────────────────────────────────────────────────────────────────

/**
 * Short content-addressable fingerprint of a prompt. We use the
 * first 12 hex chars of sha256 - enough to disambiguate at the scale
 * of a single research run without dragging 64 chars through every
 * journal entry. Full collisions within one run would require
 * ~16M prompts; we tolerate the residual risk for readability.
 */
export function hashPrompt(prompt: string): string {
  return sha256HexPrefix(prompt, 12);
}

// ───────────────────────────────────────────────────────────────────
// Inline frontmatter handling.
// ───────────────────────────────────────────────────────────────────

/**
 * Strip an inline YAML provenance frontmatter block (`--- ... ---`
 * at the very start of `text`) and return what remains. A body
 * that does not start with `---\n` is returned unchanged. Kept
 * minimal - we only need to discard the block, not parse it, and
 * we do NOT take a dependency on `parseFrontmatter` so any
 * research-core caller can safely reuse the helper without
 * pulling the full YAML stack into scope.
 *
 * Used by:
 *   - deep-research-pipeline's resume path when re-validating
 *     findings (accepted findings get `writeSidecar` appended as
 *     a YAML block at the top).
 *   - deep-research-synth-merge's `loadSectionBody` when loading
 *     a section snapshot off disk (the snapshot has the same
 *     provenance block; without stripping it, the merged report
 *     ends up with a `--- ... ---` block between every `## …`
 *     heading and its body, which confuses downstream parsers
 *     and duplicates section headings if the body also re-opens
 *     with `## <question>`).
 */
export function stripProvenanceFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;
  // Require a newline after the opening `---` to avoid false
  // positives on a body that happens to start with `---` (e.g. a
  // horizontal rule).
  const firstBreak = text.indexOf('\n');
  if (firstBreak < 0) return text;
  const rest = text.slice(firstBreak + 1);
  // Closing fence is a line that is exactly `---` at the start of
  // a line. Look for `\n---\n` or `\n---` at EOF.
  const closeIdx = rest.search(/(^|\n)---(\n|$)/);
  if (closeIdx < 0) return text;
  const afterClose = rest.indexOf('\n', rest.indexOf('---', closeIdx === 0 ? 0 : closeIdx + 1));
  if (afterClose < 0) return '';
  return rest.slice(afterClose + 1);
}

// ──────────────────────────────────────────────────────────────────────
// Sidecar path derivation.
// ──────────────────────────────────────────────────────────────────────

/**
 * `<artifact>.provenance.json` - the sibling sidecar path for any
 * non-markdown artifact. Duplicated (instead of imported from
 * `research-paths`) so this module does not take a dependency on
 * another research-* module's layout decisions for its own writes.
 * `research-paths.paths().provenanceFor()` returns the same string.
 */
export function sidecarPathFor(artifactPath: string): string {
  return `${artifactPath}.provenance.json`;
}

/**
 * True when we write the metadata as YAML frontmatter (inline) rather
 * than as a sibling sidecar JSON. The check is extension-based - the
 * whole toolkit agrees markdown means `.md`. `.markdown` is
 * intentionally treated as sidecar because it is rare and render
 * tooling support is inconsistent.
 */
function isMarkdown(artifactPath: string): boolean {
  return artifactPath.toLowerCase().endsWith('.md');
}

// ──────────────────────────────────────────────────────────────────────
// YAML frontmatter - narrow emit + parse.
// ──────────────────────────────────────────────────────────────────────

/**
 * YAML frontmatter delimiter. Three dashes at the start of a line,
 * alone. `---\r\n` is tolerated on read (Windows) but never emitted.
 */
const FM_DELIM = '---';

/**
 * Regex matching a leading frontmatter block. Captures:
 *   [1] - the frontmatter body (between the delimiters)
 *   [2] - the rest of the document (everything after the closing
 *         delimiter and its newline)
 *
 * Requires the opening `---` to be the very first line (no blank
 * prefix), per the CommonMark frontmatter convention. Handles both
 * `\n` and `\r\n` line endings.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Serialize a known-shape `Provenance` object as a YAML frontmatter
 * body (without the `---` delimiters). Each value is quoted via JSON
 * string encoding so embedded colons, newlines, or quotes don't
 * corrupt the block. Null is emitted as the bare literal `null` per
 * YAML convention.
 */
function emitYamlBody(p: Provenance): string {
  const q = (s: string): string => JSON.stringify(s);
  const tl = p.thinkingLevel === null ? 'null' : q(p.thinkingLevel);
  const lines = [
    'model: ' + q(p.model),
    'thinkingLevel: ' + tl,
    'timestamp: ' + q(p.timestamp),
    'promptHash: ' + q(p.promptHash),
  ];
  if (typeof p.summary === 'string' && p.summary.length > 0) {
    lines.push('summary: ' + q(p.summary));
  }
  return lines.join('\n');
}

/**
 * Wrap a frontmatter body in delimiters with a trailing newline so
 * the rest of the document starts on a fresh line.
 */
function wrapFrontmatter(body: string): string {
  return `${FM_DELIM}\n${body}\n${FM_DELIM}\n`;
}

/**
 * Parse a narrow subset of YAML sufficient for our own frontmatter
 * emitter. Recognizes `key: "quoted"`, `key: null`, and tolerates
 * surrounding whitespace. Unknown/malformed lines are ignored - a
 * call that produces no usable fields returns `null` upstream.
 *
 * Deliberately hand-rolled instead of pulling in a YAML library: we
 * only read what we ourselves wrote, and fighting a full YAML parser
 * for a tiny known shape would add a transitive dep.
 */
function parseYamlBody(body: string): Partial<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const raw = trimmed.slice(colon + 1).trim();
    if (raw === 'null') {
      out[key] = null;
      continue;
    }
    // JSON.parse handles both `"..."` and un-quoted scalars that
    // happen to be valid JSON. Bail out silently on invalid lines.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'string') out[key] = parsed;
      else if (parsed === null) out[key] = null;
      // numbers/booleans/objects not expected - ignore.
    } catch {
      // Unquoted scalar: accept as-is.
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Extract the frontmatter body (if any) and the rest of the document
 * from a markdown file's raw contents. Returns `{body: null, rest}`
 * when no frontmatter is present.
 */
function splitFrontmatter(text: string): { body: string | null; rest: string } {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { body: null, rest: text };
  return { body: m[1] ?? '', rest: m[2] ?? '' };
}

// ──────────────────────────────────────────────────────────────────────
// Provenance <-> structural shape.
// ──────────────────────────────────────────────────────────────────────

/**
 * Cast a parsed YAML/JSON record into `Provenance` if it has the
 * required fields with the required types. Missing or wrong-typed
 * fields make the whole record reject - an incomplete provenance is
 * worse than none.
 */
function toProvenance(raw: unknown): Provenance | null {
  if (!isRecord(raw)) return null;
  const { model, thinkingLevel, timestamp, promptHash, summary } = raw;
  if (typeof model !== 'string' || model.length === 0) return null;
  if (thinkingLevel !== null && typeof thinkingLevel !== 'string') return null;
  if (typeof timestamp !== 'string' || timestamp.length === 0) return null;
  if (typeof promptHash !== 'string' || promptHash.length === 0) return null;
  const out: Provenance = { model, thinkingLevel, timestamp, promptHash };
  // `summary` is optional. We accept only non-empty strings - any
  // other shape (null, numeric, empty string) drops silently so a
  // misconfigured sidecar doesn't surface a `summary: ""` field to
  // downstream readers.
  if (typeof summary === 'string' && summary.length > 0) {
    out.summary = summary;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Public writer.
// ──────────────────────────────────────────────────────────────────────

function writeMarkdownFrontmatter(artifactPath: string, p: Provenance): void {
  const frontmatter = wrapFrontmatter(emitYamlBody(p));
  if (!existsSync(artifactPath)) {
    atomicWriteFile(artifactPath, frontmatter);
    return;
  }
  const existing = readFileSync(artifactPath, 'utf8');
  const { body, rest } = splitFrontmatter(existing);
  // If there was no prior frontmatter, prepend. Otherwise replace.
  const next = body === null ? frontmatter + existing : frontmatter + rest;
  atomicWriteFile(artifactPath, next);
}

/**
 * Record `p` as the provenance for `artifactPath`.
 *
 *   - `.md` artifacts: the provenance is emitted as a YAML
 *     frontmatter block at the top of the file. If the file does not
 *     yet exist, it is created with *only* the frontmatter (the
 *     artifact body is presumed to land later). If the file already
 *     has a frontmatter block, the block is replaced in-place - the
 *     rest of the document is preserved byte-for-byte.
 *   - Every other extension: a sibling `<artifact>.provenance.json`
 *     file is written atomically. The artifact itself is never read
 *     or touched.
 *
 * All writes go through `atomic-write.atomicWriteFile` so concurrent
 * readers never see a half-written provenance.
 */
export function writeSidecar(artifactPath: string, p: Provenance): void {
  if (isMarkdown(artifactPath)) {
    writeMarkdownFrontmatter(artifactPath, p);
  } else {
    // Build the JSON payload explicitly so an undefined `summary`
    // doesn't serialize as `"summary": undefined` (JSON.stringify
    // drops undefined, but the explicit build keeps key order
    // stable and documents the shape on disk).
    const payload: Record<string, unknown> = {
      model: p.model,
      thinkingLevel: p.thinkingLevel,
      timestamp: p.timestamp,
      promptHash: p.promptHash,
    };
    if (typeof p.summary === 'string' && p.summary.length > 0) {
      payload.summary = p.summary;
    }
    atomicWriteFile(sidecarPathFor(artifactPath), JSON.stringify(payload, null, 2) + '\n');
  }
}

// ──────────────────────────────────────────────────────────────────────
// Public reader.
// ──────────────────────────────────────────────────────────────────────

function readFromMarkdown(artifactPath: string): Provenance | null {
  if (!existsSync(artifactPath)) return null;
  const text = readFileSync(artifactPath, 'utf8');
  const { body } = splitFrontmatter(text);
  if (body === null) return null;

  return toProvenance(parseYamlBody(body));
}

function readFromSidecar(artifactPath: string): Provenance | null {
  const sidecar = sidecarPathFor(artifactPath);
  if (!existsSync(sidecar)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(sidecar, 'utf8'));

    return toProvenance(parsed);
  } catch {
    return null;
  }
}

/**
 * Return the provenance attached to `artifactPath` if any, else
 * `null`. Tries the format consistent with the artifact's extension
 * first, then falls back to the other shape so callers can migrate
 * an artifact between formats without rewriting history.
 *
 *   - `.md` path → first look for a YAML frontmatter block in the
 *     file; if absent, fall back to a sibling `<path>.provenance.json`.
 *   - Other paths → first look for a sibling sidecar; there is no
 *     sensible frontmatter fallback for non-markdown.
 *
 * Returns `null` on any parse failure rather than throwing - callers
 * treat "no provenance" and "corrupt provenance" the same (they
 * rewrite on the next save). A noisier diagnostic is the journal's
 * job, not this module's.
 */
export function readProvenance(artifactPath: string): Provenance | null {
  if (isMarkdown(artifactPath)) {
    const fromFrontmatter = readFromMarkdown(artifactPath);
    if (fromFrontmatter) return fromFrontmatter;

    return readFromSidecar(artifactPath);
  }

  return readFromSidecar(artifactPath);
}
