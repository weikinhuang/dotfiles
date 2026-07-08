/**
 * Tests for lib/node/pi/scheduled-prompts/complete.ts - the `/schedules`
 * subverb completion spec, driven through the shared `completeSubverbs`
 * helper the way the extension shell wires it.
 */

import { describe, expect, test } from 'vitest';

import { type CompletionItem, completeSubverbs } from '../../../../../lib/node/pi/commands/complete.ts';
import {
  buildSchedulesCompletionSpec,
  SCHEDULES_SUBVERBS,
} from '../../../../../lib/node/pi/scheduled-prompts/complete.ts';
import { type Schedule } from '../../../../../lib/node/pi/scheduled-prompts/schedule.ts';

function schedule(id: string, over: Partial<Schedule> = {}): Schedule {
  return {
    id,
    prompt: 'do the thing',
    trigger: { kind: 'interval', ms: 30 * 60_000 },
    scope: 'session',
    enabled: true,
    createdAt: 0,
    runCount: 0,
    ...over,
  };
}

const SCHEDULES = [schedule('sp-aaa'), schedule('sp-bbb', { trigger: { kind: 'cron', expr: '0 9 * * *' } })];

const complete = (prefix: string): CompletionItem[] | null =>
  completeSubverbs(prefix, buildSchedulesCompletionSpec(SCHEDULES));

describe('buildSchedulesCompletionSpec', () => {
  test('level 1 lists cancel/clear/on/off in order', () => {
    expect(complete('')?.map((c) => c.value)).toEqual([...SCHEDULES_SUBVERBS]);
  });

  test('level 1 filters by the typed prefix', () => {
    expect(complete('c')?.map((c) => c.value)).toEqual(['cancel', 'clear']);
    expect(complete('of')?.map((c) => c.value)).toEqual(['off']);
  });

  test('clear completes the scope set plus all, carrying the verb prefix', () => {
    expect(complete('clear ')?.map((c) => c.value)).toEqual([
      'clear global',
      'clear project',
      'clear session',
      'clear all',
    ]);
    expect(complete('clear pro')).toEqual([{ value: 'clear project', label: 'project', description: undefined }]);
  });

  test('cancel/on/off complete against schedule ids with a trigger description', () => {
    expect(complete('cancel ')).toEqual([
      { value: 'cancel sp-aaa', label: 'sp-aaa', description: 'every 30m' },
      { value: 'cancel sp-bbb', label: 'sp-bbb', description: 'cron "0 9 * * *"' },
    ]);
    // The verb prefix survives so pi doesn't drop it on submit.
    expect(complete('off sp-b')).toEqual([{ value: 'off sp-bbb', label: 'sp-bbb', description: 'cron "0 9 * * *"' }]);
  });

  test('returns null when nothing matches', () => {
    expect(complete('bogus')).toBeNull();
    expect(complete('cancel zzz')).toBeNull();
  });
});
