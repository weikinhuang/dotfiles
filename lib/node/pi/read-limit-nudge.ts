/**
 * Pure helpers for the read-without-limit-nudge extension.
 *
 * No pi imports — unit-testable under `vitest`.
 *
 * ## What the extension does
 *
 * Pi's `read` tool accepts `offset` + `limit`. When omitted, the tool
 * serves the file from line 1 up to the default cap (2000 lines /
 * 50KB). Small models routinely call `read` on big files without those
 * hints — burning 30–40k tokens per read — even though they only
 * wanted to find a single symbol that `rg -n` would have located in
 * two orders of magnitude less context.
 *
 * This module classifies a completed read call against thresholds and
 * builds a short one-paragraph nudge when the read was:
 *
 *   (a) without `offset` AND without `limit`, AND
 *   (b) on a file large enough that `rg` would have been the better
 *       first move (default ≥ 400 lines OR ≥ 20KB).
 *
 * The nudge is appended to the tool result content; it does NOT block
 * or mutate `isError`, and it does NOT fire on reads that already hit
 * a truncation notice (pi's own `[Showing lines X-Y of Z…]` already
 * tells the model what to do there — our extra nudge would be noise).
 *
 * Signal shape is deliberately narrow: callers pass in ONE
 * `TruncationLike` summarizing what pi's read tool reported (or what
 * the extension measured itself via `statSync` + a byte read), plus
 * the offset/limit the model asked for.
 */

/**
 * Subset of pi's `TruncationResult` we care about. All fields
 * optional so callers can synthesize from `statSync` when pi didn't
 * populate a `truncation` block (e.g. small files read whole).
 */
export interface TruncationLike {
  /** Total lines in the original file. */
  totalLines?: number;
  /** Total bytes in the original file. */
  totalBytes?: number;
  /** Whether pi already reported truncation to the model. */
  truncated?: boolean;
}

export interface NudgeOptions {
  /** Minimum line count to nudge on. Default 400. */
  minLines?: number;
  /** Minimum byte count to nudge on. Default 20 * 1024. */
  minBytes?: number;
  /** Marker prepended to the nudge text. */
  marker?: string;
}

export const DEFAULT_MIN_LINES = 400;
export const DEFAULT_MIN_BYTES = 20 * 1024;
export const NUDGE_MARKER = '📏 [pi-read-without-limit]';

export interface NudgeProbe {
  /** Display-friendly path (usually relative to cwd). */
  displayPath: string;
  /** 1-based `offset` the model passed, or undefined. */
  offset: number | undefined;
  /** `limit` the model passed, or undefined. */
  limit: number | undefined;
  /** Pi's truncation report / our synthesized version. */
  truncation: TruncationLike;
}

export type NudgeDecision =
  | { kind: 'skip'; reason: 'had-offset' | 'had-limit' | 'already-truncated' | 'small-file' | 'unknown-size' }
  | { kind: 'nudge'; reason: 'lines' | 'bytes'; nudge: string };

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

function formatNudge(probe: NudgeProbe, reason: 'lines' | 'bytes', marker = NUDGE_MARKER): string {
  const lines = probe.truncation.totalLines;
  const bytes = probe.truncation.totalBytes;
  const sizePhrase =
    reason === 'lines' && lines !== undefined ? `${lines} lines` : bytes !== undefined ? formatBytes(bytes) : 'large';

  return [
    `${marker} ${probe.displayPath} (${sizePhrase})`,
    '',
    `You read this ${sizePhrase}-long file without \`offset\` / \`limit\`. For files this size, prefer one of:`,
    '  • `rg -n "<pattern>" <path>` to jump straight to the lines that matter,',
    '  • `read` with `offset` / `limit` once you know which region you need, or',
    '  • `ls -l` / a quick `head`/`tail` if you only need structural orientation.',
    'Reading the whole file wholesale is fine for small files; above ~400 lines it usually wastes context.',
  ].join('\n');
}

/**
 * Classify one read call. Returns either a nudge (with the exact
 * reason) or a skip (with a diagnostic reason for tracing).
 *
 * We require EITHER a known `totalLines` or a known `totalBytes`; with
 * neither we skip (`unknown-size`). The two thresholds OR together —
 * whichever triggers first wins.
 */
export function classifyRead(probe: NudgeProbe, opts: NudgeOptions = {}): NudgeDecision {
  if (probe.offset !== undefined) return { kind: 'skip', reason: 'had-offset' };
  if (probe.limit !== undefined) return { kind: 'skip', reason: 'had-limit' };
  if (probe.truncation.truncated === true) return { kind: 'skip', reason: 'already-truncated' };

  const { totalLines, totalBytes } = probe.truncation;
  if (totalLines === undefined && totalBytes === undefined) {
    return { kind: 'skip', reason: 'unknown-size' };
  }

  const minLines = opts.minLines ?? DEFAULT_MIN_LINES;
  const minBytes = opts.minBytes ?? DEFAULT_MIN_BYTES;

  if (typeof totalLines === 'number' && totalLines >= minLines) {
    return { kind: 'nudge', reason: 'lines', nudge: formatNudge(probe, 'lines', opts.marker) };
  }
  if (typeof totalBytes === 'number' && totalBytes >= minBytes) {
    return { kind: 'nudge', reason: 'bytes', nudge: formatNudge(probe, 'bytes', opts.marker) };
  }
  return { kind: 'skip', reason: 'small-file' };
}

// Exported for tests.
export { formatNudge };
