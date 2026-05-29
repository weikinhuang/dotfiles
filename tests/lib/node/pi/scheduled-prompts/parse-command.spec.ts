/**
 * Tests for lib/node/pi/scheduled-prompts/parse-command.ts.
 */

import { describe, expect, test } from 'vitest';

import { type Schedule, type Trigger } from '../../../../../lib/node/pi/scheduled-prompts/schedule.ts';
import {
  DEFAULT_COMMAND_SCOPE,
  formatScheduleList,
  parseScheduleCommand,
  tokenize,
} from '../../../../../lib/node/pi/scheduled-prompts/parse-command.ts';

const NOW = new Date(2026, 0, 1, 8, 0, 0);

describe('tokenize', () => {
  test('splits on whitespace', () => {
    expect(tokenize('--every 30m -- hello world')).toEqual(['--every', '30m', '--', 'hello', 'world']);
  });

  test('keeps quoted strings together', () => {
    expect(tokenize('--cron "0 9 * * *" --name "morning report"')).toEqual([
      '--cron',
      '0 9 * * *',
      '--name',
      'morning report',
    ]);
  });

  test('keeps an empty quoted token', () => {
    expect(tokenize('--name ""')).toEqual(['--name', '']);
  });
});

describe('parseScheduleCommand', () => {
  test('parses a cron schedule with all options', () => {
    const r = parseScheduleCommand(
      '--cron "0 9 * * *" --jitter 5m --scope project --name "morning report" -- summarize my day',
      NOW,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.trigger).toEqual({ kind: 'cron', expr: '0 9 * * *' });
    expect(r.draft.jitterMs).toBe(5 * 60_000);
    expect(r.draft.scope).toBe('project');
    expect(r.draft.name).toBe('morning report');
    expect(r.draft.prompt).toBe('summarize my day');
  });

  test('parses --every into an interval', () => {
    const r = parseScheduleCommand('--every 30m -- keep going', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.trigger).toEqual({ kind: 'interval', ms: 30 * 60_000 });
    expect(r.draft.scope).toBe(DEFAULT_COMMAND_SCOPE);
  });

  test('parses --in into a once relative to now', () => {
    const r = parseScheduleCommand('--in 10m -- stretch', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.trigger).toEqual({ kind: 'once', at: NOW.getTime() + 10 * 60_000 });
  });

  test('parses --at into the next local HH:MM', () => {
    const r = parseScheduleCommand('--at 09:00 -- standup', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.trigger).toEqual({ kind: 'once', at: new Date(2026, 0, 1, 9, 0, 0).getTime() });
  });

  test('--at rolls to tomorrow when the time already passed', () => {
    const r = parseScheduleCommand('--at 07:00 -- standup', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.trigger).toEqual({ kind: 'once', at: new Date(2026, 0, 2, 7, 0, 0).getTime() });
  });

  test('rejects when no trigger is given', () => {
    const r = parseScheduleCommand('-- just a prompt', NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('trigger is required');
  });

  test('rejects multiple triggers', () => {
    const r = parseScheduleCommand('--every 30m --in 10m -- x', NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('only one trigger');
  });

  test('rejects a missing prompt', () => {
    const r = parseScheduleCommand('--every 30m', NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('prompt is required');
  });

  test('rejects invalid cron, duration, scope, and unknown flags', () => {
    expect(parseScheduleCommand('--cron "bad" -- x', NOW).ok).toBe(false);
    expect(parseScheduleCommand('--every 5w -- x', NOW).ok).toBe(false);
    expect(parseScheduleCommand('--at 99:99 -- x', NOW).ok).toBe(false);
    expect(parseScheduleCommand('--scope nope --every 1m -- x', NOW).ok).toBe(false);
    expect(parseScheduleCommand('--bogus -- x', NOW).ok).toBe(false);
  });

  test('rejects empty input', () => {
    expect(parseScheduleCommand('', NOW).ok).toBe(false);
  });
});

function sched(over: Partial<Schedule> & { id: string; trigger: Trigger }): Schedule {
  return {
    prompt: 'do it',
    scope: 'global',
    enabled: true,
    createdAt: NOW.getTime(),
    runCount: 0,
    ...over,
  };
}

describe('formatScheduleList', () => {
  test('reports the empty case', () => {
    expect(formatScheduleList([], NOW.getTime())).toContain('No schedules');
  });

  test('groups by scope and shows id, trigger, and next fire', () => {
    const list: Schedule[] = [
      sched({
        id: 'sp-g',
        scope: 'global',
        trigger: { kind: 'cron', expr: '0 9 * * *' },
        nextFireAt: new Date(2026, 0, 1, 9, 0, 0).getTime(),
        name: 'morning',
      }),
      sched({ id: 'sp-s', scope: 'session', trigger: { kind: 'interval', ms: 30 * 60_000 }, enabled: false }),
    ];
    const out = formatScheduleList(list, NOW.getTime());
    expect(out).toContain('Global');
    expect(out).toContain('sp-g');
    expect(out).toContain('"morning"');
    expect(out).toContain('cron "0 9 * * *"');
    expect(out).toContain('Session');
    expect(out).toContain('[off]');
  });
});
