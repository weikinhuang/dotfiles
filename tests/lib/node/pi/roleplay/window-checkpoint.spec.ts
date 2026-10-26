import { describe, expect, it } from 'vitest';

import type { ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import { limitReminderContext } from '../../../../../lib/node/pi/reminder-budget.ts';
import { reminderContentAnchor, reminderMessageAnchor } from '../../../../../lib/node/pi/reminder-identity.ts';
import {
  createWindowCheckpoint,
  restoreWindowCheckpoint,
  WINDOW_CHECKPOINT_TYPE,
  type WindowCheckpoint,
  type WindowCheckpointKey,
} from '../../../../../lib/node/pi/roleplay/window-checkpoint.ts';
import { createWindowState, type WindowState } from '../../../../../lib/node/pi/roleplay/window-state.ts';

const key: WindowCheckpointKey = { cast: 'scene', provider: 'local', model: 'gemma' };

function user(index: number, chars = 10): ReminderMessage {
  return { role: 'user', content: 'x'.repeat(chars), timestamp: index, cacheReminderEntryId: `entry:${index}` };
}

function entry(data: unknown): Record<string, unknown> {
  return { type: 'custom', customType: WINDOW_CHECKPOINT_TYPE, data };
}

function checkpoint(overrides: Partial<WindowCheckpoint> = {}): WindowCheckpoint {
  return { ...key, version: 1, charsPerToken: 2, ...overrides };
}

function limit(win: WindowState, messages: readonly ReminderMessage[]): ReturnType<typeof limitReminderContext> {
  return limitReminderContext({
    messages,
    preview: (candidate) => candidate,
    origin: reminderMessageAnchor(messages[messages.length - 1]),
    floorAnchor: win.projectedFloorAnchor,
    windowTokens: 57344,
    charsPerToken: win.charsPerToken,
  });
}

describe('window checkpoint', () => {
  it('keeps the native calibrated hard floor across reload without any recap', () => {
    const messages = [user(1, 60000), user(2, 60000)];
    const warm = createWindowState();
    warm.charsPerToken = 2;
    const bounded = limit(warm, messages);
    expect(bounded.messages).toEqual([messages[1]]);
    expect(bounded.projectedChars / warm.charsPerToken).toBe(30000);
    warm.projectedFloorAnchor = bounded.floorAnchor;
    warm.frozenFloorCutoff = 1;
    warm.lastSentEstChars = bounded.projectedChars;
    const saved = createWindowCheckpoint(warm, messages, key);
    expect(saved).toEqual(checkpoint({ floorAnchor: 'entry:2', projectedFloorAnchor: 'entry:2' }));
    expect(saved).not.toHaveProperty('lastSentEstChars');
    expect(saved).not.toHaveProperty('frozenFloorCutoff');

    const fresh = createWindowState();
    expect(fresh.projectedFloorAnchor).toBeUndefined();
    const unbounded = limit(fresh, messages);
    expect(unbounded.messages).toHaveLength(2);
    expect(unbounded.projectedChars / fresh.charsPerToken).toBe(30000);
    expect(unbounded.projectedChars / warm.charsPerToken).toBe(60000);
    expect(restoreWindowCheckpoint([entry(saved)], fresh, messages, key)).toBe(true);
    expect(fresh.charsPerToken).toBe(2);
    expect(fresh.frozenFloorCutoff).toBe(1);
    expect(fresh.lastSentEstChars).toBe(0);
    expect(fresh.recapText).toBe('');
    const restored = limit(fresh, messages);
    expect(restored.messages).toEqual(bounded.messages);
    expect(restored.projectedChars / fresh.charsPerToken).toBe(30000);
  });

  it('uses only the supplied fork path and the latest checkpoint on it', () => {
    const shared = entry(checkpoint({ charsPerToken: 3 }));
    const left = [shared, entry(checkpoint({ charsPerToken: 2 }))];
    const right = [shared, { type: 'message' }, entry(checkpoint({ charsPerToken: 5 }))];
    const win = createWindowState();
    expect(restoreWindowCheckpoint(left, win, [], key)).toBe(true);
    expect(win.charsPerToken).toBe(2);
    expect(restoreWindowCheckpoint(right, win, [], key)).toBe(true);
    expect(win.charsPerToken).toBe(5);
  });

  it('resolves stable keys against the current array, including content-anchor aliases', () => {
    const boundary = user(2);
    const messages = [user(0), user(1), boundary];
    const win = createWindowState();
    const saved = checkpoint({
      floorAnchor: reminderContentAnchor(boundary),
      projectedFloorAnchor: reminderMessageAnchor(boundary),
    });
    expect(restoreWindowCheckpoint([entry(saved)], win, messages, key)).toBe(true);
    expect(win.frozenFloorCutoff).toBe(2);
    expect(win.projectedFloorAnchor).toBe('entry:2');
  });

  it('does not turn missing anchors or untrusted numeric cutoffs into stale indexes', () => {
    const win = createWindowState();
    win.frozenFloorCutoff = 9;
    win.projectedFloorAnchor = 'old';
    win.lastSentEstChars = 120000;
    const saved = { ...checkpoint({ floorAnchor: 'missing', projectedFloorAnchor: 'missing' }), frozenFloorCutoff: 1 };
    expect(restoreWindowCheckpoint([entry(saved)], win, [user(1), user(2)], key)).toBe(true);
    expect(win.frozenFloorCutoff).toBe(0);
    expect(win.projectedFloorAnchor).toBeUndefined();
    expect(win.charsPerToken).toBe(2);
    expect(win.lastSentEstChars).toBe(0);
  });

  it('requires a user boundary for the raw floor but permits a custom projected trigger', () => {
    const trigger: ReminderMessage = { role: 'custom', content: 'trigger', cacheReminderEntryId: 'custom' };
    const messages = [user(1), trigger];
    const win = createWindowState();
    expect(
      restoreWindowCheckpoint(
        [entry(checkpoint({ floorAnchor: 'custom', projectedFloorAnchor: 'custom' }))],
        win,
        messages,
        key,
      ),
    ).toBe(true);
    expect(win.frozenFloorCutoff).toBe(0);
    expect(win.projectedFloorAnchor).toBe('custom');
  });

  it.each([0, -1, 0.5, 2, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not persist an invalid raw boundary %s',
    (cutoff) => {
      const win = createWindowState();
      win.frozenFloorCutoff = cutoff;
      expect(createWindowCheckpoint(win, [user(1), user(2)], key)).not.toHaveProperty('floorAnchor');
    },
  );

  it('does not persist a non-user raw boundary', () => {
    const win = createWindowState();
    win.frozenFloorCutoff = 1;
    expect(createWindowCheckpoint(win, [user(1), { role: 'assistant', content: 'answer' }], key)).not.toHaveProperty(
      'floorAnchor',
    );
  });

  it('invalidates both pre-compaction anchors even if their messages remain, retaining calibration only', () => {
    const messages = [user(1), user(2)];
    const win = createWindowState();
    win.lastSentEstChars = 120000;
    win.frozenFloorCutoff = 1;
    win.projectedFloorAnchor = 'entry:2';
    const entries = [
      entry(checkpoint({ floorAnchor: 'entry:2', projectedFloorAnchor: 'entry:2' })),
      { type: 'compaction' },
      entry({ version: 99 }),
    ];
    expect(restoreWindowCheckpoint(entries, win, messages, key)).toBe(true);
    expect(win.frozenFloorCutoff).toBe(0);
    expect(win.projectedFloorAnchor).toBeUndefined();
    expect(win.charsPerToken).toBe(2);
    expect(win.lastSentEstChars).toBe(0);
  });

  it('accepts a newer valid floor recorded after compaction', () => {
    const win = createWindowState();
    const entries = [
      entry(checkpoint({ charsPerToken: 3 })),
      { type: 'compaction' },
      entry(checkpoint({ floorAnchor: 'entry:2', projectedFloorAnchor: 'entry:2' })),
    ];
    expect(restoreWindowCheckpoint(entries, win, [user(1), user(2)], key)).toBe(true);
    expect(win.frozenFloorCutoff).toBe(1);
    expect(win.projectedFloorAnchor).toBe('entry:2');
    expect(win.charsPerToken).toBe(2);
  });

  it('stops at newscene even when newer checkpoints are malformed', () => {
    const win = createWindowState();
    const before = { ...win };
    const entries = [
      entry(checkpoint()),
      { type: 'custom', customType: 'roleplay-newscene' },
      { type: 'compaction' },
      entry({ version: 99 }),
    ];
    expect(restoreWindowCheckpoint(entries, win, [], key)).toBe(false);
    expect(win).toEqual(before);
    expect(restoreWindowCheckpoint([...entries, entry(checkpoint())], win, [], key)).toBe(true);
  });

  it.each(['cast', 'provider', 'model'] as const)('never resurrects older state after a different %s', (field) => {
    const win = createWindowState();
    const before = { ...win };
    const entries = [entry(checkpoint()), entry(checkpoint({ [field]: 'other' }))];
    expect(restoreWindowCheckpoint(entries, win, [], key)).toBe(false);
    expect(win).toEqual(before);
  });

  it.each([
    null,
    [],
    'checkpoint',
    { version: 2 },
    { cast: '' },
    { cast: 1 },
    { provider: ' ' },
    { model: null },
    { charsPerToken: 0.99 },
    { charsPerToken: 20.01 },
    { charsPerToken: Number.NaN },
    { charsPerToken: Number.POSITIVE_INFINITY },
    { charsPerToken: '2' },
    { floorAnchor: '' },
    { floorAnchor: 1 },
    { projectedFloorAnchor: ' ' },
    { projectedFloorAnchor: null },
  ])('skips malformed newest checkpoint %j', (invalid) => {
    const data =
      invalid !== null && typeof invalid === 'object' && !Array.isArray(invalid)
        ? { ...checkpoint(), ...invalid }
        : invalid;
    const win = createWindowState();
    expect(restoreWindowCheckpoint([entry(data)], win, [], key)).toBe(false);
    expect(restoreWindowCheckpoint([entry(checkpoint()), entry(data)], win, [], key)).toBe(true);
    expect(win.charsPerToken).toBe(2);
  });

  it.each([1, 20])('accepts calibration at the valid boundary %s', (charsPerToken) => {
    const win = createWindowState();
    expect(restoreWindowCheckpoint([entry(checkpoint({ charsPerToken }))], win, [], key)).toBe(true);
    expect(win.charsPerToken).toBe(charsPerToken);
  });

  it('ignores untyped data and returns false for an empty branch', () => {
    const win = createWindowState();
    expect(restoreWindowCheckpoint([], win, [], key)).toBe(false);
    expect(restoreWindowCheckpoint([{ type: 'message', data: checkpoint() }], win, [], key)).toBe(false);
    expect(restoreWindowCheckpoint([{ type: 'custom', customType: 'other', data: checkpoint() }], win, [], key)).toBe(
      false,
    );
  });

  it('does not mutate creation inputs or restoration entries, messages, or key', () => {
    const messages = Object.freeze([Object.freeze(user(1)), Object.freeze(user(2))]);
    const frozenKey = Object.freeze({ ...key });
    const win = createWindowState();
    win.frozenFloorCutoff = 1;
    win.projectedFloorAnchor = 'entry:2';
    win.lastSentEstChars = 60000;
    const before = { ...win };
    const saved = Object.freeze(createWindowCheckpoint(Object.freeze(win), messages, frozenKey));
    expect(win).toEqual(before);
    const entries = Object.freeze([Object.freeze(entry(saved))]);
    const fresh = createWindowState();
    expect(restoreWindowCheckpoint(entries, fresh, messages, frozenKey)).toBe(true);
    expect(entries).toEqual([entry(saved)]);
    expect(messages).toEqual([user(1), user(2)]);
    expect(frozenKey).toEqual(key);
    expect(saved).toEqual(checkpoint({ charsPerToken: 4, floorAnchor: 'entry:2', projectedFloorAnchor: 'entry:2' }));
    expect(fresh.recapText).toBe('');
    expect(fresh.lastSentEstChars).toBe(0);
  });
});
