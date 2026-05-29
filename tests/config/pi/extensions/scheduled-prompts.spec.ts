/**
 * Tests for the scheduled-prompts extension's command + tool surface.
 *
 * The extension shell lives at `config/pi/extensions/scheduled-prompts.ts`
 * and is intentionally thin - all logic is delegated to the pure helpers
 * in `lib/node/pi/scheduled-prompts/`. This spec reconstructs the exact
 * flows the extension's `/schedule`, `/schedules`, and `schedule`-tool
 * handlers drive (parse -> build -> persist across scopes -> reconcile ->
 * fire -> re-arm) so the command surface stays in lockstep with the
 * helpers it is built from.
 *
 * Layout note: per `tests/lib/node/pi/README.md`, pure-helper specs live
 * under `tests/lib/node/pi/`. This spec sits under
 * `tests/config/pi/extensions/` to document the extension's command
 * surface; all code under test is still pure (no pi-runtime imports).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { formatScheduleList, parseScheduleCommand } from '../../../../lib/node/pi/scheduled-prompts/parse-command.ts';
import {
  computeNextFire,
  makeScheduleId,
  recordRun,
  reconcileSchedule,
  type Schedule,
  type ScheduleScope,
} from '../../../../lib/node/pi/scheduled-prompts/schedule.ts';
import {
  addToList,
  findById,
  globalSchedulesPath,
  projectSchedulesPath,
  readScopeFile,
  removeFromList,
  updateInList,
  writeScopeFile,
} from '../../../../lib/node/pi/scheduled-prompts/store.ts';

/**
 * Minimal stand-in for the extension's per-scope store: global/project
 * on disk, session in memory - mirroring `readScope`/`writeScope`.
 */
class ScopeStore {
  session: Schedule[] = [];

  constructor(private readonly cwd: string) {}

  read(scope: ScheduleScope): Schedule[] {
    if (scope === 'session') return this.session;
    return scope === 'global' ? readScopeFile(globalSchedulesPath()) : readScopeFile(projectSchedulesPath(this.cwd));
  }

  write(scope: ScheduleScope, list: Schedule[]): void {
    if (scope === 'session') {
      this.session = list;
      return;
    }
    writeScopeFile(scope === 'global' ? globalSchedulesPath() : projectSchedulesPath(this.cwd), list);
  }

  all(): Schedule[] {
    return [...this.read('global'), ...this.read('project'), ...this.session];
  }

  removeById(id: string): Schedule | undefined {
    for (const scope of ['session', 'global', 'project'] as const) {
      const { list, removed } = removeFromList(this.read(scope), id);
      if (removed) {
        this.write(scope, list);
        return removed;
      }
    }
    return undefined;
  }

  updateById(id: string, patch: Partial<Schedule>, now: number): Schedule | undefined {
    for (const scope of ['session', 'global', 'project'] as const) {
      const list = this.read(scope);
      if (!findById(list, id)) continue;
      const { list: patched, updated } = updateInList(list, id, patch);
      if (!updated) continue;
      const next = updated.enabled ? (computeNextFire(updated, new Date(now)) ?? undefined) : undefined;
      const reconciled: Schedule = { ...updated, nextFireAt: next };
      this.write(scope, updateInList(patched, id, reconciled).list);
      return reconciled;
    }
    return undefined;
  }
}

// Build a schedule the way the /schedule handler does.
function createFromCommand(store: ScopeStore, input: string, now: number, id: string): Schedule {
  const result = parseScheduleCommand(input, new Date(now));
  if (!result.ok) throw new Error(`unexpected parse failure: ${result.error}`);
  const { draft } = result;
  const schedule: Schedule = {
    id,
    name: draft.name,
    prompt: draft.prompt,
    trigger: draft.trigger,
    jitterMs: draft.jitterMs,
    scope: draft.scope,
    enabled: true,
    createdAt: now,
    runCount: 0,
  };
  schedule.nextFireAt = computeNextFire(schedule, new Date(now)) ?? undefined;
  store.write(schedule.scope, addToList(store.read(schedule.scope), schedule));
  return schedule;
}

// Soonest armed fire across all scopes - mirrors `rearm`.
function soonestFire(store: ScopeStore, now: number): number | undefined {
  let soonest: number | undefined;
  for (const original of store.all()) {
    const s = reconcileSchedule(original, now);
    if (!s.enabled || s.nextFireAt === undefined) continue;
    if (soonest === undefined || s.nextFireAt < soonest) soonest = s.nextFireAt;
  }
  return soonest;
}

// Fire due schedules in a scope - mirrors `fireDueInScope`. Returns the
// prompts that would have been delivered. Fires on the *cached*
// nextFireAt (no reconcile-forward): the timer wakes a hair after the
// target, so the cached instant is slightly in the past at wake time.
function fireDueInScope(store: ScopeStore, scope: ScheduleScope, now: number): string[] {
  const list = store.read(scope);
  let next = list;
  const fired: string[] = [];
  for (const s of list) {
    if (!s.enabled || s.nextFireAt === undefined) continue;
    if (s.nextFireAt > now + 1000) continue;
    fired.push(s.prompt);
    const ran = recordRun(s, now);
    next = ran.trigger.kind === 'once' ? removeFromList(next, s.id).list : updateInList(next, s.id, ran).list;
  }
  if (fired.length > 0) store.write(scope, next);
  return fired;
}

// Roll stale cached targets forward and persist - mirrors
// `reconcileScopePersist`, run at session_start.
function reconcileScopePersist(store: ScopeStore, scope: ScheduleScope, now: number): void {
  const list = store.read(scope);
  let changed = false;
  const next = list.map((s) => {
    const r = reconcileSchedule(s, now);
    if (r !== s) changed = true;
    return r;
  });
  if (changed) store.write(scope, next);
}

describe('scheduled-prompts command surface', () => {
  let dir: string;
  let cwd: string;
  let store: ScopeStore;
  const savedEnv = process.env.PI_CODING_AGENT_DIR;
  const NOW = new Date(2026, 0, 1, 8, 0, 0).getTime();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-ext-'));
    process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
    cwd = join(dir, 'repo');
    store = new ScopeStore(cwd);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  test('/schedule persists a global cron schedule and arms it', () => {
    const s = createFromCommand(store, '--cron "0 9 * * *" --scope global -- morning report', NOW, 'sp-1');
    expect(s.scope).toBe('global');
    expect(s.nextFireAt).toBe(new Date(2026, 0, 1, 9, 0, 0).getTime());
    // Persisted on disk and visible in the merged list.
    expect(readScopeFile(globalSchedulesPath()).map((x) => x.id)).toEqual(['sp-1']);
    expect(soonestFire(store, NOW)).toBe(s.nextFireAt);
  });

  test('/schedules list groups schedules across scopes', () => {
    createFromCommand(store, '--cron "0 9 * * *" --scope global -- report', NOW, 'sp-g');
    createFromCommand(store, '--every 30m --scope session -- continue', NOW, 'sp-s');
    const reconciled = store.all().map((s) => reconcileSchedule(s, NOW));
    const listing = formatScheduleList(reconciled, NOW);
    expect(listing).toContain('Global');
    expect(listing).toContain('sp-g');
    expect(listing).toContain('Session');
    expect(listing).toContain('sp-s');
  });

  test('a once schedule fires exactly once and is then removed', () => {
    createFromCommand(store, '--in 10m --scope session -- stretch', NOW, 'sp-once');
    const fireTime = NOW + 10 * 60_000;
    expect(fireDueInScope(store, 'session', fireTime)).toEqual(['stretch']);
    // Removed after firing; nothing left to arm.
    expect(store.read('session')).toHaveLength(0);
    expect(soonestFire(store, fireTime)).toBeUndefined();
  });

  test('a recurring schedule re-arms to the next interval after firing', () => {
    createFromCommand(store, '--every 30m --scope global -- ping', NOW, 'sp-int');
    const firstFire = NOW + 30 * 60_000;
    expect(fireDueInScope(store, 'global', firstFire)).toEqual(['ping']);
    const after = readScopeFile(globalSchedulesPath())[0];
    expect(after.runCount).toBe(1);
    expect(after.nextFireAt).toBe(NOW + 60 * 60_000);
  });

  test('a recurring schedule fires when the timer wakes slightly late', () => {
    createFromCommand(store, '--every 30m --scope global -- ping', NOW, 'sp-late');
    // The timer always wakes a few ms after the cached target; fire on
    // the cached instant rather than rolling forward and skipping it.
    const lateWake = NOW + 30 * 60_000 + 250;
    expect(fireDueInScope(store, 'global', lateWake)).toEqual(['ping']);
    expect(readScopeFile(globalSchedulesPath())[0].runCount).toBe(1);
  });

  test('a recurring fire missed while pi was closed is skipped, not fired late', () => {
    createFromCommand(store, '--every 30m --scope global -- ping', NOW, 'sp-missed');
    // pi reopens two hours later: the cached target is long past.
    const reopenedAt = NOW + 2 * 60 * 60_000 + 5_000;
    reconcileScopePersist(store, 'global', reopenedAt);
    const after = readScopeFile(globalSchedulesPath())[0];
    // Rolled forward to a future interval, so reopening does not fire it.
    expect(after.nextFireAt).toBeGreaterThan(reopenedAt);
    expect(fireDueInScope(store, 'global', reopenedAt)).toEqual([]);
  });

  test('/schedules off disables a schedule so it does not fire', () => {
    const s = createFromCommand(store, '--every 30m --scope global -- ping', NOW, 'sp-off');
    store.updateById(s.id, { enabled: false }, NOW);
    expect(soonestFire(store, NOW)).toBeUndefined();
    const fireTime = NOW + 30 * 60_000;
    expect(fireDueInScope(store, 'global', fireTime)).toEqual([]);
    // /schedules on re-arms it.
    store.updateById(s.id, { enabled: true }, fireTime);
    expect(soonestFire(store, fireTime)).toBe(fireTime + 30 * 60_000);
  });

  test('/schedules cancel removes a schedule from whichever scope holds it', () => {
    const s = createFromCommand(store, '--cron "0 9 * * *" --scope project -- report', NOW, 'sp-cancel');
    expect(store.removeById(s.id)?.id).toBe('sp-cancel');
    expect(store.removeById('nope')).toBeUndefined();
    expect(store.all()).toHaveLength(0);
  });

  test('makeScheduleId yields distinct-looking ids', () => {
    expect(makeScheduleId()).toMatch(/^sp-/);
  });
});
