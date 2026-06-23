/**
 * Tests for lib/node/pi/comfyui/scene-context.ts: bounded recent-turn
 * capture + manual/captured context merge.
 */

import { expect, test } from 'vitest';

import {
  extractSceneContext,
  mergeSceneContext,
  type SceneMessage,
} from '../../../../../lib/node/pi/comfyui/scene-context.ts';

const convo: SceneMessage[] = [
  { role: 'user', content: 'It is night and raining.' },
  { role: 'assistant', content: 'Aria pulls her cloak tighter.' },
  { role: 'user', content: 'Draw her in the doorway.' },
];

test('returns empty when capture is off or budget non-positive', () => {
  expect(extractSceneContext(convo, 0)).toBe('');
  expect(extractSceneContext(convo, -5)).toBe('');
  expect(extractSceneContext(convo, NaN)).toBe('');
  expect(extractSceneContext(undefined, 100)).toBe('');
});

test('captures recent user/assistant turns in chronological order with labels', () => {
  expect(extractSceneContext(convo, 1000)).toBe(
    [
      'User: It is night and raining.',
      'Assistant: Aria pulls her cloak tighter.',
      'User: Draw her in the doorway.',
    ].join('\n'),
  );
});

test('skips tool-result / system roles and empty (tool-call-only) turns', () => {
  const msgs: SceneMessage[] = [
    { role: 'system', content: 'You are a roleplay GM.' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: [{ type: 'toolCall', name: 'x' }] }, // no text → skipped
    { role: 'toolResult', content: 'big tool output' },
    { role: 'assistant', content: [{ type: 'text', text: 'A reply.' }] },
  ];
  expect(extractSceneContext(msgs, 1000)).toBe('User: Hi\nAssistant: A reply.');
});

test('honors the char budget, keeping the most recent turns', () => {
  // Budget fits only the last turn (+ none of the earlier ones).
  const out = extractSceneContext(convo, 30);
  expect(out).toBe('User: Draw her in the doorway.');
});

test('tail-truncates a single most-recent turn that alone exceeds the budget', () => {
  const big: SceneMessage[] = [{ role: 'user', content: 'x'.repeat(500) }];
  const out = extractSceneContext(big, 40);
  expect(out.length).toBe(40);
  expect(out.endsWith('x')).toBe(true); // newest text retained
});

test('strips spliced system-reminder blocks from captured text', () => {
  const msgs: SceneMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Scene text.' },
        { type: 'text', text: '<system-reminder id="todo">plan stuff</system-reminder>' },
      ],
    },
  ];
  expect(extractSceneContext(msgs, 1000)).toBe('User: Scene text.');
});

test('mergeSceneContext: manual leads, captured follows under a label', () => {
  expect(mergeSceneContext('night, rain', 'User: hi')).toBe(
    'night, rain\n\nRecent conversation (for continuity):\nUser: hi',
  );
  expect(mergeSceneContext('night, rain', undefined)).toBe('night, rain');
  expect(mergeSceneContext('  ', 'User: hi')).toBe('Recent conversation (for continuity):\nUser: hi');
  expect(mergeSceneContext(undefined, '')).toBeUndefined();
});
