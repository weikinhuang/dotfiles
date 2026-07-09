/**
 * Stream selection helpers for the bg-bash extension.
 *
 * The extension owns process management and ring-buffer writes; this
 * module owns the stdout/stderr/merged read semantics shared by `logs`,
 * `wait`, and overlay previews.
 */

import { clampBytes } from './bg-bash-format.ts';
import { type ReadOptions, type ReadResult } from './bg-bash-ring.ts';

export type BgBashStreamName = 'stdout' | 'stderr' | 'merged';

export interface BgBashReadableStream {
  read(opts?: ReadOptions): ReadResult;
  readonly byteLengthTotal: number;
  readonly byteLengthDropped: number;
}

export interface BgBashStreamSet {
  stdout: BgBashReadableStream;
  stderr: BgBashReadableStream;
}

/**
 * Join a stdout slice and a stderr slice into the in-memory "merged" view:
 * stdout first, then stderr behind a labeled separator, omitting the
 * separator (and empty side) when either stream is empty.
 */
function joinMerged(out: string, err: string): string {
  if (!out && !err) return '';
  if (!err) return out;
  if (!out) return err;
  return `${out}\n--- stderr ---\n${err}`;
}

export function mergeBgBashStreams(streams: BgBashStreamSet, stream: BgBashStreamName): string {
  if (stream === 'stdout') return streams.stdout.read().content;
  if (stream === 'stderr') return streams.stderr.read().content;
  // "merged": bg-bash does not track interleaving timestamps in memory.
  // The on-disk log is interleaved in wall-clock order; this in-memory
  // view keeps stdout then stderr with a labeled separator. This full-buffer
  // overview is used by the overlay and log-tail; `readBgBashStream` builds
  // the cursor-filtered merged view from the per-stream reads instead.
  return joinMerged(streams.stdout.read().content, streams.stderr.read().content);
}

export function readBgBashStream(streams: BgBashStreamSet, stream: BgBashStreamName, opts: ReadOptions): ReadResult {
  if (stream === 'stdout') return streams.stdout.read(opts);
  if (stream === 'stderr') return streams.stderr.read(opts);
  // Merged: build content from the ALREADY cursor-filtered per-stream reads
  // (each honors `opts.sinceCursor` / `opts.maxBytes` in its own cursor
  // space) rather than re-reading the full buffers.
  const outR = streams.stdout.read(opts);
  const errR = streams.stderr.read(opts);
  const merged = joinMerged(outR.content, errR.content);
  const content = opts.maxBytes !== undefined ? clampBytes(merged, opts.maxBytes) : merged;
  return {
    content,
    // Merged output interleaves two independent cursor spaces, so there is no
    // single scalar cursor that resumes it (summing stdout+stderr cursors is
    // meaningless). Report 0 to mark the merged read NON-RESUMABLE: a caller
    // that needs incremental reads must pick a single stream (stdout/stderr).
    cursor: 0,
    droppedBefore: outR.droppedBefore || errR.droppedBefore,
    totalBytes: outR.totalBytes + errR.totalBytes,
    droppedBytes: outR.droppedBytes + errR.droppedBytes,
  };
}

export function bgBashStreamCursor(streams: BgBashStreamSet, stream: BgBashStreamName): number {
  if (stream === 'stdout') return streams.stdout.byteLengthTotal;
  if (stream === 'stderr') return streams.stderr.byteLengthTotal;
  return streams.stdout.byteLengthTotal + streams.stderr.byteLengthTotal;
}

export function bgBashStreamTotal(streams: BgBashStreamSet, stream: BgBashStreamName): number {
  return bgBashStreamCursor(streams, stream);
}

export function bgBashStreamDropped(streams: BgBashStreamSet, stream: BgBashStreamName): number {
  if (stream === 'stdout') return streams.stdout.byteLengthDropped;
  if (stream === 'stderr') return streams.stderr.byteLengthDropped;
  return streams.stdout.byteLengthDropped + streams.stderr.byteLengthDropped;
}
