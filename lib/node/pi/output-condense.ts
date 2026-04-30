/**
 * Pure helpers for the tool-output-condenser extension.
 *
 * No pi imports — testable under plain `node --test`.
 *
 * Pi's built-in bash / rg / grep tools already truncate at 50KB / 2000
 * lines, which is sensible for "don't explode the process" but fairly
 * loose for "don't burn session tokens on a single output". The
 * condenser applies a tighter head+tail budget on top of that: it
 * assumes the MOST useful context in a command's output is concentrated
 * at the very top (what command ran, first errors, first test failures)
 * AND the very bottom (exit banner, summary line, test totals, final
 * error message), with a "this is filler" middle that costs tokens for
 * little payoff.
 *
 * The condense strategy:
 *
 *   - Count lines and bytes in the input.
 *   - If BOTH are under the configured maxLines / maxBytes caps, return
 *     the input unchanged (truncated = false).
 *   - Otherwise, pick `headLines` from the top + `tailLines` from the
 *     bottom, separated by a single `… [N lines / MKB omitted] …` marker
 *     line. The head/tail windows are also byte-capped so a single huge
 *     line in the head doesn't defeat the whole point of condensing.
 *
 * Byte budget reasoning:
 *
 *   - The default head and tail caps each take half the `maxBytes`
 *     budget minus the marker's share, so the condensed output is
 *     bounded above by roughly `maxBytes`.
 *   - If only the byte budget is exceeded but line count fits, we still
 *     condense — a 400-line single-line log of 4KB per line is just as
 *     wasteful as 2000 normal lines.
 *   - If only the line budget is exceeded but bytes fit, we still
 *     condense so the model isn't staring at 800 lines of boilerplate.
 *
 * The condense is LOSSY but a "Full output saved to …" breadcrumb is
 * the caller's responsibility — the extension handles the temp-file I/O
 * so this module stays pure.
 */

export interface CondenseOptions {
  /** Byte cap on the final condensed output. Default 12 KB. */
  maxBytes?: number;
  /** Line cap on the final condensed output. Default 400. */
  maxLines?: number;
  /** Lines to keep from the head. Default 80. */
  headLines?: number;
  /** Lines to keep from the tail. Default 80. */
  tailLines?: number;
}

export interface CondenseResult {
  text: string;
  truncated: boolean;
  /** Total input bytes (UTF-8). */
  originalBytes: number;
  /** Total input lines. */
  originalLines: number;
  /** Final condensed output bytes. */
  outputBytes: number;
  /** Final condensed output lines. */
  outputLines: number;
}

const BYTE_ENCODER = new TextEncoder();

function byteLen(s: string): number {
  return BYTE_ENCODER.encode(s).length;
}

/**
 * Split text into lines without losing the trailing empty line when the
 * input ends in a newline. We keep the split cheap because very long
 * outputs (multi-MB) pass through here.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

/**
 * Take the last N whole lines from a string, capped at `maxBytes`. We
 * trim head-first to preserve the end of the output, which is where
 * final-error / test-summary lines live.
 */
function takeTail(lines: readonly string[], n: number, maxBytes: number): string[] {
  const sliced = lines.slice(Math.max(0, lines.length - n));
  let used = 0;
  // Build from the END back so the last line is guaranteed to fit.
  const out: string[] = [];
  for (let i = sliced.length - 1; i >= 0; i--) {
    const ln = sliced[i];
    const cost = byteLen(ln) + 1; // +1 for the joining '\n'
    if (out.length > 0 && used + cost > maxBytes) break;
    out.unshift(ln);
    used += cost;
  }
  return out;
}

/**
 * Take the first N whole lines from a string, capped at `maxBytes`.
 * Stops as soon as adding another line would exceed the byte cap, but
 * always keeps at least the first line so banner / invocation info
 * survives.
 */
function takeHead(lines: readonly string[], n: number, maxBytes: number): string[] {
  const sliced = lines.slice(0, n);
  let used = 0;
  const out: string[] = [];
  for (const ln of sliced) {
    const cost = byteLen(ln) + 1;
    if (out.length > 0 && used + cost > maxBytes) break;
    out.push(ln);
    used += cost;
  }
  return out;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * Condense `text` to a head+tail summary when it exceeds the budget.
 * See module header for the strategy.
 *
 * Always returns a well-formed `CondenseResult`; never throws. An empty
 * input produces an empty result with `truncated=false`.
 */
export function condense(text: string, opts: CondenseOptions = {}): CondenseResult {
  const maxBytes = Math.max(512, opts.maxBytes ?? 12 * 1024);
  const maxLines = Math.max(20, opts.maxLines ?? 400);
  const headLines = Math.max(1, opts.headLines ?? 80);
  const tailLines = Math.max(1, opts.tailLines ?? 80);

  const lines = splitLines(text);
  const originalBytes = byteLen(text);
  const originalLines = lines.length;

  if (originalBytes <= maxBytes && originalLines <= maxLines) {
    return {
      text,
      truncated: false,
      originalBytes,
      originalLines,
      outputBytes: originalBytes,
      outputLines: originalLines,
    };
  }

  // Budget the head / tail windows to split the byte cap roughly evenly,
  // reserving ~256 bytes for the marker line. If the cap is pathological
  // (< 512 bytes) we clamp to at least 1 byte per window so
  // takeHead/takeTail never receive 0.
  const markerReserve = 256;
  const halfBytes = Math.max(256, Math.floor((maxBytes - markerReserve) / 2));

  const head = takeHead(lines, headLines, halfBytes);
  const tail = takeTail(lines, tailLines, halfBytes);

  // Avoid overlap: if head + tail already include every line (short
  // input with many tiny lines), just glue them and mark untruncated.
  // This happens when headLines + tailLines >= originalLines.
  if (head.length + tail.length >= originalLines) {
    const joined = lines.join('\n');
    const joinedBytes = byteLen(joined);
    if (joinedBytes <= maxBytes) {
      return {
        text: joined,
        truncated: false,
        originalBytes,
        originalLines,
        outputBytes: joinedBytes,
        outputLines: originalLines,
      };
    }
    // Falls through: large bytes but few lines — still need to condense.
  }

  const omittedLines = Math.max(0, originalLines - head.length - tail.length);
  const omittedBytes = Math.max(0, originalBytes - byteLen(head.join('\n')) - byteLen(tail.join('\n')));

  const marker = `… [${omittedLines} line(s), ~${formatSize(omittedBytes)} omitted] …`;
  const condensedText = [...head, marker, ...tail].join('\n');
  const condensedBytes = byteLen(condensedText);
  const condensedLines = head.length + 1 + tail.length;

  return {
    text: condensedText,
    truncated: true,
    originalBytes,
    originalLines,
    outputBytes: condensedBytes,
    outputLines: condensedLines,
  };
}

/**
 * Parse a comma-separated list of tool names out of an env var.
 * Lowercases and trims each entry; returns a Set for O(1) membership
 * checks.
 */
export function parseToolList(value: string | undefined, fallback: readonly string[]): Set<string> {
  const base = (value ?? '').trim();
  if (!base) return new Set(fallback.map((s) => s.toLowerCase()));
  return new Set(
    base
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}
