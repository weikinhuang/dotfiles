/**
 * Pure helpers for the read-reread-detector extension.
 *
 * No pi / fs imports - the extension layer stats files, resolves the
 * line range each `read` actually returned, and provides signatures.
 * This module just keeps the bookkeeping and builds the nudge text, so
 * it's testable with synthetic inputs under `vitest`.
 *
 * ## What the extension does
 *
 * Small self-hosted models routinely `read` the same file 3–5 times
 * per task: once to orient themselves, again because they forgot what
 * line N was, again when a related follow-up prompt references it, and
 * again after a tool error. `loop-breaker` catches IDENTICAL repeats
 * (same `(toolName, input)` hash 3× in a row); this extension catches
 * the broader "same file, same contents, overlapping lines, spread
 * across turns" case.
 *
 * Mechanism: for every successful `read` tool call, record the file's
 * absolute path, a content signature (mtime + size), and the line
 * interval the read actually returned. Coverage per `(path, sig)` is a
 * small merged set of 1-based inclusive line intervals. A new read of
 * the same unchanged file is classified against that coverage:
 *
 *   - **continuation** - starts right after a covered interval (the
 *     `read` tool's own "Use offset=N to continue" hint) → silent.
 *   - **disjoint** - touches no covered line → silent (paging).
 *   - **partial-overlap** - overlaps, but below the threshold → silent.
 *   - **overlap** - at least `overlapThreshold` (default 50%) of the
 *     returned lines were already covered → nudge naming the lines.
 *   - **same-slice** - fully covered and the same request (or range) as
 *     the previous read → sharper nudge.
 *
 * The signature gates false positives: if the file was genuinely
 * modified between reads (build step, write via `edit`, external
 * change) the signature differs, coverage resets, and we stay quiet.
 */

/** Signature identifying a specific version of a file's contents. */
export interface FileSignature {
  /** Absolute path (normalized). */
  path: string;
  /** Last-modified time in ms since epoch. */
  mtimeMs: number;
  /** Size in bytes. */
  size: number;
}

/** 1-based inclusive line range. `end` may be `Infinity` (= to EOF, unknown length). */
export interface LineRange {
  start: number;
  end: number;
}

/** Most recent read of a path, kept for nudge wording. */
export interface ReadRecord {
  sig: FileSignature;
  /** 1-based offset passed to the read (undefined = from top). */
  offset: number | undefined;
  /** limit passed to the read (undefined = open-ended). */
  limit: number | undefined;
  /** Line range the read actually returned. */
  range: LineRange;
  /** Session-turn counter at time of read - monotonic per session. */
  turn: number;
}

/** A covered interval plus recency bookkeeping. */
export interface CoverageInterval extends LineRange {
  /** Latest turn that touched any line in this interval. */
  turn: number;
  /** Monotonic insertion counter used for least-recent eviction. */
  seq: number;
}

/** Everything we remember about one path. */
export interface FileCoverage {
  sig: FileSignature;
  /** Sorted, non-overlapping, non-adjacent intervals already read. */
  intervals: CoverageInterval[];
  /** The latest read of this path. */
  last: ReadRecord;
  /** Turn of the latest read (mirrors `last.turn`). */
  turn: number;
}

/** Input for `classify` / `record` - a new read's full signal. */
export interface RereadProbe {
  sig: FileSignature;
  offset: number | undefined;
  limit: number | undefined;
  turn: number;
  /**
   * Line range the read actually returned. When omitted it is derived
   * from offset/limit (`limit` undefined → open-ended to EOF).
   */
  range?: LineRange;
}

interface NudgeDetail {
  previous: ReadRecord;
  /** Portions of the new read that were already covered. */
  overlap: LineRange[];
  /** Covered fraction of the new read's lines (0..1). */
  ratio: number;
  /** Most recent turn among the overlapping coverage. */
  overlapTurn: number;
}

/** Outcome of checking whether a new read is a re-read. */
export type RereadDecision =
  | { kind: 'first-time' }
  | { kind: 'changed'; previous: ReadRecord }
  | { kind: 'continuation'; previous: ReadRecord }
  | { kind: 'disjoint'; previous: ReadRecord }
  | ({ kind: 'partial-overlap' } & NudgeDetail)
  | ({ kind: 'overlap' } & NudgeDetail)
  | ({ kind: 'same-slice' } & NudgeDetail);

/** Decisions that append a nudge to the tool result. */
export type NudgeDecision = Extract<RereadDecision, { kind: 'same-slice' | 'overlap' }>;

export function isNudgeDecision(d: RereadDecision): d is NudgeDecision {
  return d.kind === 'same-slice' || d.kind === 'overlap';
}

export interface ReadHistoryOptions {
  /** Cap on intervals tracked per file (default 32; least-recent evicted). */
  maxIntervals?: number;
  /** Covered fraction at or above which a read nudges (default 0.5). */
  overlapThreshold?: number;
}

const DEFAULT_MAX_INTERVALS = 32;
const DEFAULT_OVERLAP_THRESHOLD = 0.5;

/** 1-based start line; the read tool treats a missing / zero / negative offset as line 1. */
function normalizeStart(offset: number | undefined): number {
  return Math.max(1, Math.floor(offset ?? 1));
}

/** Range a probe covers: explicit `range`, else derived from offset/limit. */
export function probeRange(probe: Pick<RereadProbe, 'offset' | 'limit' | 'range'>): LineRange {
  if (probe.range) return probe.range;
  const start = normalizeStart(probe.offset);
  return { start, end: probe.limit === undefined ? Infinity : start + Math.max(1, probe.limit) - 1 };
}

function rangeLength(r: LineRange): number {
  return r.end - r.start + 1;
}

function intersect(a: LineRange, b: LineRange): LineRange | undefined {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start <= end ? { start, end } : undefined;
}

function sameRequest(previous: ReadRecord, probe: RereadProbe): boolean {
  return normalizeStart(previous.offset) === normalizeStart(probe.offset) && previous.limit === probe.limit;
}

function sameRange(a: LineRange, b: LineRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/** Insert `next` into sorted `intervals`, merging overlapping or adjacent ones. */
function mergeInterval(intervals: readonly CoverageInterval[], next: CoverageInterval): CoverageInterval[] {
  const out: CoverageInterval[] = [];
  let cur = { ...next };
  for (const iv of intervals) {
    if (iv.end + 1 < cur.start || cur.end + 1 < iv.start) {
      out.push(iv);
      continue;
    }
    cur = {
      start: Math.min(iv.start, cur.start),
      end: Math.max(iv.end, cur.end),
      turn: Math.max(iv.turn, cur.turn),
      seq: Math.max(iv.seq, cur.seq),
    };
  }
  out.push(cur);
  return out.sort((a, b) => a.start - b.start);
}

/**
 * In-memory cache of read coverage per absolute path. Callers should
 * use one instance per session and reset on `session_start`.
 *
 * Bounded by `maxEntries` (default 256) using plain insertion-order
 * eviction - we don't need exact LRU; a read-heavy session that touches
 * thousands of files won't benefit from tracking the deep tail anyway.
 * Each file keeps at most `maxIntervals` intervals; past the cap the
 * least-recently-read interval is dropped, which can only under-report
 * coverage (a missed nudge), never invent one.
 */
export class ReadHistory {
  private readonly records = new Map<string, FileCoverage>();
  private readonly maxIntervals: number;
  private readonly overlapThreshold: number;
  private seq = 0;

  constructor(
    private readonly maxEntries = 256,
    opts: ReadHistoryOptions = {},
  ) {
    this.maxIntervals = Math.max(1, opts.maxIntervals ?? DEFAULT_MAX_INTERVALS);
    this.overlapThreshold = opts.overlapThreshold ?? DEFAULT_OVERLAP_THRESHOLD;
  }

  /** Remove all records - intended for session_start / session_shutdown. */
  clear(): void {
    this.records.clear();
  }

  /** Return the coverage we have for `path`, if any. */
  get(path: string): FileCoverage | undefined {
    return this.records.get(path);
  }

  /** Classify a new read against history WITHOUT mutating state. */
  classify(probe: RereadProbe): RereadDecision {
    const entry = this.records.get(probe.sig.path);
    if (!entry) return { kind: 'first-time' };
    const previous = entry.last;
    if (entry.sig.mtimeMs !== probe.sig.mtimeMs || entry.sig.size !== probe.sig.size) {
      return { kind: 'changed', previous };
    }

    const range = probeRange(probe);
    // Paging per the tool's own "Use offset=N to continue" hint never nudges,
    // even if the continued window runs into a later covered interval.
    if (entry.intervals.some((iv) => iv.end === range.start - 1)) {
      return { kind: 'continuation', previous };
    }
    const overlapping = entry.intervals.filter((iv) => intersect(iv, range));
    if (overlapping.length === 0) return { kind: 'disjoint', previous };

    const overlap = overlapping.map((iv) => intersect(iv, range)).filter((r): r is LineRange => r !== undefined);
    const covered = overlap.reduce((n, r) => n + rangeLength(r), 0);
    const total = rangeLength(range);
    const fullyCovered = overlap.length === 1 && overlap[0].start === range.start && overlap[0].end === range.end;
    const ratio = fullyCovered ? 1 : Number.isFinite(total) ? covered / total : 0;
    const overlapTurn = Math.max(...overlapping.map((iv) => iv.turn));
    const detail: NudgeDetail = { previous, overlap, ratio, overlapTurn };

    if (fullyCovered && (sameRequest(previous, probe) || sameRange(previous.range, range))) {
      return { kind: 'same-slice', ...detail };
    }
    if (ratio >= this.overlapThreshold) return { kind: 'overlap', ...detail };
    return { kind: 'partial-overlap', ...detail };
  }

  /** Record a read: reset coverage on signature change, else merge the new range. */
  record(probe: RereadProbe): void {
    const range = probeRange(probe);
    const last: ReadRecord = {
      sig: { ...probe.sig },
      offset: probe.offset,
      limit: probe.limit,
      range: { ...range },
      turn: probe.turn,
    };
    const existing = this.records.get(probe.sig.path);
    const sameSig =
      existing !== undefined && existing.sig.mtimeMs === probe.sig.mtimeMs && existing.sig.size === probe.sig.size;
    const prior = sameSig ? existing.intervals : [];
    const intervals = this.capIntervals(mergeInterval(prior, { ...range, turn: probe.turn, seq: ++this.seq }));
    this.records.set(probe.sig.path, { sig: { ...probe.sig }, intervals, last, turn: probe.turn });
    this.evictIfNeeded();
  }

  /** Exposed for tests. */
  size(): number {
    return this.records.size;
  }

  private capIntervals(intervals: CoverageInterval[]): CoverageInterval[] {
    if (intervals.length <= this.maxIntervals) return intervals;
    const keep = new Set(
      [...intervals]
        .sort((a, b) => b.seq - a.seq)
        .slice(0, this.maxIntervals)
        .map((iv) => iv.seq),
    );
    return intervals.filter((iv) => keep.has(iv.seq));
  }

  private evictIfNeeded(): void {
    if (this.records.size <= this.maxEntries) return;
    // Evict oldest entries by insertion order until we're back under the cap.
    const excess = this.records.size - this.maxEntries;
    let removed = 0;
    for (const key of this.records.keys()) {
      if (removed >= excess) break;
      this.records.delete(key);
      removed++;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Returned-range resolution
// ──────────────────────────────────────────────────────────────────────

/** Subset of the read tool's `details.truncation` we rely on. */
export interface ReadTruncationLike {
  truncated: boolean;
  outputLines: number;
  firstLineExceedsLimit: boolean;
}

export interface ReadResultShape {
  offset: number | undefined;
  limit: number | undefined;
  /** First text part of the read result (the file content plus any footer). */
  text: string | undefined;
  /** True when the result carried an image part (image reads have no lines). */
  isImage?: boolean;
  /** `details.truncation` from the read tool, if present. */
  truncation?: ReadTruncationLike;
}

/** The read tool's continuation footer, always the last line of the text part. */
const CONTINUE_FOOTER = /Use offset=(\d+) to continue\.\]\s*$/;

/**
 * Resolve the 1-based line range a `read` actually returned, so an
 * open-ended or truncated read records what is in context rather than
 * "to EOF". Returns `undefined` when no lines were returned (the first
 * line alone exceeded the byte limit).
 *
 * Priority: `details.truncation.outputLines` → the "Use offset=N to
 * continue" footer → counting returned lines → offset/limit.
 */
export function resolveReadRange(r: ReadResultShape): LineRange | undefined {
  if (r.isImage) return { start: 1, end: 1 };
  const start = normalizeStart(r.offset);
  const t = r.truncation;
  if (t?.firstLineExceedsLimit) return undefined;
  if (t?.truncated && t.outputLines > 0) return { start, end: start + t.outputLines - 1 };
  if (r.text !== undefined) {
    const footer = CONTINUE_FOOTER.exec(r.text);
    if (footer) {
      const next = Number(footer[1]);
      if (next > start) return { start, end: next - 1 };
    }
    return { start, end: start + r.text.split('\n').length - 1 };
  }
  return probeRange({ offset: r.offset, limit: r.limit });
}

// ──────────────────────────────────────────────────────────────────────
// Nudge formatting
// ──────────────────────────────────────────────────────────────────────

const NUDGE_MARKER = '⟲ [pi-read-reread-detector]';

export interface FormatNudgeOptions {
  /** Display-friendly path (pretty-relative is fine). */
  displayPath: string;
  /** How the new read compared to history. */
  decision: NudgeDecision;
  /** Current turn - used to state "already read N turns ago". */
  currentTurn: number;
  /** Marker (defaults to NUDGE_MARKER). */
  marker?: string;
}

function describeSlice(offset: number | undefined, limit: number | undefined): string {
  if (offset === undefined && limit === undefined) return 'full file';
  if (limit === undefined) return `offset=${offset}`;
  if (offset === undefined) return `limit=${limit}`;
  return `offset=${offset}, limit=${limit}`;
}

/** `lines 400-960` / `lines 1-20, 40-60` / `line 7`. */
export function describeLines(ranges: readonly LineRange[]): string {
  const parts = ranges.map((r) => {
    if (r.start === r.end) return `${r.start}`;
    return `${r.start}-${Number.isFinite(r.end) ? r.end : 'EOF'}`;
  });
  const single = ranges.length === 1 && ranges[0].start === ranges[0].end;
  return `${single ? 'line' : 'lines'} ${parts.join(', ')}`;
}

/**
 * Build the one-paragraph nudge appended to the re-read's tool result.
 * Distinguishes "you read exactly this slice before" (sharp) from "most
 * of these lines are already in context" (softer) because the action
 * the model should take differs:
 *
 *   - same-slice → use your memory / scratchpad, don't repeat this.
 *   - overlap    → if you're iterating, note what you learn this time;
 *                  otherwise consider `rg -n` to find what you're
 *                  looking for directly.
 */
export function formatNudge(opts: FormatNudgeOptions): string {
  const marker = opts.marker ?? NUDGE_MARKER;
  const ago = Math.max(0, opts.currentTurn - opts.decision.overlapTurn);
  const turnPhrase = ago === 0 ? 'earlier this turn' : ago === 1 ? 'last turn' : `${ago} turns ago`;
  const covered = `${describeLines(opts.decision.overlap)} already in context`;
  if (opts.decision.kind === 'same-slice') {
    const prevSlice = describeSlice(opts.decision.previous.offset, opts.decision.previous.limit);
    return [
      `${marker} ${opts.displayPath}`,
      '',
      `You already read this exact slice (${prevSlice}; ${covered}) ${turnPhrase}; the file hasn't changed since.`,
      'Prefer recalling the content from your notes over re-reading. If you lost the details, park them in `scratchpad`',
      'now so you stop paying for the same bytes each turn.',
    ].join('\n');
  }
  return [
    `${marker} ${opts.displayPath}`,
    '',
    `You read this unchanged file ${turnPhrase} (${covered}). If you're iterating through it, capture what you find`,
    "in `scratchpad` so the next read doesn't have to start over. If you're hunting for a specific symbol, try",
    '`rg -n "<pattern>" <path>` instead - it returns only the matching lines.',
  ].join('\n');
}

export { NUDGE_MARKER };
