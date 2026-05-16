/**
 * Pure helpers for the read-reread-detector extension.
 *
 * No pi / fs imports - the extension layer stats files and provides
 * signatures. This module just keeps the bookkeeping and builds the
 * nudge text, so it's testable with synthetic inputs under `vitest`.
 *
 * ## What the extension does
 *
 * Small self-hosted models routinely `read` the same file 3–5 times
 * per task: once to orient themselves, again because they forgot what
 * line N was, again when a related follow-up prompt references it, and
 * again after a tool error. `loop-breaker` catches IDENTICAL repeats
 * (same `(toolName, input)` hash 3× in a row); this extension catches
 * the broader "same file, same contents, different offset / limit,
 * spread across turns" case.
 *
 * Mechanism: for every successful `read` tool call, record the file's
 * absolute path and a content signature (mtime + size). On any
 * subsequent read of the same `(path, sig)`, append a nudge to the
 * tool result reminding the model that it already has this file's
 * content and pointing it at `scratchpad` for carry-over.
 *
 * The signature gates false positives: if the file was genuinely
 * modified between reads (build step, write via `edit`, external
 * change) the signature differs and we stay quiet. If the model reads
 * different slices of the same file we still nudge - that's the very
 * case we want to catch.
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

/** Previous read we remember for nudging. */
export interface ReadRecord {
  sig: FileSignature;
  /** 1-based offset passed to the earlier read (undefined = from top). */
  offset: number | undefined;
  /** limit passed to the earlier read (undefined = open-ended). */
  limit: number | undefined;
  /** Session-turn counter at time of read - monotonic per session. */
  turn: number;
}

/** Input for `checkReread` - new read's full signal. */
export interface RereadProbe {
  sig: FileSignature;
  offset: number | undefined;
  limit: number | undefined;
  turn: number;
}

/** Outcome of checking whether a new read is a re-read. */
export type RereadDecision =
  | { kind: 'first-time' }
  | { kind: 'same-slice'; previous: ReadRecord }
  | { kind: 'different-slice'; previous: ReadRecord }
  | { kind: 'changed'; previous: ReadRecord };

/**
 * In-memory cache of the most recent read per absolute path. Callers
 * should use one instance per session and reset on `session_start`.
 *
 * Bounded by `maxEntries` (default 256) using plain insertion-order
 * eviction - we don't need exact LRU; a read-heavy session that touches
 * thousands of files won't benefit from tracking the deep tail anyway.
 */
export class ReadHistory {
  private readonly records = new Map<string, ReadRecord>();
  constructor(private readonly maxEntries = 256) {}

  /** Remove all records - intended for session_start / session_shutdown. */
  clear(): void {
    this.records.clear();
  }

  /** Return the record we have for `path`, if any. */
  get(path: string): ReadRecord | undefined {
    return this.records.get(path);
  }

  /** Classify a new read against history WITHOUT mutating state. */
  classify(probe: RereadProbe): RereadDecision {
    const previous = this.records.get(probe.sig.path);
    if (!previous) return { kind: 'first-time' };
    if (previous.sig.mtimeMs !== probe.sig.mtimeMs || previous.sig.size !== probe.sig.size) {
      return { kind: 'changed', previous };
    }
    const sameOffset = (previous.offset ?? 1) === (probe.offset ?? 1);
    const sameLimit = previous.limit === probe.limit;
    if (sameOffset && sameLimit) return { kind: 'same-slice', previous };
    return { kind: 'different-slice', previous };
  }

  /** Record (or overwrite) the latest read for `path`. */
  record(probe: RereadProbe): void {
    this.records.set(probe.sig.path, {
      sig: { ...probe.sig },
      offset: probe.offset,
      limit: probe.limit,
      turn: probe.turn,
    });
    this.evictIfNeeded();
  }

  /** Exposed for tests. */
  size(): number {
    return this.records.size;
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
// Nudge formatting
// ──────────────────────────────────────────────────────────────────────

const NUDGE_MARKER = '⟲ [pi-read-reread-detector]';

export interface FormatNudgeOptions {
  /** Display-friendly path (pretty-relative is fine). */
  displayPath: string;
  /** How the new read compared to history. */
  decision: Extract<RereadDecision, { kind: 'same-slice' | 'different-slice' }>;
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

/**
 * Build the one-paragraph nudge appended to the re-read's tool result.
 * Distinguishes "you read exactly this slice before" (sharp) from "you
 * read this file before, different window" (softer) because the action
 * the model should take differs:
 *
 *   - same-slice   → use your memory / scratchpad, don't repeat this.
 *   - different-slice → if you're iterating, note what you learn this
 *                       time; otherwise consider `rg -n` to find what
 *                       you're looking for directly.
 */
export function formatNudge(opts: FormatNudgeOptions): string {
  const marker = opts.marker ?? NUDGE_MARKER;
  const ago = Math.max(0, opts.currentTurn - opts.decision.previous.turn);
  const turnPhrase = ago === 0 ? 'earlier this turn' : ago === 1 ? 'last turn' : `${ago} turns ago`;
  const prevSlice = describeSlice(opts.decision.previous.offset, opts.decision.previous.limit);
  if (opts.decision.kind === 'same-slice') {
    return [
      `${marker} ${opts.displayPath}`,
      '',
      `You already read this exact slice (${prevSlice}) ${turnPhrase}; the file hasn't changed since.`,
      'Prefer recalling the content from your notes over re-reading. If you lost the details, park them in `scratchpad`',
      'now so you stop paying for the same bytes each turn.',
    ].join('\n');
  }
  return [
    `${marker} ${opts.displayPath}`,
    '',
    `You read this unchanged file ${turnPhrase} (${prevSlice}). If you're iterating through it, capture what you find`,
    "in `scratchpad` so the next read doesn't have to start over. If you're hunting for a specific symbol, try",
    '`rg -n "<pattern>" <path>` instead - it returns only the matching lines.',
  ].join('\n');
}

export { NUDGE_MARKER };
