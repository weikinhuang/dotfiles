import { describe, expect, test } from 'vitest';

import { formatScheduleDetails } from '../../../../../lib/node/pi/scheduled-prompts/details.ts';
import { buildSchedule } from '../../../../../lib/node/pi/scheduled-prompts/schedule.ts';

const NOW = new Date('2026-01-01T08:00:00Z').getTime();

const schedule = buildSchedule(
  { id: 'sp-detail', prompt: 'Full ${t}\nprompt ${d}', trigger: { kind: 'interval', ms: 60_000 }, scope: 'session' },
  NOW,
  () => 0,
);

describe('schedule card details', () => {
  test('formats defaults and full literal prompt without modifying its input', () => {
    const bytes = JSON.stringify(schedule);
    expect(formatScheduleDetails(schedule, 'enabled')).toEqual({
      metadata: [
        'id: sp-detail',
        'name: none',
        'trigger: every 1m',
        'scope: session | status: enabled',
        'runs: 0 | maxRuns: unlimited | unansweredRuns: 0',
        'last fire: none',
        `next fire: ${new Date(NOW + 60_000).toLocaleString()}`,
        'jitter: 0s | chance: 1',
        'resetOnActivity: false | whenIdle: false',
      ].join('\n'),
      prompt: 'Full ${t}\nprompt ${d}',
    });
    expect(JSON.stringify(schedule)).toBe(bytes);
  });

  test('includes configured knobs, counts, idle defaults, and pool selection bookkeeping', () => {
    const configured = {
      ...schedule,
      name: 'scene',
      trigger: { kind: 'after' as const, minMs: 10_000, maxMs: 30_000 },
      scope: 'project' as const,
      jitterMs: 5000,
      chance: 0.25,
      resetOnActivity: true,
      maxRuns: 5,
      runCount: 2,
      unansweredRuns: 2,
      lastRunAt: NOW,
      prompts: ['first\nfull beat', 'second'],
      promptPick: 'roundRobin' as const,
      promptCursor: 1,
    };
    const details = formatScheduleDetails(configured, 'enabled');
    expect(details.metadata).toContain('name: scene\ntrigger: after 10s-30s');
    expect(details.metadata).toContain('scope: project | status: enabled');
    expect(details.metadata).toContain('runs: 2 | maxRuns: 5 | unansweredRuns: 2');
    expect(details.metadata).toContain(`last fire: ${new Date(NOW).toLocaleString()}`);
    expect(details.metadata).toContain('jitter: 5s | chance: 0.25');
    expect(details.metadata).toContain('resetOnActivity: true | whenIdle: true');
    expect(details.metadata).toContain('prompt pool: 2 | pick: roundRobin | cursor: 1');
    expect(details.prompt).toBe('1. first\nfull beat\n2. second');
    expect(
      formatScheduleDetails({ ...configured, promptPick: undefined, promptCursor: undefined }, 'enabled').metadata,
    ).toContain('prompt pool: 2 | pick: random | cursor: 0');
  });

  test.each(['paused', 'deleted', 'exhausted'] as const)(
    '%s has no pending fire, retaining useful frozen fields',
    (status) => {
      const details = formatScheduleDetails(schedule, status);
      expect(details.metadata).toContain(`status: ${status}`);
      expect(details.metadata).toContain('next fire: none');
      expect(details.metadata).toContain('trigger: every 1m');
      expect(details.prompt).toBe(schedule.prompt);
    },
  );
});
