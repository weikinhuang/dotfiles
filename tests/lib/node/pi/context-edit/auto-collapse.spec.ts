/**
 * Tests for lib/node/pi/context-edit/auto-collapse.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import {
  DEFAULT_BACKGROUND_TOOLS,
  isBackgroundTool,
  selectAutoCollapse,
} from '../../../../../lib/node/pi/context-edit/auto-collapse.ts';
import type { LooseMessage } from '../../../../../lib/node/pi/context-edit/target.ts';

const big = 'x'.repeat(5000);

const result = (id: string, text: string, ts: number): LooseMessage => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'bash',
  content: [{ type: 'text', text }],
  timestamp: ts,
});
const assistant = (ts: number): LooseMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  timestamp: ts,
});

describe('isBackgroundTool', () => {
  const names = new Set(DEFAULT_BACKGROUND_TOOLS.map((s) => s.toLowerCase()));
  test('matches default background tools case-insensitively', () => {
    expect(isBackgroundTool('comfyui', names)).toBe(true);
    expect(isBackgroundTool('ComfyUI', names)).toBe(true);
    expect(isBackgroundTool('bash', names)).toBe(false);
    expect(isBackgroundTool(undefined, names)).toBe(false);
  });
});

describe('selectAutoCollapse', () => {
  test('off when afterTurns <= 0', () => {
    const messages = [result('c1', big, 1), assistant(2), assistant(3)];
    expect(selectAutoCollapse(messages, { afterTurns: 0, minBytes: 1 })).toEqual([]);
  });

  test('collapses big results with enough assistant turns after them', () => {
    const messages = [result('c1', big, 1), assistant(2), assistant(3)];
    expect(selectAutoCollapse(messages, { afterTurns: 2, minBytes: 1024 })).toEqual(['c1']);
  });

  test('skips results that are too recent', () => {
    const messages = [result('c1', big, 1), assistant(2)];
    expect(selectAutoCollapse(messages, { afterTurns: 2, minBytes: 1024 })).toEqual([]);
  });

  test('skips results below the size threshold', () => {
    const messages = [result('c1', 'tiny', 1), assistant(2), assistant(3)];
    expect(selectAutoCollapse(messages, { afterTurns: 2, minBytes: 1024 })).toEqual([]);
  });
});
