/**
 * Tests for lib/node/pi/scheduled-prompts/store.ts.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { piAgentPath, piProjectPath } from '../../../../../lib/node/pi/pi-paths.ts';
import { type Schedule, type Trigger } from '../../../../../lib/node/pi/scheduled-prompts/schedule.ts';
import {
  addToList,
  findById,
  globalSchedulesPath,
  loadPersisted,
  parseScheduleFile,
  projectSchedulesPath,
  readScopeFile,
  removeFromList,
  updateInList,
  writeScopeFile,
} from '../../../../../lib/node/pi/scheduled-prompts/store.ts';

function makeSchedule(id: string, trigger: Trigger, over: Partial<Schedule> = {}): Schedule {
  return {
    id,
    prompt: `prompt ${id}`,
    trigger,
    scope: 'global',
    enabled: true,
    createdAt: 1_000,
    runCount: 0,
    ...over,
  };
}

describe('parseScheduleFile', () => {
  test('returns valid schedules and drops malformed entries', () => {
    const body = JSON.stringify({
      version: 1,
      schedules: [
        makeSchedule('sp-ok', { kind: 'cron', expr: '0 9 * * *' }),
        { id: 'sp-bad', prompt: 'x' }, // missing trigger/scope/etc
        { not: 'a schedule' },
        makeSchedule('sp-int', { kind: 'interval', ms: 1000 }),
      ],
    });
    const parsed = parseScheduleFile(body);
    expect(parsed.map((s) => s.id)).toEqual(['sp-ok', 'sp-int']);
  });

  test('tolerates malformed JSON and non-array schedules', () => {
    expect(parseScheduleFile('not json')).toEqual([]);
    expect(parseScheduleFile('{}')).toEqual([]);
    expect(parseScheduleFile(JSON.stringify({ version: 1, schedules: 'nope' }))).toEqual([]);
  });

  test('rejects unknown trigger kinds and bad scopes', () => {
    const body = JSON.stringify({
      version: 1,
      schedules: [
        makeSchedule('sp-1', { kind: 'weird' } as unknown as Trigger),
        makeSchedule('sp-2', { kind: 'cron', expr: '0 0 * * *' }, { scope: 'nope' as unknown as Schedule['scope'] }),
      ],
    });
    expect(parseScheduleFile(body)).toEqual([]);
  });

  test('accepts an after trigger and the phase-2 optional fields', () => {
    const s = makeSchedule(
      'sp-after',
      { kind: 'after', minMs: 30_000, maxMs: 300_000 },
      {
        prompts: ['a', 'b'],
        promptPick: 'roundRobin',
        promptCursor: 1,
        resetOnActivity: true,
        whenIdle: true,
        maxRuns: 5,
        chance: 0.5,
        unansweredRuns: 2,
      },
    );
    const parsed = parseScheduleFile(JSON.stringify({ version: 1, schedules: [s] }));
    expect(parsed).toEqual([s]);
  });

  test('rejects malformed phase-2 fields', () => {
    const bad = [
      makeSchedule('sp-a', { kind: 'after', minMs: 1, maxMs: 'x' } as unknown as Trigger),
      makeSchedule('sp-b', { kind: 'interval', ms: 1000 }, { prompts: [1, 2] as unknown as string[] }),
      makeSchedule('sp-c', { kind: 'interval', ms: 1000 }, { promptPick: 'sideways' as unknown as 'random' }),
      makeSchedule('sp-d', { kind: 'interval', ms: 1000 }, { chance: 'high' as unknown as number }),
      makeSchedule('sp-e', { kind: 'interval', ms: 1000 }, { whenIdle: 'yes' as unknown as boolean }),
    ];
    expect(parseScheduleFile(JSON.stringify({ version: 1, schedules: bad }))).toEqual([]);
  });

  test('rejects triggers that computeNextFire would silently disarm', () => {
    // Regression: these all parse structurally but never fire, so they
    // are dropped on read instead of loading as permanently-dead entries.
    const dead = [
      makeSchedule('sp-int0', { kind: 'interval', ms: 0 }),
      makeSchedule('sp-intneg', { kind: 'interval', ms: -5 }),
      makeSchedule('sp-aftmax0', { kind: 'after', minMs: 0, maxMs: 0 }),
      makeSchedule('sp-aftinv', { kind: 'after', minMs: 500, maxMs: 100 }),
      makeSchedule('sp-aftnegmin', { kind: 'after', minMs: -1, maxMs: 100 }),
      makeSchedule('sp-cronblank', { kind: 'cron', expr: '   ' }),
    ];
    expect(parseScheduleFile(JSON.stringify({ version: 1, schedules: dead }))).toEqual([]);
  });

  test('rejects out-of-range chance (0, negative, or > 1)', () => {
    const bad = [
      makeSchedule('sp-c0', { kind: 'interval', ms: 1000 }, { chance: 0 }),
      makeSchedule('sp-cneg', { kind: 'interval', ms: 1000 }, { chance: -0.2 }),
      makeSchedule('sp-chi', { kind: 'interval', ms: 1000 }, { chance: 1.5 }),
    ];
    expect(parseScheduleFile(JSON.stringify({ version: 1, schedules: bad }))).toEqual([]);
    // A valid boundary (chance === 1) still loads.
    const ok = makeSchedule('sp-c1', { kind: 'interval', ms: 1000 }, { chance: 1 });
    expect(parseScheduleFile(JSON.stringify({ version: 1, schedules: [ok] }))).toEqual([ok]);
  });
});

describe('disk round-trip', () => {
  let dir: string;
  const savedEnv = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-store-'));
    process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  test('missing file reads as empty', () => {
    expect(readScopeFile(globalSchedulesPath())).toEqual([]);
  });

  test('writeScopeFile then readScopeFile round-trips and writes versioned JSON', () => {
    const path = globalSchedulesPath();
    const schedules = [makeSchedule('sp-a', { kind: 'cron', expr: '0 9 * * *' })];
    writeScopeFile(path, schedules);
    expect(readScopeFile(path)).toEqual(schedules);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { version: number };
    expect(onDisk.version).toBe(1);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  test('loadPersisted reads both global and project scopes', () => {
    const cwd = join(dir, 'repo');
    writeScopeFile(globalSchedulesPath(), [makeSchedule('sp-g', { kind: 'interval', ms: 1000 })]);
    writeScopeFile(projectSchedulesPath(cwd), [makeSchedule('sp-p', { kind: 'once', at: 5000 }, { scope: 'project' })]);
    const loaded = loadPersisted(cwd);
    expect(loaded.global.map((s) => s.id)).toEqual(['sp-g']);
    expect(loaded.project.map((s) => s.id)).toEqual(['sp-p']);
  });

  test('hand-edited malformed file does not throw', () => {
    const path = globalSchedulesPath();
    // Seed a valid file first so the parent dir exists, then clobber it.
    writeScopeFile(path, []);
    writeFileSync(path, '{ broken', 'utf8');
    expect(readScopeFile(path)).toEqual([]);
  });
});

describe('PI_SCHEDULED_PROMPTS_DIR override', () => {
  const savedDir = process.env.PI_SCHEDULED_PROMPTS_DIR;

  afterEach(() => {
    if (savedDir === undefined) delete process.env.PI_SCHEDULED_PROMPTS_DIR;
    else process.env.PI_SCHEDULED_PROMPTS_DIR = savedDir;
  });

  test('override set: both paths are inside the dir and distinct', () => {
    const sandbox = '/tmp/sp-sandbox';
    const env = { ...process.env, PI_SCHEDULED_PROMPTS_DIR: sandbox };
    const g = globalSchedulesPath(env);
    const p = projectSchedulesPath('/some/cwd', env);
    expect(g).toBe(join(sandbox, 'global.scheduled-prompts.json'));
    expect(p).toBe(join(sandbox, 'project.scheduled-prompts.json'));
    expect(g).not.toBe(p);
  });

  test('override read from process.env when env param omitted', () => {
    const sandbox = '/tmp/sp-sandbox-env';
    process.env.PI_SCHEDULED_PROMPTS_DIR = sandbox;
    expect(globalSchedulesPath()).toBe(join(sandbox, 'global.scheduled-prompts.json'));
    expect(projectSchedulesPath('/some/cwd')).toBe(join(sandbox, 'project.scheduled-prompts.json'));
  });

  test('blank/whitespace override is ignored (falls back to defaults)', () => {
    const cwd = '/some/cwd';
    const env = { ...process.env, PI_SCHEDULED_PROMPTS_DIR: '   ' };
    expect(globalSchedulesPath(env)).toBe(piAgentPath('scheduled-prompts.json'));
    expect(projectSchedulesPath(cwd, env)).toBe(piProjectPath(cwd, 'scheduled-prompts.json'));
  });

  test('override unset: paths equal piAgentPath / piProjectPath', () => {
    const cwd = '/some/cwd';
    const env = { ...process.env };
    delete env.PI_SCHEDULED_PROMPTS_DIR;
    expect(globalSchedulesPath(env)).toBe(piAgentPath('scheduled-prompts.json'));
    expect(projectSchedulesPath(cwd, env)).toBe(piProjectPath(cwd, 'scheduled-prompts.json'));
  });
});

describe('list operations', () => {
  const base = [
    makeSchedule('sp-1', { kind: 'cron', expr: '0 9 * * *' }),
    makeSchedule('sp-2', { kind: 'interval', ms: 1000 }),
  ];

  test('findById', () => {
    expect(findById(base, 'sp-2')?.id).toBe('sp-2');
    expect(findById(base, 'nope')).toBeUndefined();
  });

  test('addToList appends without mutating', () => {
    const next = addToList(base, makeSchedule('sp-3', { kind: 'once', at: 1 }));
    expect(next).toHaveLength(3);
    expect(base).toHaveLength(2);
  });

  test('removeFromList returns the removed entry', () => {
    const { list, removed } = removeFromList(base, 'sp-1');
    expect(removed?.id).toBe('sp-1');
    expect(list.map((s) => s.id)).toEqual(['sp-2']);
    expect(removeFromList(base, 'nope').removed).toBeUndefined();
  });

  test('updateInList patches but preserves id', () => {
    const { list, updated } = updateInList(base, 'sp-1', { enabled: false, id: 'hacked' });
    expect(updated?.enabled).toBe(false);
    expect(updated?.id).toBe('sp-1');
    expect(findById(list, 'sp-1')?.enabled).toBe(false);
    expect(updateInList(base, 'nope', { enabled: false }).updated).toBeUndefined();
  });
});
