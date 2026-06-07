/**
 * Tests for lib/node/pi/context-edit/enumerate.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import { candidateLabel, enumerate } from '../../../../../lib/node/pi/context-edit/enumerate.ts';
import { textPlaceholder } from '../../../../../lib/node/pi/context-edit/placeholder.ts';
import type { LooseMessage } from '../../../../../lib/node/pi/context-edit/target.ts';

const big = 'x'.repeat(5000);

describe('enumerate', () => {
  test('lists images, large tool results, tool calls, and messages', () => {
    const messages: LooseMessage[] = [
      { role: 'user', content: 'please render a cat', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'comfyui', arguments: { prompt: 'cat' } }],
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'comfyui',
        content: [{ type: 'image', data: 'A'.repeat(4000), mimeType: 'image/png' }],
        timestamp: 3,
      },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c2', name: 'bash', arguments: { cmd: 'cat huge' } }],
        timestamp: 4,
      },
      { role: 'toolResult', toolCallId: 'c2', toolName: 'bash', content: [{ type: 'text', text: big }], timestamp: 5 },
    ];
    const cands = enumerate(messages);
    const kinds = new Set(cands.map((c) => c.kind));
    expect(kinds.has('image')).toBe(true);
    expect(kinds.has('tool-result')).toBe(true);
    expect(kinds.has('tool-call')).toBe(true);
    expect(kinds.has('message')).toBe(true);
  });

  test('omits tool results below the size threshold', () => {
    const messages: LooseMessage[] = [
      { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], timestamp: 1 },
    ];
    expect(enumerate(messages, { minTextBytes: 2048 }).some((c) => c.kind === 'tool-result')).toBe(false);
  });

  test('ranks heaviest candidate first', () => {
    const messages: LooseMessage[] = [
      { role: 'user', content: 'tiny', timestamp: 1 },
      { role: 'user', content: big, timestamp: 2 },
    ];
    const cands = enumerate(messages);
    expect(cands[0].snippet.startsWith('x')).toBe(true);
  });

  test('skips already-placeholdered parts', () => {
    const messages: LooseMessage[] = [
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: textPlaceholder(big, 'trimmed') }],
        timestamp: 1,
      },
    ];
    expect(enumerate(messages).some((c) => c.kind === 'tool-result')).toBe(false);
  });

  test('stamps a document-order seq that survives the heaviest-first sort', () => {
    const messages: LooseMessage[] = [
      { role: 'user', content: big, timestamp: 1 },
      { role: 'user', content: 'tiny', timestamp: 2 },
    ];
    const cands = enumerate(messages);
    // Output is heaviest-first (big msg leads), but seq records encounter
    // order: the big (older) message has the lower seq.
    const bigCand = cands.find((c) => c.snippet.startsWith('x'));
    const tinyCand = cands.find((c) => c.snippet === 'tiny');
    expect(bigCand?.seq).toBe(0);
    expect(tinyCand?.seq).toBe(1);
  });

  test('assigns occurrence to disambiguate same role+timestamp messages', () => {
    const messages: LooseMessage[] = [
      { role: 'user', content: 'a'.repeat(3000), timestamp: 5 },
      { role: 'user', content: 'b'.repeat(3000), timestamp: 5 },
    ];
    const targets = enumerate(messages)
      .filter((c) => c.kind === 'message')
      .map((c) => (c.target?.by === 'message' ? c.target.occurrence : undefined));
    expect(new Set(targets).size).toBe(2);
  });
});

describe('candidateLabel', () => {
  test('includes size and snippet', () => {
    const messages: LooseMessage[] = [{ role: 'user', content: big, timestamp: 1 }];
    const label = candidateLabel(enumerate(messages)[0]);
    expect(label).toContain('user msg');
    expect(label).toContain('KB');
  });
});
