/**
 * Bounded byte-oriented ring buffer used by bg-bash to hold each job's
 * stdout and stderr streams in memory. Paired with an on-disk log file
 * for anything that no longer fits.
 *
 * Design goals:
 *
 *   - Fixed byte cap (not line cap). Binary or very long-line output
 *     shouldn't blow memory, and "100 lines" is a meaningless unit for
 *     e.g. a minified JS build log.
 *   - O(1) append. Eviction drops whole chunks from the front, not
 *     byte-by-byte.
 *   - Resumable reads. Callers ask with an opaque `sinceCursor` and the
 *     buffer returns the next slice plus a fresh cursor. If the cursor
 *     has already been evicted, the response flags `droppedBefore` so
 *     the LLM knows the stream is lossy and can go to the on-disk log.
 *   - Line-aware reads. `tailLines` returns the last N newline-delimited
 *     lines without the caller having to count bytes. Unterminated
 *     trailing content is returned as the last line.
 *   - `grep` helper that filters by regex on a line basis.
 *
 * The buffer only stores UTF-8 strings (not `Buffer`). Streams are decoded
 * with a `TextDecoder` in streaming mode upstream, so each `append` sees
 * validated UTF-8.
 *
 * No pi imports — testable under `vitest`.
 */

import { BYTE_ENCODER, byteLen } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// UTF-8 byte-window helpers. Module-private, but declared above the
// class so eslint's `no-use-before-define` is satisfied.
// ──────────────────────────────────────────────────────────────────────

/**
 * Return the suffix of `text` whose UTF-8 encoding is at most `maxBytes`
 * bytes. If the cut would land mid-multi-byte-codepoint, we advance
 * forward to the next codepoint boundary so the returned string is
 * always valid UTF-8 (at the cost of returning slightly fewer bytes).
 */
function sliceUtf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = BYTE_ENCODER.encode(text);
  if (bytes.length <= maxBytes) return text;
  const startByte = bytes.length - maxBytes;
  // UTF-8 continuation bytes are 10xxxxxx (0x80..0xBF). Advance until
  // we're on a start byte.
  let i = startByte;
  while (i < bytes.length && (bytes[i] & 0xc0) === 0x80) i++;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(i));
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}

/**
 * Return the index of the `n`-th `\n` counting from the END of `s`, or
 * -1 when `s` has fewer than `n` newlines. The result is an index of
 * the newline itself; callers typically slice from `result + 1` to get
 * the text after it.
 */
function findNthNewlineFromEnd(s: string, n: number): number {
  let seen = 0;
  // If the string ends in `\n`, that terminator belongs to the LAST
  // line of content (e.g. `"a\nb\n"` has two lines "a" and "b"). Skip
  // one trailing newline so `tailLines(1)` of `"a\nb\n"` returns `"b\n"`
  // rather than an empty trailing line.
  let endExclusive = s.length;
  if (endExclusive > 0 && s.charCodeAt(endExclusive - 1) === 10) {
    // endExclusive stays the same — we count this `\n` as part of the
    // last line, not as a separator. We just don't treat it as the
    // "first newline from end".
    endExclusive--;
  }
  for (let i = endExclusive - 1; i >= 0; i--) {
    if (s.charCodeAt(i) === 10) {
      seen++;
      if (seen === n) return i;
    }
  }
  return -1;
}

/** Split on `\n`, keeping each line's trailing terminator. */
function splitKeepTerminators(s: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      lines.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) lines.push(s.slice(start));
  return lines;
}

export interface RingBufferOptions {
  /**
   * Maximum bytes kept in memory. Once exceeded, oldest chunks are dropped
   * until the total fits. Default 1 MiB.
   */
  maxBytes?: number;
}

/**
 * Position in the *logical* (unbounded) stream of bytes ever appended.
 * Cursors are monotonically increasing and never re-used. Callers that
 * persist a cursor across turns can resume where they left off (or detect
 * truncation).
 */
export type RingCursor = number;

export interface ReadOptions {
  /**
   * Cursor returned by a previous read. If omitted, reads from the oldest
   * byte still in the buffer.
   */
  sinceCursor?: RingCursor;
  /**
   * Maximum bytes to return. Default unlimited (i.e. all available data
   * from the cursor to the end). Callers should clamp this for the LLM
   * context.
   */
  maxBytes?: number;
}

export interface ReadResult {
  /** UTF-8 text slice. Empty string when there's nothing new. */
  content: string;
  /**
   * Cursor to pass to the next `read` to get only newer data. Always set
   * to the current end-of-stream even when `content` is empty.
   */
  cursor: RingCursor;
  /**
   * True when the requested `sinceCursor` pointed at data already evicted
   * from the ring. `content` then contains everything currently retained
   * (from oldest retained byte to end-of-stream) and the LLM is expected
   * to fall back to the on-disk log for the dropped prefix.
   */
  droppedBefore: boolean;
  /**
   * Running total of bytes ever appended. Equal to the returned `cursor`.
   */
  totalBytes: number;
  /**
   * Running total of bytes evicted from memory. `totalBytes - droppedBytes`
   * is the "bytes currently retained" upper bound.
   */
  droppedBytes: number;
}

interface Chunk {
  /** UTF-8 text payload. Immutable once enqueued. */
  text: string;
  /** UTF-8 byte length of `text`. Cached so eviction is O(1). */
  size: number;
  /** Logical stream offset of the FIRST byte of this chunk. */
  startCursor: RingCursor;
}

/**
 * Ring buffer over a linked-list-like array of chunks. We keep chunks as
 * whole records rather than splitting them, because (a) it keeps append
 * O(1), (b) it preserves the upstream decoder's boundaries which tend to
 * align with writes, and (c) it means `tailLines` can walk chunk tails
 * backwards without re-scanning the whole buffer.
 */
export class RingBuffer {
  private readonly maxBytes: number;
  private chunks: Chunk[] = [];
  private retainedBytes = 0;
  /** Bytes ever appended. Equal to end-of-stream cursor. */
  private total: RingCursor = 0;
  /** Bytes ever evicted from the front. */
  private dropped = 0;

  constructor(opts: RingBufferOptions = {}) {
    const cap = opts.maxBytes ?? 1024 * 1024;
    // Guard against zero or negative caps. A cap of 0 is legal (retain
    // nothing, everything is dropped immediately) but must still produce
    // sane cursors; negative caps are clamped to 0.
    this.maxBytes = Math.max(0, Math.floor(cap));
  }

  append(text: string): void {
    if (!text) return;
    const size = byteLen(text);
    const chunk: Chunk = { text, size, startCursor: this.total };
    this.total += size;

    // If a single append blows past the cap, keep just its tail — we
    // never want to retain more than `maxBytes` bytes, but we also
    // always want to return *something* on the next read even if the
    // caller writes a single 5MB chunk.
    //
    // Use the actual retained byte count (not `size - maxBytes`) to
    // update accounting: `sliceUtf8Suffix` may advance past a
    // continuation byte to keep the tail valid UTF-8, which can drop
    // more bytes than the literal overflow.
    if (size > this.maxBytes) {
      if (this.maxBytes === 0) {
        this.chunks = [];
        this.retainedBytes = 0;
        this.dropped += size;
        return;
      }
      const tail = sliceUtf8Suffix(text, this.maxBytes);
      const keepSize = byteLen(tail);
      const dropSize = size - keepSize;
      this.chunks = keepSize === 0 ? [] : [{ text: tail, size: keepSize, startCursor: chunk.startCursor + dropSize }];
      this.retainedBytes = keepSize;
      this.dropped += dropSize;
      return;
    }

    this.chunks.push(chunk);
    this.retainedBytes += size;
    this.evict();
  }

  /** Evict oldest chunks until the buffer fits under `maxBytes`. */
  private evict(): void {
    while (this.retainedBytes > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0];
      // If this chunk alone still fits and evicting it would go below
      // the cap, we'd rather partial-drop it (to avoid starving the
      // cap). Implementation: slice off the front of `first` exactly
      // enough to bring us under the limit.
      const overflow = this.retainedBytes - this.maxBytes;
      if (first.size > overflow) {
        // `sliceUtf8Suffix` may advance past a continuation byte so the
        // tail is valid UTF-8; the real number of bytes removed is
        // `first.size - keepSize`, which can exceed `overflow` by at
        // most 3 (the longest UTF-8 continuation run).
        const keep = sliceUtf8Suffix(first.text, first.size - overflow);
        const keepSize = byteLen(keep);
        const removed = first.size - keepSize;
        this.chunks[0] = {
          text: keep,
          size: keepSize,
          startCursor: first.startCursor + removed,
        };
        this.retainedBytes -= removed;
        this.dropped += removed;
        // `sliceUtf8Suffix` may have advanced past enough continuation
        // bytes that we're now BELOW the cap — fine, we're done.
        // It may also (rarely) still leave us slightly above the cap
        // if the leading codepoint was very wide; fall through to the
        // loop, which will chop another chunk if one exists.
        if (this.retainedBytes <= this.maxBytes) return;
        continue;
      }
      this.chunks.shift();
      this.retainedBytes -= first.size;
      this.dropped += first.size;
    }
  }

  /**
   * Read all content from (optionally) `sinceCursor` to end-of-stream,
   * optionally capped at `maxBytes` bytes (tail-preserving: we return
   * the most-recent bytes).
   */
  read(opts: ReadOptions = {}): ReadResult {
    const sinceCursor = opts.sinceCursor;
    const retainedStart = this.chunks.length > 0 ? this.chunks[0].startCursor : this.total;
    const droppedBefore = sinceCursor !== undefined && sinceCursor < retainedStart;
    const effectiveStart = droppedBefore || sinceCursor === undefined ? retainedStart : sinceCursor;

    if (this.chunks.length === 0 || effectiveStart >= this.total) {
      return {
        content: '',
        cursor: this.total,
        droppedBefore,
        totalBytes: this.total,
        droppedBytes: this.dropped,
      };
    }

    // Build the concatenated slice from `effectiveStart` to end.
    let content = '';
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.startCursor + chunk.size;
      if (chunkEnd <= effectiveStart) continue;
      if (chunk.startCursor >= effectiveStart) {
        content += chunk.text;
      } else {
        // Partial chunk at the start of the slice.
        const skipBytes = effectiveStart - chunk.startCursor;
        content += sliceUtf8Suffix(chunk.text, chunk.size - skipBytes);
      }
    }

    if (opts.maxBytes !== undefined && opts.maxBytes >= 0 && byteLen(content) > opts.maxBytes) {
      content = sliceUtf8Suffix(content, opts.maxBytes);
    }

    return {
      content,
      cursor: this.total,
      droppedBefore,
      totalBytes: this.total,
      droppedBytes: this.dropped,
    };
  }

  /**
   * Return the last `n` lines currently retained. A line is "text terminated
   * by \n" or the final unterminated segment. Trailing `\n` is preserved
   * verbatim in the returned string when the last retained byte is a
   * newline.
   */
  tailLines(n: number): ReadResult {
    if (n <= 0) {
      return {
        content: '',
        cursor: this.total,
        droppedBefore: false,
        totalBytes: this.total,
        droppedBytes: this.dropped,
      };
    }
    // Walk chunks right-to-left counting newlines.
    let needed = n;
    const pieces: string[] = [];
    let firstIncludedChunkIndex = this.chunks.length;
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const text = this.chunks[i].text;
      pieces.unshift(text);
      firstIncludedChunkIndex = i;
      needed -= countNewlines(text);
      if (needed <= 0) break;
    }

    let content = pieces.join('');
    if (needed <= 0) {
      // We have at least `n` newlines in `content`. Trim the front so we
      // keep exactly the last `n` lines (+ any trailing unterminated
      // content). The final-line (after the last `\n`) is always kept.
      //
      // Strategy: find the (n+1)-th newline from the end and slice from
      // the character after it. If the content doesn't actually have
      // that many newlines (possible when the partial-chunk arithmetic
      // gave us a surplus that didn't exist), keep the whole content.
      const cutBefore = findNthNewlineFromEnd(content, n);
      if (cutBefore >= 0) content = content.slice(cutBefore + 1);
    }

    // Compute the starting cursor for this slice. If we consumed the
    // buffer from the very beginning, droppedBefore may be true for
    // downstream callers — but `tailLines` doesn't take a cursor, so
    // report the current retained start.
    const retainedStart = this.chunks.length > 0 ? this.chunks[0].startCursor : this.total;
    // Rough approximation: when we trimmed within a chunk the cursor
    // moves, but we don't expose it — callers use this purely for
    // display. `cursor` still advances to the end of the stream so
    // later `read({ sinceCursor: r.cursor })` picks up new data.
    void firstIncludedChunkIndex;
    void retainedStart;

    return {
      content,
      cursor: this.total,
      droppedBefore: false,
      totalBytes: this.total,
      droppedBytes: this.dropped,
    };
  }

  /**
   * Return lines (from the current retention window) matching `pattern`,
   * optionally capped to the last `maxMatches`.
   */
  grep(pattern: RegExp, opts: { maxMatches?: number } = {}): string[] {
    const all = this.read().content;
    const lines = splitKeepTerminators(all);
    const matches: string[] = [];
    for (const line of lines) {
      if (pattern.test(line)) matches.push(line);
    }
    if (opts.maxMatches !== undefined && matches.length > opts.maxMatches) {
      return matches.slice(matches.length - opts.maxMatches);
    }
    return matches;
  }

  get byteLengthTotal(): number {
    return this.total;
  }

  get byteLengthDropped(): number {
    return this.dropped;
  }

  get byteLengthRetained(): number {
    return this.retainedBytes;
  }

  /** Snapshot the last <= n bytes as a tail preview string. */
  tailPreview(maxBytes: number): string {
    if (maxBytes <= 0 || this.chunks.length === 0) return '';
    const r = this.read({ maxBytes });
    return r.content;
  }
}
