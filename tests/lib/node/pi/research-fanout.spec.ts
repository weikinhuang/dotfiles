/**
 * Tests for lib/node/pi/research-fanout.ts.
 *
 * The fanout spawner is dependency-injected, so tests drive it via
 * hand-rolled mock handles whose `status()` and `wait()` responses
 * are scripted per task id. No real subagents, no real timers.
 *
 * A virtual `clock` + `sleep` pair lets `research-watchdog.watch`
 * march forward deterministically — the same technique used in
 * `research-watchdog.spec.ts`.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  fanout,
  type FanoutHandleLike,
  type FanoutHandleResult,
  type FanoutSpawner,
} from '../../../../lib/node/pi/research-fanout.ts';
import { paths } from '../../../../lib/node/pi/research-paths.ts';
import { type WatchdogStatus } from '../../../../lib/node/pi/research-watchdog.ts';

function mkRunRoot(): string {
  return mkdtempSync(join(tmpdir(), 'research-fanout-'));
}

/** Virtual clock — same shape as the watchdog spec's helper. */
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

type StatusSequence = (WatchdogStatus | (() => WatchdogStatus))[];

interface MockHandleOpts {
  id: string;
  /**
   * Queue of statuses returned by `status()`. The last entry is
   * sticky (returned for any additional poll). Function entries
   * are called lazily so tests can inject a clock-aware
   * `lastProgressAt`.
   */
  statuses: StatusSequence;
  /** What `wait()` resolves to. */
  waitResult: FanoutHandleResult | Error;
}

interface MockHandle extends FanoutHandleLike {
  readonly aborts: string[];
  readonly statusPolls: number;
}

function makeHandle(opts: MockHandleOpts): MockHandle {
  const aborts: string[] = [];
  let pollI = 0;
  let polls = 0;
  const h: FanoutHandleLike = {
    id: opts.id,
    status: () => {
      polls++;
      const entry = opts.statuses[Math.min(pollI, opts.statuses.length - 1)];
      if (pollI < opts.statuses.length - 1) pollI++;
      const snap = typeof entry === 'function' ? entry() : entry;
      return Promise.resolve(snap);
    },
    abort: (reason?: string) => {
      aborts.push(reason ?? '(none)');
      return Promise.resolve();
    },
    wait: () => {
      if (opts.waitResult instanceof Error) return Promise.reject(opts.waitResult);
      return Promise.resolve(opts.waitResult);
    },
  };
  // Attach observables without breaking the typed interface.
  Object.defineProperty(h, 'aborts', { get: () => aborts });
  Object.defineProperty(h, 'statusPolls', { get: () => polls });
  return h as MockHandle;
}

interface SpawnerLog {
  args: { id: string; mode: string; agentName: string }[];
}

function makeSpawner(byId: Record<string, MockHandle | Error>): { spawn: FanoutSpawner; log: SpawnerLog } {
  const log: SpawnerLog = { args: [] };
  const spawn: FanoutSpawner = (args) => {
    log.args.push({ id: args.task.id, mode: args.mode, agentName: args.agentName });
    const entry = byId[args.task.id];
    if (entry === undefined) return Promise.reject(new Error(`no mock for ${args.task.id}`));
    if (entry instanceof Error) return Promise.reject(entry);
    return Promise.resolve(entry);
  };
  return { spawn, log };
}

function readFanoutFile(runRoot: string): unknown {
  const p = paths(runRoot).fanout;
  return JSON.parse(readFileSync(p, 'utf8'));
}

describe('fanout', () => {
  test('all tasks succeed in background mode', async () => {
    const runRoot = mkRunRoot();
    const clock = makeClock();
    const h1 = makeHandle({
      id: 't1',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: true, output: 'answer-one' },
    });
    const h2 = makeHandle({
      id: 't2',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: true, output: 'answer-two' },
    });
    const h3 = makeHandle({
      id: 't3',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: true, output: 'answer-three' },
    });
    const { spawn, log } = makeSpawner({ t1: h1, t2: h2, t3: h3 });

    const result = await fanout(
      {
        agentName: 'research-subagent',
        tasks: [
          { id: 't1', prompt: 'Q1' },
          { id: 't2', prompt: 'Q2' },
          { id: 't3', prompt: 'Q3' },
        ],
        mode: 'background',
        wallClockSec: 60,
      },
      runRoot,
      { spawn, clock: clock.now, sleep: clock.sleep, pollIntervalMs: 1_000, staleThresholdMs: 60_000 },
    );

    expect(result.completed).toEqual([
      { id: 't1', output: 'answer-one' },
      { id: 't2', output: 'answer-two' },
      { id: 't3', output: 'answer-three' },
    ]);
    expect(result.failed).toHaveLength(0);
    expect(result.aborted).toHaveLength(0);
    expect(log.args.map((a) => a.id).sort()).toEqual(['t1', 't2', 't3']);
    expect(log.args.every((a) => a.mode === 'background')).toBe(true);

    // fanout.json persisted with terminal states.
    const persisted = readFanoutFile(runRoot) as { tasks: { id: string; state: string }[] };

    expect(persisted.tasks.map((t) => t.state)).toEqual(['completed', 'completed', 'completed']);
  });

  test('one task times out (watchdog aborts) while others complete', async () => {
    const runRoot = mkRunRoot();
    const clock = makeClock(1_000_000);
    // Stalling handle: progress timestamp never advances past the
    // starting ms, so after a few sleep ticks the watchdog declares
    // it stalled and aborts.
    const stall = makeHandle({
      id: 't-stall',
      statuses: [{ done: false, lastProgressAt: 1_000_000, progressHint: 'fetch_url' }],
      waitResult: { ok: false, reason: 'should not be awaited' },
    });
    const ok1 = makeHandle({
      id: 't-ok1',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: true, output: 'fine-1' },
    });
    const ok2 = makeHandle({
      id: 't-ok2',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: true, output: 'fine-2' },
    });
    const { spawn } = makeSpawner({ 't-stall': stall, 't-ok1': ok1, 't-ok2': ok2 });

    const result = await fanout(
      {
        agentName: 'research-subagent',
        tasks: [
          { id: 't-ok1', prompt: 'Q1' },
          { id: 't-stall', prompt: 'Qstall' },
          { id: 't-ok2', prompt: 'Q2' },
        ],
        mode: 'background',
        wallClockSec: 3_600,
      },
      runRoot,
      {
        spawn,
        clock: clock.now,
        sleep: clock.sleep,
        pollIntervalMs: 1_000,
        staleThresholdMs: 5_000,
      },
    );

    // Result buckets are order-stable relative to spec.tasks.
    expect(result.completed).toEqual([
      { id: 't-ok1', output: 'fine-1' },
      { id: 't-ok2', output: 'fine-2' },
    ]);
    expect(result.failed).toHaveLength(0);
    expect(result.aborted).toHaveLength(1);
    expect(result.aborted[0].id).toBe('t-stall');
    expect(result.aborted[0].reason).toContain('t-stall');
    // Handle was aborted by the watchdog.
    expect(stall.aborts.length).toBeGreaterThan(0);
  });

  test('one task aborts immediately and does not block others', async () => {
    const runRoot = mkRunRoot();
    const clock = makeClock();
    // Handle whose wait() says "aborted by user" — bucketed as aborted.
    const cancelled = makeHandle({
      id: 't-cancel',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: false, reason: 'aborted by user', aborted: true },
    });
    const other = makeHandle({
      id: 't-other',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: true, output: 'done' },
    });
    const { spawn } = makeSpawner({ 't-cancel': cancelled, 't-other': other });

    const result = await fanout(
      {
        agentName: 'research-subagent',
        tasks: [
          { id: 't-cancel', prompt: 'Q1' },
          { id: 't-other', prompt: 'Q2' },
        ],
        mode: 'background',
        wallClockSec: 60,
      },
      runRoot,
      { spawn, clock: clock.now, sleep: clock.sleep, pollIntervalMs: 1_000, staleThresholdMs: 60_000 },
    );

    expect(result.aborted).toEqual([{ id: 't-cancel', reason: 'aborted by user' }]);
    expect(result.completed).toEqual([{ id: 't-other', output: 'done' }]);
    expect(result.failed).toHaveLength(0);
  });

  test('spawner throwing lands the task in the failed bucket', async () => {
    const runRoot = mkRunRoot();
    const clock = makeClock();
    const ok = makeHandle({
      id: 't-ok',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: true, output: 'yes' },
    });
    const { spawn } = makeSpawner({ 't-err': new Error('agent not installed'), 't-ok': ok });

    const result = await fanout(
      {
        agentName: 'research-subagent',
        tasks: [
          { id: 't-err', prompt: 'Q1' },
          { id: 't-ok', prompt: 'Q2' },
        ],
        mode: 'background',
        wallClockSec: 60,
      },
      runRoot,
      { spawn, clock: clock.now, sleep: clock.sleep, pollIntervalMs: 1_000, staleThresholdMs: 60_000 },
    );

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe('t-err');
    expect(result.failed[0].reason).toContain('agent not installed');
    expect(result.completed).toEqual([{ id: 't-ok', output: 'yes' }]);
  });

  test('resume: reads fanout.json, keeps terminal tasks, respawns only missing ones', async () => {
    const runRoot = mkRunRoot();
    const clock = makeClock();

    // Hand-author a partial fanout.json: t1 already completed, t2
    // already failed, t3 was spawned but never finished, t4 is
    // missing entirely.
    const priorPath = paths(runRoot).fanout;
    const prior = {
      version: 1,
      mode: 'background',
      agentName: 'research-subagent',
      tasks: [
        {
          id: 't1',
          prompt: 'Q1',
          state: 'completed',
          output: 'from-prior-run',
          finishedAt: '2025-01-01T00:00:00.000Z',
        },
        {
          id: 't2',
          prompt: 'Q2',
          state: 'failed',
          reason: 'prior error',
          finishedAt: '2025-01-01T00:00:01.000Z',
        },
        // t3 was spawned but not finished — resume should re-dispatch.
        {
          id: 't3',
          prompt: 'Q3',
          state: 'spawned',
          spawnedAt: '2025-01-01T00:00:02.000Z',
        },
      ],
    };
    writeFileSync(priorPath, JSON.stringify(prior, null, 2));

    const h3 = makeHandle({
      id: 't3',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: true, output: 'resumed-3' },
    });
    const h4 = makeHandle({
      id: 't4',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: true, output: 'fresh-4' },
    });
    const { spawn, log } = makeSpawner({ t3: h3, t4: h4 });

    const result = await fanout(
      {
        agentName: 'research-subagent',
        tasks: [
          { id: 't1', prompt: 'Q1' },
          { id: 't2', prompt: 'Q2' },
          { id: 't3', prompt: 'Q3' },
          { id: 't4', prompt: 'Q4' },
        ],
        mode: 'background',
        wallClockSec: 60,
      },
      runRoot,
      { spawn, clock: clock.now, sleep: clock.sleep, pollIntervalMs: 1_000, staleThresholdMs: 60_000 },
    );

    // Terminal tasks preserved verbatim.
    expect(result.completed).toEqual([
      { id: 't1', output: 'from-prior-run' },
      { id: 't3', output: 'resumed-3' },
      { id: 't4', output: 'fresh-4' },
    ]);
    expect(result.failed).toEqual([{ id: 't2', reason: 'prior error' }]);
    expect(result.aborted).toHaveLength(0);

    // Only the missing tasks were spawned — t1 and t2 never hit the
    // spawner.
    const spawnedIds = log.args.map((a) => a.id).sort();

    expect(spawnedIds).toEqual(['t3', 't4']);
  });

  test('sync fallback mode: mode="sync" is threaded to the spawner and persisted', async () => {
    const runRoot = mkRunRoot();
    const clock = makeClock();
    const h1 = makeHandle({
      id: 't1',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: true, output: 'sync-ok' },
    });
    const h2 = makeHandle({
      id: 't2',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: true, output: 'sync-ok-2' },
    });
    const { spawn, log } = makeSpawner({ t1: h1, t2: h2 });

    const result = await fanout(
      {
        agentName: 'research-subagent',
        tasks: [
          { id: 't1', prompt: 'Q1' },
          { id: 't2', prompt: 'Q2' },
        ],
        mode: 'sync',
        maxConcurrent: 1,
        wallClockSec: 60,
      },
      runRoot,
      { spawn, clock: clock.now, sleep: clock.sleep, pollIntervalMs: 1_000, staleThresholdMs: 60_000 },
    );

    expect(result.completed).toHaveLength(2);
    expect(log.args.every((a) => a.mode === 'sync')).toBe(true);

    const persisted = readFanoutFile(runRoot) as { mode: string };

    expect(persisted.mode).toBe('sync');
  });

  test('watchdog errored status lands the task in the failed bucket', async () => {
    const runRoot = mkRunRoot();
    const clock = makeClock();
    const h = makeHandle({
      id: 't-err',
      statuses: [
        { done: false, lastProgressAt: clock.now() },
        { done: true, lastProgressAt: clock.now(), error: 'child crashed' },
      ],
      waitResult: { ok: true, output: 'never-returned' },
    });
    const { spawn } = makeSpawner({ 't-err': h });

    const result = await fanout(
      {
        agentName: 'research-subagent',
        tasks: [{ id: 't-err', prompt: 'Q' }],
        mode: 'background',
        wallClockSec: 60,
      },
      runRoot,
      { spawn, clock: clock.now, sleep: clock.sleep, pollIntervalMs: 1_000, staleThresholdMs: 60_000 },
    );

    expect(result.failed).toEqual([{ id: 't-err', reason: 'child crashed' }]);
    expect(result.completed).toHaveLength(0);
  });

  test('journal receives a resume entry when fanout.json is rehydrated', async () => {
    const runRoot = mkRunRoot();
    const clock = makeClock();
    const priorPath = paths(runRoot).fanout;
    writeFileSync(
      priorPath,
      JSON.stringify({
        version: 1,
        mode: 'background',
        agentName: 'research-subagent',
        tasks: [
          {
            id: 't1',
            prompt: 'Q1',
            state: 'completed',
            output: 'prior',
            finishedAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      }),
    );

    const h2 = makeHandle({
      id: 't2',
      statuses: [{ done: true, lastProgressAt: clock.now() }],
      waitResult: { ok: true, output: 'new' },
    });
    const { spawn } = makeSpawner({ t2: h2 });
    const journalPath = join(runRoot, 'journal.md');

    await fanout(
      {
        agentName: 'research-subagent',
        tasks: [
          { id: 't1', prompt: 'Q1' },
          { id: 't2', prompt: 'Q2' },
        ],
        mode: 'background',
        wallClockSec: 60,
      },
      runRoot,
      {
        spawn,
        journalPath,
        clock: clock.now,
        sleep: clock.sleep,
        pollIntervalMs: 1_000,
        staleThresholdMs: 60_000,
      },
    );

    const journal = readFileSync(journalPath, 'utf8');

    expect(journal).toContain('fanout resume');
    expect(journal).toContain('1/2 tasks already terminal');
  });
});
