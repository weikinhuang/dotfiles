import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import {
  createRoleplayControls,
  type RoleplayControlsSource,
} from '../../../../../lib/node/pi/ext/roleplay-controls.ts';
import { reminderMessageAnchor } from '../../../../../lib/node/pi/reminder-identity.ts';
import {
  createExtractionJob,
  EXTRACTION_JOB_ENTRY,
  updateExtractionStage,
  type ExtractionJob,
} from '../../../../../lib/node/pi/roleplay/extraction-jobs.ts';
import { ROLEPLAY_POLICY_ENTRY } from '../../../../../lib/node/pi/roleplay/retention-policy.ts';

interface Fixture {
  handle: ReturnType<typeof createRoleplayControls>['handle'];
  branch: Record<string, unknown>[];
  ctx: ExtensionContext;
  notify: Mock<(message: string, type?: string) => void>;
  appendEntry: Mock<(customType: string, data: unknown) => void>;
  source: RoleplayControlsSource;
  scene: ReminderMessage[];
  job: ExtractionJob;
  queue: (value?: ExtractionJob) => void;
}

function fixture(): Fixture {
  const branch: Record<string, unknown>[] = [];
  const notify = vi.fn<(message: string, type?: string) => void>();
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    branch.push({ type: 'custom', customType, data });
  });
  const ctx = { ui: { notify }, sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  const scene: ReminderMessage[] = [
    { role: 'user', content: 'Private Alice /secret/path opener' },
    { role: 'assistant', content: 'Private reply' },
    { role: 'user', content: 'Next input' },
  ];
  const source: RoleplayControlsSource = {
    cast: vi.fn(() => 'private-cast'),
    memory: vi.fn(() => ({ recap: 'Private recap\u001b[31m\u202e', timeline: '- Private beat' })),
    scene: vi.fn(() => scene),
    policy: vi.fn(() => ({ target: 12000, pin: true, includeReply: true })),
    inFlight: vi.fn(() => false),
    runTask: vi.fn<RoleplayControlsSource['runTask']>(async (_ctx, task) => {
      await task(new AbortController().signal, () => true);
    }),
    recapNow: vi.fn<RoleplayControlsSource['recapNow']>().mockResolvedValue(undefined),
    runJob: vi.fn<RoleplayControlsSource['runJob']>().mockResolvedValue(undefined),
    sanitize: vi.fn<RoleplayControlsSource['sanitize']>((messages) =>
      messages.map((message) => ({ ...message, content: 'sanitized' })),
    ),
  };
  const controls = createRoleplayControls({ appendEntry } as unknown as ExtensionAPI, source);
  const job = createExtractionJob(
    {
      cast: 'private-cast',
      fromAnchor: reminderMessageAnchor(scene[0]),
      toAnchor: reminderMessageAnchor(scene[2]),
      sourceRecapId: 'private-recap-id',
    },
    1,
  );
  const queue = (value = job): void => {
    branch.push({ type: 'custom', customType: EXTRACTION_JOB_ENTRY, data: value });
  };
  return { ...controls, branch, ctx, notify, appendEntry, source, scene, job, queue };
}

const output = (f: ReturnType<typeof fixture>): string => f.notify.mock.calls.map((call) => call[0]).join('\n');

describe('roleplay local controls', () => {
  it('only owns the assigned verbs and recap now', async () => {
    const f = fixture();
    const cases = [
      ['unknown', []],
      ['recap', ['force']],
      ['recap', []],
    ] as const;
    await Promise.all(
      cases.map(async ([verb, args]) => {
        expect(await f.handle(verb, args, f.ctx)).toBe(false);
      }),
    );
    expect(f.notify).not.toHaveBeenCalled();
  });

  it('shows full explicit summary, escapes controls, and never starts work', async () => {
    const f = fixture();
    const body = 'sensitive '.repeat(4000) + '\u001b\u009b\u202e';
    f.source.memory = () => ({ recap: body, timeline: '' });
    await f.handle('summary', [], f.ctx);
    expect(output(f)).toContain(body.slice(0, -3));
    expect(output(f)).toContain('\\u001b\\u009b\\u202e');
    expect(f.source.runTask).not.toHaveBeenCalled();
    expect(f.appendEntry).not.toHaveBeenCalled();
  });

  it('caps the default timeline injection preview and allows explicit full text', async () => {
    const f = fixture();
    const timeline = Array.from({ length: 60 }, (_, i) => `- beat ${i} ${'x'.repeat(60)}`).join('\n');
    f.source.memory = () => ({ recap: '', timeline });
    await f.handle('timeline', [], f.ctx);
    expect(output(f)).not.toContain('- beat 0 ');
    expect(output(f)).toContain('- beat 59 ');
    expect(output(f).length).toBeLessThan(1300);
    f.notify.mockClear();
    await f.handle('timeline', ['--all'], f.ctx);
    expect(output(f)).toContain(timeline);
  });

  it('reduces valid active-branch captures after the latest boundary without reading sibling notes', async () => {
    const f = fixture();
    const capture = (name: string, slug = 'one'): Record<string, unknown> => ({
      type: 'custom',
      customType: 'roleplay-capture',
      data: { cast: 'private-cast', facts: [{ slug, name, description: `${name} description\u001b` }] },
    });
    f.branch.push(
      capture('old-scene'),
      { type: 'custom', customType: 'roleplay-newscene' },
      capture('first'),
      capture('Private Alice'),
      {
        type: 'custom',
        customType: 'roleplay-capture',
        data: { cast: 'sibling', facts: [{ slug: 'sibling', name: 'sibling', description: 'hidden' }] },
      },
      {
        type: 'custom',
        customType: 'roleplay-capture',
        data: { cast: 'private-cast', facts: [{ slug: '', name: 'malformed', description: 'hidden' }] },
      },
    );
    await f.handle('facts', [], f.ctx);
    expect(output(f)).toContain('1 active-scene captures');
    expect(output(f)).not.toMatch(/Private Alice|private-cast|old-scene|first|sibling|hidden/);
    f.notify.mockClear();
    await f.handle('facts', ['--content'], f.ctx);
    expect(output(f)).toContain('Private Alice description\\u001b');
    expect(output(f)).not.toMatch(/old-scene|first|sibling|hidden/);
    expect(f.appendEntry).not.toHaveBeenCalled();
  });

  it('persists budget overrides only for valid integer targets or off', async () => {
    const f = fixture();
    await f.handle('budget', [], f.ctx);
    expect(output(f)).toContain('12000');
    await f.handle('budget', ['set', '1024'], f.ctx);
    await f.handle('budget', ['off'], f.ctx);
    expect(f.appendEntry.mock.calls).toEqual([
      [ROLEPLAY_POLICY_ENTRY, { cast: 'private-cast', target: 1024 }],
      [ROLEPLAY_POLICY_ENTRY, { cast: 'private-cast', target: 0 }],
    ]);
  });

  it('reports content-free opener head metadata and persists explicit pin/reply flags', async () => {
    const f = fixture();
    await f.handle('opener', ['show'], f.ctx);
    expect(output(f)).toContain('2 message(s)');
    expect(output(f)).toContain('pin on; include reply on');
    expect(output(f)).not.toMatch(/Private|Alice|secret|private-cast/);
    await Promise.all([['pin'], ['pin', 'reply'], ['unpin']].map((args) => f.handle('opener', args, f.ctx)));
    expect(f.appendEntry.mock.calls.map((call) => call[1])).toEqual([
      { cast: 'private-cast', pin: true, includeReply: false },
      { cast: 'private-cast', pin: true, includeReply: true },
      { cast: 'private-cast', pin: false, includeReply: false },
    ]);
  });

  it('rejects unknown arguments helpfully without side effects or model calls', async () => {
    const f = fixture();
    const cases: [string, string[]][] = [
      ['summary', ['all']],
      ['timeline', ['--content']],
      ['facts', ['--all']],
      ['budget', ['set', '1023']],
      ['budget', ['set', '1e4']],
      ['budget', ['set', '1024.5']],
      ['budget', ['set', '9007199254740992']],
      ['budget', ['off', 'extra']],
      ['opener', ['pin', 'no']],
      ['opener', ['unpin', 'reply']],
      ['jobs', ['retry']],
      ['jobs', ['retry', 'unknown']],
      ['jobs', ['drain', 'extra']],
      ['recap', ['now', 'extra']],
    ];
    await Promise.all(
      cases.map(async ([verb, args]) => {
        expect(await f.handle(verb, args, f.ctx)).toBe(true);
      }),
    );
    expect(f.notify).toHaveBeenCalledTimes(cases.length);
    expect(f.notify.mock.calls.every((call) => call[0].startsWith('Usage: /roleplay'))).toBe(true);
    expect(f.appendEntry).not.toHaveBeenCalled();
    expect(f.source.runTask).not.toHaveBeenCalled();
    expect(f.source.memory).not.toHaveBeenCalled();
  });

  it('routes recap now through the runtime serial task owner', async () => {
    const f = fixture();
    await f.handle('recap', ['now'], f.ctx);
    expect(f.source.runTask).toHaveBeenCalledOnce();
    expect(f.source.recapNow).toHaveBeenCalledWith(f.ctx, expect.any(AbortSignal), expect.any(Function));
    expect(f.source.runJob).not.toHaveBeenCalled();
  });

  it('handles dormant controls without exposing the cast or starting work', async () => {
    const f = fixture();
    f.source.cast = () => null;
    await f.handle('jobs', ['drain'], f.ctx);
    expect(output(f)).toContain('dormant');
    expect(f.source.runTask).not.toHaveBeenCalled();
  });
});

describe('roleplay extraction queue controls', () => {
  it('reports safe status only on the current scene branch', async () => {
    const f = fixture();
    f.queue();
    f.branch.push({ type: 'custom', customType: 'roleplay-cast-change' });
    await f.handle('jobs', [], f.ctx);
    expect(output(f)).toContain('No queued jobs');
    f.notify.mockClear();
    f.queue();
    await f.handle('jobs', [], f.ctx);
    expect(output(f)).toContain('facts pending; timeline pending');
    expect(output(f)).not.toMatch(/private|Alice|secret|entry:|sha256/);
    expect(f.source.runTask).not.toHaveBeenCalled();
    expect(f.appendEntry).not.toHaveBeenCalled();
  });

  it('drains only persisted jobs, resolves original stable spans, sanitizes, and runs serially', async () => {
    const f = fixture();
    f.queue();
    const second = createExtractionJob(
      {
        cast: 'private-cast',
        fromAnchor: reminderMessageAnchor(f.scene[1]),
        toAnchor: reminderMessageAnchor(f.scene[2]),
        sourceRecapId: 'recap-2',
      },
      2,
    );
    f.queue(second);
    const order: string[] = [];
    f.source.runJob = vi.fn<RoleplayControlsSource['runJob']>(async (_ctx, job, span) => {
      order.push(`start-${job.id}`);
      expect(span.every((message) => message.text === 'sanitized')).toBe(true);
      await Promise.resolve();
      order.push(`end-${job.id}`);
    });
    await f.handle('jobs', ['drain'], f.ctx);
    expect(f.source.sanitize).toHaveBeenNthCalledWith(1, f.scene.slice(0, 2), f.ctx);
    expect(order).toEqual([`start-${f.job.id}`, `end-${f.job.id}`, `start-${second.id}`, `end-${second.id}`]);
    expect(f.source.runTask).toHaveBeenCalledOnce();
  });

  it('retries selected unfinished stages and never clobbers complete or skipped stages', async () => {
    const f = fixture();
    const complete = updateExtractionStage(f.job, 'facts', 'complete', 2);
    f.queue(updateExtractionStage(complete, 'timeline', 'failed', 3, 'model-error'));
    await f.handle('jobs', ['retry', 'facts'], f.ctx);
    expect(f.source.runJob).not.toHaveBeenCalled();
    await f.handle('jobs', ['retry', 'timeline'], f.ctx);
    expect(f.source.runJob).toHaveBeenCalledWith(
      f.ctx,
      expect.objectContaining({ facts: complete.facts }),
      expect.any(Array),
      expect.any(AbortSignal),
      expect.any(Function),
      ['timeline'],
    );
    f.scene.length = 0;
    await f.handle('jobs', ['retry', 'all'], f.ctx);
    expect(f.appendEntry).toHaveBeenLastCalledWith(
      EXTRACTION_JOB_ENTRY,
      expect.objectContaining({
        facts: complete.facts,
        timeline: expect.objectContaining({ status: 'failed', reason: 'span-unavailable' }) as unknown,
      }),
    );
  });

  it.each([true, false])(
    'marks unavailable or unsanitizable spans failed without model calls (missing: %s)',
    async (missing) => {
      const f = fixture();
      const skipped = updateExtractionStage(f.job, 'timeline', 'skipped', 2, 'disabled');
      f.queue(skipped);
      if (missing) f.scene.length = 0;
      else f.source.sanitize = () => null;
      await f.handle('jobs', ['drain'], f.ctx);
      expect(f.source.runJob).not.toHaveBeenCalled();
      expect(f.appendEntry).toHaveBeenCalledWith(
        EXTRACTION_JOB_ENTRY,
        expect.objectContaining({
          facts: expect.objectContaining({ status: 'failed', reason: 'span-unavailable' }) as unknown,
          timeline: skipped.timeline,
        }),
      );
    },
  );

  it('does not backfill legacy history, or start stale/cancelled work after waiting', async () => {
    const f = fixture();
    await f.handle('jobs', ['drain'], f.ctx);
    expect(f.source.runJob).not.toHaveBeenCalled();
    expect(f.appendEntry).not.toHaveBeenCalled();
    f.queue();
    f.source.runTask = async (_ctx, task) => {
      await task(new AbortController().signal, () => false);
    };
    await f.handle('jobs', ['drain'], f.ctx);
    expect(f.source.sanitize).not.toHaveBeenCalled();
    f.source.runTask = async (_ctx, task) => {
      const abort = new AbortController();
      abort.abort();
      await task(abort.signal, () => true);
    };
    await f.handle('jobs', ['drain'], f.ctx);
    expect(f.source.runJob).not.toHaveBeenCalled();
  });
});
