/**
 * Tests for lib/node/pi/research-watchdog.ts.
 *
 * The watchdog is driven purely by injected `now` + `sleep`, so
 * tests script a virtual clock and a handle whose `status()` returns
 * a pre-queued sequence of snapshots. No real timers, no real time.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { watch, type WatchdogHandleLike, type WatchdogStatus } from '../../../../lib/node/pi/research-watchdog.ts';

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'research-watchdog-'));
}

/** Virtual clock the tests drive forward explicitly via sleep(). */
function makeClock(startMs = 1_000_000): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let current = startMs;
  return {
    now: () => current,
    sleep: (ms: number) => {
      current += ms;
      return Promise.resolve();
    },
  };
}

/** Script a handle whose `status()` returns queued snapshots in order. */
function makeHandle(id: string, snapshots: WatchdogStatus[]): WatchdogHandleLike & { aborts: string[] } {
  const aborts: string[] = [];
  let i = 0;
  return {
    id,
    aborts,
    status: () => {
      const snap = snapshots[i] ?? snapshots[snapshots.length - 1];
      if (i < snapshots.length - 1) i++;
      return Promise.resolve(snap);
    },
    abort: (reason?: string) => {
      aborts.push(reason ?? '(none)');
      return Promise.resolve();
    },
  };
}

describe('watch', () => {
  test('(a) output within threshold does not fire stall callback', async () => {
    const clock = makeClock(1_000_000);
    const handle: WatchdogHandleLike & { aborts: string[] } = {
      id: 'h-ok',
      aborts: [],
      status: () =>
        Promise.resolve<WatchdogStatus>(
          clock.now() >= 1_000_000 + 30_000
            ? { done: true, lastProgressAt: clock.now() }
            : { done: false, lastProgressAt: clock.now() },
        ),
      abort: () => {
        handle.aborts.push('(unexpected)');
        return Promise.resolve();
      },
    };
    const onStall = vi.fn();

    const result = await watch({
      handle,
      staleThresholdMs: 100_000,
      pollIntervalMs: 5_000,
      onStall,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.kind).toBe('completed');
    expect(onStall).not.toHaveBeenCalled();
    expect(handle.aborts).toHaveLength(0);
  });

  test('(b) no output past threshold fires stall callback and aborts', async () => {
    const clock = makeClock(1_000_000);
    // Snapshot always reports lastProgressAt fixed at start - never
    // advances. After enough sleep ticks, elapsed >= threshold.
    const handle = makeHandle('h-stalled', [{ done: false, lastProgressAt: 1_000_000, progressHint: 'fetch_url' }]);
    const onStall = vi.fn();
    const tmp = mkTmp();
    const journalPath = join(tmp, 'journal.md');

    const result = await watch({
      handle,
      staleThresholdMs: 20_000,
      pollIntervalMs: 5_000,
      onStall,
      now: clock.now,
      sleep: clock.sleep,
      journalPath,
    });

    expect(result).toMatchObject({ kind: 'stalled', aborted: true });
    expect((result as { reason: string }).reason).toContain('h-stalled');
    expect((result as { reason: string }).reason).toContain('fetch_url');
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith(expect.stringContaining('h-stalled'));
    expect(handle.aborts).toHaveLength(1);

    const journal = readFileSync(journalPath, 'utf8');

    expect(journal).toContain('[warn]');
    expect(journal).toContain('h-stalled');
  });

  test('(c) abortOnStall=false fires callback but does NOT touch handle', async () => {
    const clock = makeClock(1_000_000);
    const handle = makeHandle('h-observe', [{ done: false, lastProgressAt: 1_000_000 }]);
    const onStall = vi.fn();

    const result = await watch({
      handle,
      staleThresholdMs: 20_000,
      pollIntervalMs: 5_000,
      abortOnStall: false,
      onStall,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toMatchObject({ kind: 'stalled', aborted: false });
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(handle.aborts).toHaveLength(0);
  });

  test('errored status terminates cleanly without stall', async () => {
    const clock = makeClock(1_000_000);
    const handle = makeHandle('h-err', [
      { done: false, lastProgressAt: 1_000_000 },
      { done: true, lastProgressAt: 1_000_000, error: 'child threw' },
    ]);
    const onStall = vi.fn();

    const result = await watch({
      handle,
      staleThresholdMs: 60_000,
      pollIntervalMs: 1_000,
      onStall,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.kind).toBe('errored');
    expect(onStall).not.toHaveBeenCalled();
    expect(handle.aborts).toHaveLength(0);
  });

  test('parent abort signal stops polling without abort call', async () => {
    const clock = makeClock(1_000_000);
    const controller = new AbortController();
    let polls = 0;
    const handle: WatchdogHandleLike & { aborts: string[] } = {
      id: 'h-parent-abort',
      aborts: [],
      status: () => {
        polls++;
        if (polls >= 3) controller.abort();
        return Promise.resolve<WatchdogStatus>({ done: false, lastProgressAt: clock.now() });
      },
      abort: () => {
        handle.aborts.push('(unexpected)');
        return Promise.resolve();
      },
    };

    const result = await watch({
      handle,
      staleThresholdMs: 60_000,
      pollIntervalMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
      signal: controller.signal,
    });

    expect(result.kind).toBe('aborted-by-parent');
    expect(handle.aborts).toHaveLength(0);
  });

  test('status() throwing is classified as errored', async () => {
    const clock = makeClock(1_000_000);
    const handle: WatchdogHandleLike & { aborts: string[] } = {
      id: 'h-throws',
      aborts: [],
      status: () => Promise.reject(new Error('network down')),
      abort: () => {
        handle.aborts.push('(n/a)');
        return Promise.resolve();
      },
    };

    const result = await watch({
      handle,
      staleThresholdMs: 60_000,
      pollIntervalMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toMatchObject({ kind: 'errored' });
    expect((result as { lastStatus: { error: string } }).lastStatus.error).toContain('network down');
  });
});
