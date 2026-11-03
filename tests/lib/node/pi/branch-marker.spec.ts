/** Tests for the shared session-branch nudge marker detector. */

import { expect, test } from 'vitest';

import { type BranchEntry, lastUserMessageHasMarker } from '../../../../lib/node/pi/branch-marker.ts';

const MARKER = '⚠ [test-marker]';
const CUSTOM_TYPE = 'todo-guardrail-nudge';

const user = (text: string): BranchEntry => ({
  type: 'message',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const assistant: BranchEntry = {
  type: 'message',
  message: { role: 'assistant', content: 'working' },
};

test('lastUserMessageHasMarker: marker on latest user message → true', () => {
  const branch: BranchEntry[] = [user(`${MARKER} hello`)];

  expect(lastUserMessageHasMarker(branch, MARKER)).toBe(true);
});

test('lastUserMessageHasMarker: marker missing → false', () => {
  const branch: BranchEntry[] = [user('hello')];

  expect(lastUserMessageHasMarker(branch, MARKER)).toBe(false);
});

test('lastUserMessageHasMarker: only the MOST RECENT user message is checked', () => {
  const branch: BranchEntry[] = [user(`${MARKER} old nudge`), assistant, user('fresh prompt')];

  expect(lastUserMessageHasMarker(branch, MARKER)).toBe(false);
});

test('lastUserMessageHasMarker: no user messages → false', () => {
  expect(lastUserMessageHasMarker([], MARKER)).toBe(false);
  expect(lastUserMessageHasMarker([assistant], MARKER)).toBe(false);
});

test('lastUserMessageHasMarker: string-content user messages too', () => {
  const branch: BranchEntry[] = [
    {
      type: 'message',
      message: { role: 'user', content: `${MARKER} inline` },
    },
  ];

  expect(lastUserMessageHasMarker(branch, MARKER)).toBe(true);
});

test('lastUserMessageHasMarker: matching nudge customType on most recent boundary → true', () => {
  const branch: BranchEntry[] = [user('do it'), assistant, { type: 'custom', customType: CUSTOM_TYPE }];

  expect(lastUserMessageHasMarker(branch, MARKER, CUSTOM_TYPE)).toBe(true);
});

test('lastUserMessageHasMarker: another extension nudge is a boundary but not ours → false', () => {
  const branch: BranchEntry[] = [
    user(`${MARKER} earlier`),
    assistant,
    { type: 'custom', customType: 'stall-recovery-steer' },
  ];

  expect(lastUserMessageHasMarker(branch, MARKER, CUSTOM_TYPE)).toBe(false);
});

test('lastUserMessageHasMarker: state-mirror customs are NOT boundaries', () => {
  const branch: BranchEntry[] = [
    user(`${MARKER} hello`),
    { type: 'custom', customType: 'todo-state' },
    assistant,
    { type: 'custom', customType: 'scratchpad-state' },
  ];

  expect(lastUserMessageHasMarker(branch, MARKER, CUSTOM_TYPE)).toBe(true);
});

test('lastUserMessageHasMarker: nudge boundary without ownCustomType → false', () => {
  const branch: BranchEntry[] = [user(`${MARKER} earlier`), { type: 'custom', customType: CUSTOM_TYPE }];

  expect(lastUserMessageHasMarker(branch, MARKER)).toBe(false);
});
