/**
 * Tests for lib/node/pi/bg-bash-stream.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  bgBashStreamCursor,
  bgBashStreamDropped,
  bgBashStreamTotal,
  mergeBgBashStreams,
  readBgBashStream,
  type BgBashReadableStream,
  type BgBashStreamSet,
} from '../../../../lib/node/pi/bg-bash-stream.ts';
import { type ReadOptions, type ReadResult } from '../../../../lib/node/pi/bg-bash-ring.ts';

class FakeStream implements BgBashReadableStream {
  readonly byteLengthTotal: number;
  readonly byteLengthDropped: number;
  lastReadOptions: ReadOptions | undefined;

  constructor(
    private readonly content: string,
    opts: { cursor?: number; totalBytes?: number; droppedBytes?: number; droppedBefore?: boolean } = {},
  ) {
    this.byteLengthTotal = opts.totalBytes ?? opts.cursor ?? content.length;
    this.byteLengthDropped = opts.droppedBytes ?? 0;
    this.cursor = opts.cursor ?? this.byteLengthTotal;
    this.droppedBefore = opts.droppedBefore ?? false;
    this.totalBytes = opts.totalBytes ?? this.byteLengthTotal;
    this.droppedBytes = opts.droppedBytes ?? this.byteLengthDropped;
  }

  private readonly cursor: number;
  private readonly droppedBefore: boolean;
  private readonly totalBytes: number;
  private readonly droppedBytes: number;

  read(opts?: ReadOptions): ReadResult {
    this.lastReadOptions = opts;
    return {
      content: this.content,
      cursor: this.cursor,
      droppedBefore: this.droppedBefore,
      totalBytes: this.totalBytes,
      droppedBytes: this.droppedBytes,
    };
  }
}

function makeStreams(stdout: FakeStream, stderr: FakeStream): BgBashStreamSet {
  return { stdout, stderr };
}

test('mergeBgBashStreams: returns a selected stream directly', () => {
  const streams = makeStreams(new FakeStream('out'), new FakeStream('err'));

  expect(mergeBgBashStreams(streams, 'stdout')).toBe('out');
  expect(mergeBgBashStreams(streams, 'stderr')).toBe('err');
});

test('mergeBgBashStreams: joins stdout and stderr with a separator', () => {
  const streams = makeStreams(new FakeStream('out'), new FakeStream('err'));

  expect(mergeBgBashStreams(streams, 'merged')).toBe('out\n--- stderr ---\nerr');
});

test('mergeBgBashStreams: omits the separator when either side is empty', () => {
  expect(mergeBgBashStreams(makeStreams(new FakeStream('out'), new FakeStream('')), 'merged')).toBe('out');
  expect(mergeBgBashStreams(makeStreams(new FakeStream(''), new FakeStream('err')), 'merged')).toBe('err');
  expect(mergeBgBashStreams(makeStreams(new FakeStream(''), new FakeStream('')), 'merged')).toBe('');
});

test('readBgBashStream: delegates direct stream reads with options', () => {
  const stdout = new FakeStream('out', { cursor: 12 });
  const streams = makeStreams(stdout, new FakeStream('err'));
  const result = readBgBashStream(streams, 'stdout', { sinceCursor: 7, maxBytes: 20 });

  expect(result.content).toBe('out');
  expect(result.cursor).toBe(12);
  expect(stdout.lastReadOptions).toEqual({ sinceCursor: 7, maxBytes: 20 });
});

test('readBgBashStream: aggregates merged cursor and dropped accounting', () => {
  const streams = makeStreams(
    new FakeStream('stdout content', { cursor: 12, totalBytes: 20, droppedBytes: 3, droppedBefore: true }),
    new FakeStream('stderr content', { cursor: 7, totalBytes: 11, droppedBytes: 2 }),
  );
  const result = readBgBashStream(streams, 'merged', { maxBytes: 15 });

  expect(result.cursor).toBe(19);
  expect(result.totalBytes).toBe(31);
  expect(result.droppedBytes).toBe(5);
  expect(result.droppedBefore).toBe(true);
  expect(result.content).toContain('[29B truncated; see logFile]');
});

test('stream counters: return selected or synthetic merged counts', () => {
  const streams = makeStreams(
    new FakeStream('out', { totalBytes: 10, droppedBytes: 2 }),
    new FakeStream('err', { totalBytes: 8, droppedBytes: 1 }),
  );

  expect(bgBashStreamCursor(streams, 'stdout')).toBe(10);
  expect(bgBashStreamTotal(streams, 'stderr')).toBe(8);
  expect(bgBashStreamCursor(streams, 'merged')).toBe(18);
  expect(bgBashStreamDropped(streams, 'merged')).toBe(3);
});
