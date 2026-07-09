/**
 * Pure line-diff counting for the review summary: how many lines would be
 * added / removed to take a file from its CURRENT disk content to the
 * restore TARGET content. Only the `+adds` / `-dels` counts are computed
 * here (filenames + counts is all the summary shows); the colorized
 * line-level diff is rendered in the shell via pi's `renderDiff`.
 *
 * Counting strategy:
 *   - whole-file add (current absent) → adds = target line count, dels = 0.
 *   - whole-file delete (target absent) → dels = current line count, adds = 0.
 *   - otherwise trim the common leading/trailing lines (cheap, and usually
 *     collapses the work to a small middle), then count via an LCS on the
 *     middle. For a pathologically large middle, fall back to a multiset
 *     line-difference count so we never run an O(n·m) table on a huge file.
 *
 * No pi imports.
 */

/** Number of lines added / removed going current → target. */
export interface DiffCounts {
  adds: number;
  dels: number;
}

/** Above this many lines on either side, skip LCS and use the multiset count. */
const LCS_LINE_CAP = 2000;

function splitLines(text: string): string[] {
  // An empty string is zero lines (not one empty line) so an empty file
  // doesn't report a spurious +1/-1.
  if (text.length === 0) return [];
  const lines = text.split('\n');
  // A single trailing newline terminates the last line rather than starting a
  // new empty one, so "a\nb\n" is two lines, not three. Drop the spurious
  // final '' the split produces or counts are off by one for any file that
  // ends in a newline (the common case).
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Length of the longest common subsequence of two line arrays. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const n = a.length;
  const m = b.length;
  // Two-row rolling DP - O(n·m) time, O(m) space.
  let prev = Array.from<number>({ length: m + 1 }).fill(0);
  let curr = Array.from<number>({ length: m + 1 }).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[m];
}

/**
 * Multiset fallback: lines present in `target` but not matched by a `current`
 * occurrence are adds; the reverse are dels. Over-counts moved lines vs a
 * true LCS but is bounded and only used for very large middles where exact
 * counts don't change the human takeaway ("this file changed a lot").
 */
function multisetCounts(current: readonly string[], target: readonly string[]): DiffCounts {
  const counts = new Map<string, number>();
  for (const line of current) counts.set(line, (counts.get(line) ?? 0) + 1);
  let adds = 0;
  for (const line of target) {
    const c = counts.get(line) ?? 0;
    if (c > 0) counts.set(line, c - 1);
    else adds++;
  }
  let dels = 0;
  for (const remaining of counts.values()) dels += remaining;
  return { adds, dels };
}

/**
 * Count the line adds / dels going from `current` to `target`. `null` on
 * either side means the file is absent at that end (whole-file add/delete).
 */
export function countDiff(current: string | null, target: string | null): DiffCounts {
  if (current === null && target === null) return { adds: 0, dels: 0 };
  if (current === null) return { adds: splitLines(target ?? '').length, dels: 0 };
  if (target === null) return { adds: 0, dels: splitLines(current).length };

  if (current === target) return { adds: 0, dels: 0 };

  const a = splitLines(current);
  const b = splitLines(target);

  // Trim common prefix.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  // Trim common suffix.
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) return { adds: 0, dels: 0 };

  if (midA.length > LCS_LINE_CAP || midB.length > LCS_LINE_CAP) {
    return multisetCounts(midA, midB);
  }

  const common = lcsLength(midA, midB);
  return { adds: midB.length - common, dels: midA.length - common };
}

// ──────────────────────────────────────────────────────────────────────
// Unified diff text (for the detail view, fed to pi's `renderDiff`)
// ──────────────────────────────────────────────────────────────────────

/** One emitted diff line, before it's serialized for `renderDiff`. */
export interface DiffLine {
  prefix: ' ' | '-' | '+';
  /** Line number in the current/old file (context + removed). */
  oldNo?: number;
  /** Line number in the target/new file (context + added). */
  newNo?: number;
  text: string;
}

/** Above this many lines in the changed middle, emit a degenerate block diff. */
const DIFF_LINE_CAP = 2000;
const DEFAULT_CONTEXT = 3;

/** LCS backtrace over two line arrays → ordered context/removed/added ops. */
function diffMiddle(a: readonly string[], b: readonly string[], oldBase: number, newBase: number): DiffLine[] {
  // Degenerate (cap exceeded): all removed then all added, no LCS table.
  if (a.length > DIFF_LINE_CAP || b.length > DIFF_LINE_CAP) {
    const out: DiffLine[] = [];
    a.forEach((text, i) => out.push({ prefix: '-', oldNo: oldBase + i, text }));
    b.forEach((text, i) => out.push({ prefix: '+', newNo: newBase + i, text }));
    return out;
  }

  const n = a.length;
  const m = b.length;
  // Full DP table so we can backtrack the actual alignment.
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from<number>({ length: m + 1 }).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = n;
  let j = m;
  const rev: DiffLine[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      rev.push({ prefix: ' ', oldNo: oldBase + i - 1, newNo: newBase + j - 1, text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rev.push({ prefix: '+', newNo: newBase + j - 1, text: b[j - 1] });
      j--;
    } else {
      rev.push({ prefix: '-', oldNo: oldBase + i - 1, text: a[i - 1] });
      i--;
    }
  }
  for (let k = rev.length - 1; k >= 0; k--) out.push(rev[k]);
  return out;
}

/**
 * Build a unified-diff line list going from `current` to `target`, with up to
 * `context` unchanged lines kept around each change (the rest of the matching
 * head/tail is elided). `null` on a side means the file is absent there
 * (whole-file add / delete). Pure; the shell serializes + colorizes it.
 */
export function unifiedDiffLines(
  current: string | null,
  target: string | null,
  context: number = DEFAULT_CONTEXT,
): DiffLine[] {
  const a = current === null ? [] : splitLines(current);
  const b = target === null ? [] : splitLines(target);

  // Trim common prefix / suffix so the LCS table only spans the changed middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midOps = diffMiddle(a.slice(start, endA), b.slice(start, endB), start, start);
  if (midOps.length === 0) return []; // identical

  const out: DiffLine[] = [];
  // Leading context: last `context` lines of the common prefix.
  const leadFrom = Math.max(0, start - context);
  if (leadFrom > 0) out.push({ prefix: ' ', text: '@@' } as DiffLine);
  for (let k = leadFrom; k < start; k++) out.push({ prefix: ' ', oldNo: k, newNo: k, text: a[k] });

  out.push(...midOps);

  // Trailing context: first `context` lines after the changed middle.
  const tailEnd = Math.min(a.length, endA + context);
  for (let k = endA; k < tailEnd; k++) {
    out.push({ prefix: ' ', oldNo: k, newNo: endB + (k - endA), text: a[k] });
  }
  return out;
}

/**
 * Serialize {@link DiffLine}s into the text shape pi's `renderDiff` parses
 * (`"<prefix><lineNo> <content>"`; a bare `@@` line renders as a context
 * separator). 1-based line numbers for human display.
 */
export function formatDiffForRender(lines: readonly DiffLine[]): string {
  return lines
    .map((l) => {
      if (l.text === '@@' && l.prefix === ' ' && l.oldNo === undefined && l.newNo === undefined) return '@@';
      const no = l.prefix === '+' ? l.newNo : l.oldNo;
      const num = no === undefined ? '' : String(no + 1);
      return `${l.prefix}${num} ${l.text}`;
    })
    .join('\n');
}
