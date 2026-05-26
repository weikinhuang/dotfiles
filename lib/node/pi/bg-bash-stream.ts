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

export function mergeBgBashStreams(streams: BgBashStreamSet, stream: BgBashStreamName): string {
  if (stream === 'stdout') return streams.stdout.read().content;
  if (stream === 'stderr') return streams.stderr.read().content;
  // "merged": bg-bash does not track interleaving timestamps in memory.
  // The on-disk log is interleaved in wall-clock order; this in-memory
  // view keeps stdout then stderr with a labeled separator.
  const out = streams.stdout.read().content;
  const err = streams.stderr.read().content;
  if (!out && !err) return '';
  if (!err) return out;
  if (!out) return err;
  return `${out}\n--- stderr ---\n${err}`;
}

export function readBgBashStream(streams: BgBashStreamSet, stream: BgBashStreamName, opts: ReadOptions): ReadResult {
  if (stream === 'stdout') return streams.stdout.read(opts);
  if (stream === 'stderr') return streams.stderr.read(opts);
  // For merged streams we pick a synthetic cursor and totals by summing
  // both streams. Exact resumable reads require choosing one stream.
  const outR = streams.stdout.read(opts);
  const errR = streams.stderr.read(opts);
  const content = mergeBgBashStreams(streams, 'merged');
  return {
    content: opts.maxBytes !== undefined ? clampBytes(content, opts.maxBytes) : content,
    cursor: outR.cursor + errR.cursor,
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
