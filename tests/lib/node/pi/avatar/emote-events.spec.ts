/**
 * Tests for the cross-extension avatar emote contract (`emote-events.ts`):
 * the bus-channel constant, the `isEmoteSignal` payload validator (used to
 * narrow the untyped `pi.events` payload), and the pure persisted-entry
 * reader `collectLoggedEmotes`.
 *
 * Transport itself is pi's shared `EventBus` (emit in `avatar.ts`, subscribe
 * in `tts.ts`), so there is nothing stateful to reset here.
 */

import { expect, test } from 'vitest';

import {
  AVATAR_EMOTE_CHANNEL,
  AVATAR_EMOTE_ENTRY_TYPE,
  collectLoggedEmotes,
  type EmoteSignal,
  isEmoteSignal,
} from '../../../../../lib/node/pi/avatar/emote-events.ts';

const signal = (over: Partial<EmoteSignal> = {}): EmoteSignal => ({
  emote: 'happy',
  emotes: ['happy'],
  at: 1000,
  ...over,
});

test('AVATAR_EMOTE_CHANNEL is the namespaced bus channel', () => {
  expect(AVATAR_EMOTE_CHANNEL).toBe('avatar:emote');
});

test('isEmoteSignal accepts a well-formed signal', () => {
  expect(isEmoteSignal(signal({ emote: 'sad', emotes: ['happy', 'sad'], at: 42 }))).toBe(true);
});

test('isEmoteSignal rejects malformed / foreign payloads', () => {
  expect(isEmoteSignal(null)).toBe(false);
  expect(isEmoteSignal(undefined)).toBe(false);
  expect(isEmoteSignal('happy')).toBe(false);
  expect(isEmoteSignal({ emote: 'sad' })).toBe(false); // no emotes / at
  expect(isEmoteSignal({ emote: 'sad', emotes: 'happy', at: 1 })).toBe(false); // emotes not array
  expect(isEmoteSignal({ emote: 'sad', emotes: [1, 2], at: 1 })).toBe(false); // non-string entries
  expect(isEmoteSignal({ emote: 'sad', emotes: ['sad'], at: '1' })).toBe(false); // at not number
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
