/**
 * Tests for the cross-extension avatar-input slot (`input.ts`).
 *
 * The slot is globalThis-anchored, so each test resets it via
 * `clearAvatarInput()` to stay independent.
 */

import { beforeEach, expect, test } from 'vitest';

import {
  clearAvatarInput,
  getAvatarInput,
  getAvatarInputRev,
  setAvatarInput,
} from '../../../../../lib/node/pi/avatar/input.ts';

beforeEach(() => {
  clearAvatarInput();
});

test('starts empty', () => {
  expect(getAvatarInput()).toEqual({});
});

test('setAvatarInput stores a trimmed emote-set and bumps rev', () => {
  const before = getAvatarInputRev();
  setAvatarInput({ emoteSet: '  exusiai  ' });
  expect(getAvatarInput().emoteSet).toBe('exusiai');
  expect(getAvatarInputRev()).toBe(before + 1);
});

test('an empty / falsy emoteSet clears only the set, leaving the image', () => {
  setAvatarInput({ emoteSet: 'exusiai', image: { path: '/p/portrait.png' } });
  setAvatarInput({ emoteSet: '' });
  expect(getAvatarInput().emoteSet).toBeUndefined();
  expect(getAvatarInput().image).toEqual({ path: '/p/portrait.png' });
});

test('patch semantics: an absent key is left untouched', () => {
  setAvatarInput({ emoteSet: 'exusiai' });
  setAvatarInput({ image: { path: '/p/scene.png', width: 40 } });
  expect(getAvatarInput()).toEqual({ emoteSet: 'exusiai', image: { path: '/p/scene.png', width: 40 } });
});

test('setting a falsy image clears the override', () => {
  setAvatarInput({ image: { path: '/p/x.png' } });
  setAvatarInput({ image: undefined });
  expect(getAvatarInput().image).toBeUndefined();
});

test('rev advances on every mutation including clear', () => {
  const r0 = getAvatarInputRev();
  setAvatarInput({ emoteSet: 'a' });
  setAvatarInput({ emoteSet: 'b' });
  const r2 = getAvatarInputRev();
  expect(r2).toBe(r0 + 2);
  clearAvatarInput();
  expect(getAvatarInputRev()).toBe(r2 + 1);
  expect(getAvatarInput()).toEqual({});
});
