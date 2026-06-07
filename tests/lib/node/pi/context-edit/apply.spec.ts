/**
 * Tests for lib/node/pi/context-edit/apply.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import { applyDirectives } from '../../../../../lib/node/pi/context-edit/apply.ts';
import type { Directive } from '../../../../../lib/node/pi/context-edit/directive.ts';
import { isPlaceholder } from '../../../../../lib/node/pi/context-edit/placeholder.ts';
import type { LooseMessage, LoosePart } from '../../../../../lib/node/pi/context-edit/target.ts';

const text = (m: LooseMessage, i = 0): string => {
  const parts: LoosePart[] = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
  const p = parts[i];
  return p.type === 'text' ? (p as { text: string }).text : '';
};

describe('applyDirectives - trim', () => {
  test('replaces an image part with a placeholder text part', () => {
    const messages: LooseMessage[] = [
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'comfyui',
        content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
        timestamp: 1,
      },
    ];
    const directives: Directive[] = [
      { kind: 'trim', id: 1, target: { by: 'toolCallId', toolCallId: 'c1' }, createdAt: 1 },
    ];
    const { messages: out, applied, stale } = applyDirectives(messages, directives);
    expect(applied).toBe(1);
    expect(stale).toEqual([]);
    const part = (out[0].content as LoosePart[])[0];
    expect(part.type).toBe('text');
    expect(isPlaceholder((part as { text: string }).text)).toBe(true);
    expect((part as { text: string }).text).toContain('IMAGE REMOVED');
  });

  test('stamps a persisted image description (and dimensions) into the placeholder', () => {
    const messages: LooseMessage[] = [
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'generate_image',
        content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png', width: 1024, height: 768 }],
        timestamp: 1,
      },
    ];
    const directives: Directive[] = [
      {
        kind: 'trim',
        id: 1,
        target: { by: 'toolCallId', toolCallId: 'c1' },
        description: 'a red fox in snow',
        createdAt: 1,
      },
    ];
    const { messages: out } = applyDirectives(messages, directives);
    const rendered = (out[0].content as LoosePart[])[0] as { text: string };
    expect(rendered.text).toContain('1024\u00d7768');
    expect(rendered.text).toContain('"a red fox in snow"');
  });

  test('does not mutate the input messages', () => {
    const messages: LooseMessage[] = [{ role: 'user', content: 'original', timestamp: 1 }];
    applyDirectives(messages, [
      { kind: 'trim', id: 1, target: { by: 'message', role: 'user', timestamp: 1 }, createdAt: 1 },
    ]);
    expect(messages[0].content).toBe('original');
  });

  test('reports a stale directive whose target no longer resolves', () => {
    const messages: LooseMessage[] = [{ role: 'user', content: 'hi', timestamp: 1 }];
    const { applied, stale } = applyDirectives(messages, [
      { kind: 'trim', id: 7, target: { by: 'toolCallId', toolCallId: 'gone' }, createdAt: 1 },
    ]);
    expect(applied).toBe(0);
    expect(stale).toEqual([7]);
  });
});

describe('applyDirectives - edit', () => {
  test('replaces a whole user message with the edited text', () => {
    const messages: LooseMessage[] = [{ role: 'user', content: 'typo', timestamp: 5 }];
    const { messages: out } = applyDirectives(messages, [
      { kind: 'edit', id: 1, target: { by: 'message', role: 'user', timestamp: 5 }, text: 'fixed', createdAt: 1 },
    ]);
    expect(text(out[0])).toBe('fixed');
  });

  test('last edit on the same target wins by id order', () => {
    const messages: LooseMessage[] = [{ role: 'user', content: 'v0', timestamp: 5 }];
    const { messages: out } = applyDirectives(messages, [
      { kind: 'edit', id: 2, target: { by: 'message', role: 'user', timestamp: 5 }, text: 'v2', createdAt: 2 },
      { kind: 'edit', id: 1, target: { by: 'message', role: 'user', timestamp: 5 }, text: 'v1', createdAt: 1 },
    ]);
    expect(text(out[0])).toBe('v2');
  });
});

describe('applyDirectives - collapse', () => {
  test('blanks the call arguments and replaces the result with a marker', () => {
    const messages: LooseMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { cmd: 'sleep 1' } }],
        timestamp: 1,
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'huge output' }],
        timestamp: 2,
      },
    ];
    const { messages: out, applied } = applyDirectives(messages, [
      { kind: 'collapse', id: 1, toolCallId: 'c1', reason: 'background job', createdAt: 1 },
    ]);
    expect(applied).toBe(1);
    const call = (out[0].content as LoosePart[])[0] as { arguments: Record<string, unknown> };
    expect(call.arguments).toEqual({});
    const result = text(out[1]);
    expect(isPlaceholder(result)).toBe(true);
    expect(result).toContain('TOOL CALLED');
    expect(result).toContain('background job');
  });

  test('tolerates a sibling message whose content is null (tool-call-only assistant)', () => {
    // pi can hand us content that is neither string nor array; copying such a
    // message must not throw "parts is not iterable".
    const messages: LooseMessage[] = [
      { role: 'assistant', content: null as unknown as string, timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { cmd: 'sleep 1' } }],
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'huge output' }],
        timestamp: 3,
      },
    ];
    const { messages: out, applied } = applyDirectives(messages, [
      { kind: 'collapse', id: 1, toolCallId: 'c1', reason: 'background job', createdAt: 1 },
    ]);
    expect(applied).toBe(1);
    expect(out[0].content).toEqual([]);
    expect(isPlaceholder(text(out[2]))).toBe(true);
  });
});
