/**
 * Tests for lib/node/pi/sandbox/signal-chain.ts.
 */

import { EventEmitter } from 'node:events';

import { describe, expect, test, vi } from 'vitest';

import {
  chainSignalListeners,
  type SignalListener,
  type SignalProcess,
  snapshotSignalListeners,
} from '../../../../../lib/node/pi/sandbox/signal-chain.ts';

function fakeProcess(): SignalProcess & { emit(event: string): boolean; killed: string[] } {
  const emitter = new EventEmitter();
  const killed: string[] = [];
  return {
    pid: 4242,
    killed,
    listeners: (event) => emitter.listeners(event) as SignalListener[],
    removeListener: (event, listener) => emitter.removeListener(event, listener),
    once: (event, listener) => emitter.once(event, listener),
    emit: (event) => emitter.emit(event),
    kill: (pid, signal) => {
      expect(pid).toBe(4242);
      killed.push(signal);
      return true;
    },
  };
}

describe('chainSignalListeners', () => {
  test('re-raises after an added async listener settles', async () => {
    const proc = fakeProcess();
    const preexisting = vi.fn();
    proc.once('SIGINT', preexisting);
    const before = snapshotSignalListeners(proc, 'SIGINT');

    let resolveCleanup: () => void = () => undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    proc.once('SIGINT', cleanup);

    expect(chainSignalListeners(proc, 'SIGINT', before)).toBe(1);
    proc.emit('SIGINT');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(preexisting).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(proc.killed).toEqual([]);

    resolveCleanup();
    await vi.waitFor(() => expect(proc.killed).toEqual(['SIGINT']));
    // One-shot: the wrapper is gone, so the re-raised signal can't loop.
    expect(proc.listeners('SIGINT')).toHaveLength(0);
  });

  test('re-raises even when the cleanup throws or rejects', async () => {
    const proc = fakeProcess();
    const before = snapshotSignalListeners(proc, 'SIGINT');
    proc.once('SIGINT', () => {
      throw new Error('boom');
    });
    proc.once('SIGINT', () => Promise.reject(new Error('nope')));
    expect(chainSignalListeners(proc, 'SIGINT', before)).toBe(2);
    proc.emit('SIGINT');
    await vi.waitFor(() => expect(proc.killed).toEqual(['SIGINT', 'SIGINT']));
  });

  test('re-raises after the timeout when the cleanup hangs', async () => {
    vi.useFakeTimers();
    try {
      const proc = fakeProcess();
      const before = snapshotSignalListeners(proc, 'SIGINT');
      proc.once('SIGINT', () => new Promise(() => undefined));
      chainSignalListeners(proc, 'SIGINT', before, 50);
      proc.emit('SIGINT');
      expect(proc.killed).toEqual([]);
      await vi.advanceTimersByTimeAsync(60);
      expect(proc.killed).toEqual(['SIGINT']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('leaves pre-existing listeners alone', () => {
    const proc = fakeProcess();
    const mine = vi.fn();
    proc.once('SIGINT', mine);
    const before = snapshotSignalListeners(proc, 'SIGINT');
    expect(chainSignalListeners(proc, 'SIGINT', before)).toBe(0);
    expect(proc.listeners('SIGINT')).toEqual([mine]);
  });
});
