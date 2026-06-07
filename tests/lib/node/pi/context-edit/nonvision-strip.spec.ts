/**
 * Tests for lib/node/pi/context-edit/nonvision-strip.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import { applyDirectives } from '../../../../../lib/node/pi/context-edit/apply.ts';
import {
  NONVISION_STRIP_REASON,
  selectNonVisionStrip,
} from '../../../../../lib/node/pi/context-edit/nonvision-strip.ts';
import { resolveTarget, type LooseMessage, type LoosePart } from '../../../../../lib/node/pi/context-edit/target.ts';

const img = (data = 'aaaa'): LoosePart => ({ type: 'image', data, mimeType: 'image/png' });

const genCall = (id: string, name: string, prompt: string): LooseMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: { prompt } }],
  timestamp: 1,
});

const imageResult = (id: string, toolName: string, parts: LoosePart[]): LooseMessage => ({
  role: 'toolResult',
  toolCallId: id,
  toolName,
  content: parts,
  timestamp: 2,
});

const userImage = (ts: number, parts: LoosePart[]): LooseMessage => ({
  role: 'user',
  content: parts,
  timestamp: ts,
});

describe('selectNonVisionStrip', () => {
  test('no image parts -> empty', () => {
    const messages: LooseMessage[] = [
      { role: 'user', content: 'hello', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 2 },
    ];
    expect(selectNonVisionStrip(messages)).toEqual([]);
  });

  test('strips a generated-image tool result with its generation prompt as description', () => {
    const messages: LooseMessage[] = [
      genCall('c1', 'generate_image', 'a red fox in snow'),
      imageResult('c1', 'generate_image', [img()]),
    ];
    const dirs = selectNonVisionStrip(messages);
    expect(dirs).toHaveLength(1);
    const [d] = dirs;
    expect(d.kind).toBe('trim');
    expect(d.reason).toBe(NONVISION_STRIP_REASON);
    expect(d.description).toBe('a red fox in snow');
    expect(d.createdAt).toBe(0);
    expect(d.id).toBeLessThan(0);
    expect(d.target).toEqual({ by: 'toolCallId', toolCallId: 'c1', partIndex: 0 });
  });

  test('observed (pasted) user image strips to a size-only placeholder (no description)', () => {
    const messages: LooseMessage[] = [userImage(5, [{ type: 'text', text: 'look' }, img()])];
    const dirs = selectNonVisionStrip(messages);
    expect(dirs).toHaveLength(1);
    const [d] = dirs;
    expect(d.description).toBeUndefined();
    expect(d.target).toEqual({ by: 'message', role: 'user', timestamp: 5, occurrence: 0, partIndex: 1 });
  });

  test('strips multiple image parts within one tool result, each targeting its part index', () => {
    const messages: LooseMessage[] = [
      genCall('c1', 'comfyui', 'two cats'),
      imageResult('c1', 'comfyui', [img('a'), { type: 'text', text: 'done' }, img('b')]),
    ];
    const dirs = selectNonVisionStrip(messages);
    expect(dirs.map((d) => d.target)).toEqual([
      { by: 'toolCallId', toolCallId: 'c1', partIndex: 0 },
      { by: 'toolCallId', toolCallId: 'c1', partIndex: 2 },
    ]);
    // Distinct (negative) ids so applyDirectives keeps them separate.
    expect(new Set(dirs.map((d) => d.id)).size).toBe(2);
  });

  test('skips a tool-result image when the result carries no toolCallId', () => {
    const messages: LooseMessage[] = [{ role: 'toolResult', toolName: 'x', content: [img()], timestamp: 2 }];
    expect(selectNonVisionStrip(messages)).toEqual([]);
  });

  test('occurrence counter aligns same-(role,timestamp) message targets', () => {
    const messages: LooseMessage[] = [userImage(7, [img('first')]), userImage(7, [img('second')])];
    const dirs = selectNonVisionStrip(messages);
    expect(dirs.map((d) => d.target)).toEqual([
      { by: 'message', role: 'user', timestamp: 7, occurrence: 0, partIndex: 0 },
      { by: 'message', role: 'user', timestamp: 7, occurrence: 1, partIndex: 0 },
    ]);
    // Each target resolves back to exactly the message we saw.
    expect(resolveTarget(messages, dirs[0].target)).toEqual({ messageIndex: 0, partIndex: 0 });
    expect(resolveTarget(messages, dirs[1].target)).toEqual({ messageIndex: 1, partIndex: 0 });
  });

  test('end-to-end: applyDirectives turns each image into an [IMAGE REMOVED] placeholder, leaving text intact', () => {
    const messages: LooseMessage[] = [
      genCall('c1', 'generate_image', 'a red fox in snow'),
      imageResult('c1', 'generate_image', [{ type: 'text', text: 'kept text' }, img()]),
    ];
    const dirs = selectNonVisionStrip(messages);
    const { messages: out, applied } = applyDirectives(messages, dirs);
    expect(applied).toBe(1);
    const result = out[1];
    const parts = result.content as { type: string; text?: string }[];
    expect(parts[0]).toEqual({ type: 'text', text: 'kept text' });
    expect(parts[1].type).toBe('text');
    expect(parts[1].text).toContain('IMAGE REMOVED');
    expect(parts[1].text).toContain('a red fox in snow');
    expect(parts[1].text).toContain(NONVISION_STRIP_REASON);
  });
});
