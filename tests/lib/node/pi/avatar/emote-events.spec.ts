/**
 * Tests for the cross-extension avatar emote signal (`emote-events.ts`):
 * the globalThis-anchored event bus and the pure persisted-entry reader.
 *
 * The bus is globalThis-anchored, so each test resets it via
 * `resetEmoteBus()` to stay independent.
 */

import { beforeEach, expect, test, vi } from 'vitest';

import {
  AVATAR_EMOTE_ENTRY_TYPE,
  collectLoggedEmotes,
  type EmoteSignal,
  emitEmote,
  getLastEmote,
  resetEmoteBus,
  subscribeEmote,
} from '../../../../../lib/node/pi/avatar/emote-events.ts';

const signal = (over: Partial<EmoteSignal> = {}): EmoteSignal => ({
  emote: 'happy',
  emotes: ['happy'],
  at: 1000,
  ...over,
});

beforeEach(() => {
  resetEmoteBus();
});

test('starts with no last emote', () => {
  expect(getLastEmote()).toBeUndefined();
});

test('emitEmote notifies subscribers and records the last signal', () => {
  const seen: EmoteSignal[] = [];
  subscribeEmote((s) => seen.push(s));
  const s = signal({ emote: 'sad', emotes: ['happy', 'sad'], at: 42 });
  emitEmote(s);
  expect(seen).toEqual([s]);
  expect(getLastEmote()).toEqual(s);
});

test('multiple subscribers all fire', () => {
  const a = vi.fn();
  const b = vi.fn();
  subscribeEmote(a);
  subscribeEmote(b);
  emitEmote(signal());
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(1);
});

test('unsubscribe stops further delivery', () => {
  const fn = vi.fn();
  const off = subscribeEmote(fn);
  emitEmote(signal());
  off();
  emitEmote(signal({ emote: 'angry', emotes: ['angry'] }));
  expect(fn).toHaveBeenCalledTimes(1);
});

test('a throwing subscriber does not break the emitter or other listeners', () => {
  const good = vi.fn();
  subscribeEmote(() => {
    throw new Error('boom');
  });
  subscribeEmote(good);
  expect(() => emitEmote(signal())).not.toThrow();
  expect(good).toHaveBeenCalledTimes(1);
  // last is still recorded despite the throwing listener.
  expect(getLastEmote()).toEqual(signal());
});

test('collectLoggedEmotes returns well-formed records in order, skipping noise', () => {
  const entries = [
    { type: 'message', message: { role: 'assistant' } },
    { type: 'custom', customType: AVATAR_EMOTE_ENTRY_TYPE, data: signal({ emote: 'happy', emotes: ['happy'], at: 1 }) },
    { type: 'custom', customType: 'other-extension', data: signal() },
    { type: 'custom', customType: AVATAR_EMOTE_ENTRY_TYPE, data: { emote: 'sad' } /* malformed: no emotes/at */ },
    {
      type: 'custom',
      customType: AVATAR_EMOTE_ENTRY_TYPE,
      data: signal({ emote: 'cool', emotes: ['smug', 'cool'], at: 2 }),
    },
  ];
  expect(collectLoggedEmotes(entries)).toEqual([
    { emote: 'happy', emotes: ['happy'], at: 1 },
    { emote: 'cool', emotes: ['smug', 'cool'], at: 2 },
  ]);
});

test('collectLoggedEmotes copies the emotes array (no shared reference)', () => {
  const data = signal({ emotes: ['happy', 'sad'] });
  const entries = [{ type: 'custom', customType: AVATAR_EMOTE_ENTRY_TYPE, data }];
  const [out] = collectLoggedEmotes(entries);
  expect(out.emotes).toEqual(['happy', 'sad']);
  expect(out.emotes).not.toBe(data.emotes);
});
