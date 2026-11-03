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

  test('whole-message trim skips non-text/non-image parts (preserves tool calls)', () => {
    const messages: LooseMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking about it' },
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { cmd: 'ls' } },
        ],
        timestamp: 7,
      },
    ];
    const { messages: out, applied } = applyDirectives(messages, [
      { kind: 'trim', id: 1, target: { by: 'message', role: 'assistant', timestamp: 7 }, createdAt: 1 },
    ]);
    expect(applied).toBe(1);
    const parts = out[0].content as LoosePart[];
    // Text part collapses to a placeholder…
    expect(parts[0].type).toBe('text');
    expect(isPlaceholder((parts[0] as { text: string }).text)).toBe(true);
    // …but the toolCall part is left intact so the call/result pairing survives.
    expect(parts[1].type).toBe('toolCall');
    expect((parts[1] as { name: string }).name).toBe('bash');
    expect((parts[1] as { arguments: Record<string, unknown> }).arguments).toEqual({ cmd: 'ls' });
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

describe('applyDirectives - edit safety', () => {
  test('merges multiple text parts at the first text position and preserves mixed images and metadata', () => {
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png', width: 10 };
    const messages: LooseMessage[] = [
      {
        role: 'user',
        timestamp: 5,
        custom: { keep: true },
        content: [
          image,
          { type: 'text', text: 'first', textSignature: 'sig' },
          image,
          { type: 'text', text: 'second' },
          image,
        ],
      },
    ];
    const before = structuredClone(messages);
    const {
      messages: out,
      applied,
      stale,
    } = applyDirectives(messages, [
      {
        kind: 'edit',
        id: 1,
        target: { by: 'message', role: 'user', timestamp: 5 },
        text: 'merged\ntext',
        createdAt: 1,
      },
    ]);
    expect(applied).toBe(1);
    expect(stale).toEqual([]);
    expect(out[0]).toEqual({
      ...messages[0],
      content: [
        image,
        { type: 'text', text: 'merged\ntext', textSignature: 'sig' },
        image,
        { type: 'text', text: '' },
        image,
      ],
    });
    expect(messages).toEqual(before);
    expect(out[0]).not.toBe(messages[0]);
    expect((out[0].content as LoosePart[])[0]).not.toBe(image);
  });

  test('preserves thinking, tool calls and paired results in their original relative order', () => {
    const thinking = { type: 'thinking', thinking: 'reasoning', signature: 'signed' };
    const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } };
    const messages: LooseMessage[] = [
      {
        role: 'assistant',
        timestamp: 5,
        model: 'test',
        usage: { output: 10 },
        content: [thinking, { type: 'text', text: 'first' }, call, { type: 'text', text: 'last' }, thinking],
      },
      { role: 'toolResult', timestamp: 6, toolCallId: 'c1', toolName: 'bash', content: 'result' },
    ];
    const before = structuredClone(messages);
    const { messages: out, applied } = applyDirectives(messages, [
      { kind: 'edit', id: 1, target: { by: 'message', role: 'assistant', timestamp: 5 }, text: 'edited', createdAt: 1 },
    ]);
    expect(applied).toBe(1);
    expect(out[0]).toEqual({
      ...messages[0],
      content: [thinking, { type: 'text', text: 'edited' }, call, { type: 'text', text: '' }, thinking],
    });
    expect(out[1]).toEqual(messages[1]);
    expect(messages).toEqual(before);
  });

  test('retains content indices so a subsequent image trim still targets the same block', () => {
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    const messages: LooseMessage[] = [
      {
        role: 'user',
        timestamp: 5,
        content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }, image],
      },
    ];
    const edited = applyDirectives(messages, [
      { kind: 'edit', id: 1, target: { by: 'message', role: 'user', timestamp: 5 }, text: 'merged', createdAt: 1 },
    ]);
    const trimmed = applyDirectives(edited.messages, [
      { kind: 'trim', id: 1, target: { by: 'message', role: 'user', timestamp: 5, partIndex: 2 }, createdAt: 1 },
    ]);
    expect(edited.messages[0].content).toEqual([{ type: 'text', text: 'merged' }, { type: 'text', text: '' }, image]);
    expect(trimmed.applied).toBe(1);
    expect((trimmed.messages[0].content as LoosePart[])[2].type).toBe('text');
  });

  test('keeps an empty replacement as a real text part alongside images', () => {
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    const messages: LooseMessage[] = [{ role: 'user', timestamp: 5, content: [image, { type: 'text', text: 'old' }] }];
    const {
      messages: out,
      applied,
      stale,
    } = applyDirectives(messages, [
      { kind: 'edit', id: 1, target: { by: 'message', role: 'user', timestamp: 5 }, text: '', createdAt: 1 },
    ]);
    expect(applied).toBe(1);
    expect(stale).toEqual([]);
    expect(out[0].content).toEqual([image, { type: 'text', text: '' }]);
  });

  test.each([
    { content: [] },
    { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
    {
      content: [
        { type: 'thinking', text: 'not a text part' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
      ],
    },
  ])('refuses whole-message edits of no-text content %j', ({ content }) => {
    const messages: LooseMessage[] = [{ role: 'assistant', timestamp: 5, content }];
    const {
      messages: out,
      applied,
      stale,
    } = applyDirectives(messages, [
      {
        kind: 'edit',
        id: 7,
        target: { by: 'message', role: 'assistant', timestamp: 5 },
        text: 'replacement',
        createdAt: 1,
      },
    ]);
    expect(applied).toBe(0);
    expect(stale).toEqual([7]);
    expect(out).toEqual(messages);
  });

  test('leaves part-scoped behavior unchanged and does not merge neighboring text', () => {
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    const messages: LooseMessage[] = [
      {
        role: 'user',
        timestamp: 5,
        content: [{ type: 'text', text: 'first' }, image, { type: 'text', text: 'second', signature: 's' }],
      },
    ];
    const {
      messages: out,
      applied,
      stale,
    } = applyDirectives(messages, [
      {
        kind: 'edit',
        id: 1,
        target: { by: 'message', role: 'user', timestamp: 5, partIndex: 2 },
        text: '',
        createdAt: 1,
      },
      {
        kind: 'edit',
        id: 2,
        target: { by: 'message', role: 'user', timestamp: 5, partIndex: 1 },
        text: 'not image',
        createdAt: 1,
      },
    ]);
    expect(applied).toBe(1);
    expect(stale).toEqual([2]);
    expect(out[0].content).toEqual([
      { type: 'text', text: 'first' },
      image,
      { type: 'text', text: '', signature: 's' },
    ]);
    expect(text(messages[0], 2)).toBe('second');
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
