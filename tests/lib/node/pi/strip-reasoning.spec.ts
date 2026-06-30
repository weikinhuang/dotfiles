/**
 * Tests for lib/node/pi/strip-reasoning.ts.
 *
 * Pure module - no pi runtime needed. The config loader is exercised against a
 * throwaway agent dir + project dir via PI_CODING_AGENT_DIR.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  coerceStripReasoningLayer,
  DEFAULT_KEEP_LAST,
  isStripableThinking,
  loadStripReasoningConfig,
  mergeStripReasoningLayers,
  type ReasoningMessage,
  SENTINEL_SIGNATURES,
  shouldStripForModel,
  stripReasoning,
} from '../../../../lib/node/pi/strip-reasoning.ts';

// ──────────────────────────────────────────────────────────────────────
// isStripableThinking
// ──────────────────────────────────────────────────────────────────────

describe('isStripableThinking', () => {
  test('unsigned thinking is stripable', () => {
    expect(isStripableThinking({ type: 'thinking' })).toBe(true);
  });

  test('sentinel signatures are stripable', () => {
    for (const sig of SENTINEL_SIGNATURES) {
      expect(isStripableThinking({ type: 'thinking', thinkingSignature: sig })).toBe(true);
    }
  });

  test('a real opaque signature is preserved', () => {
    expect(isStripableThinking({ type: 'thinking', thinkingSignature: 'ErcBCkg...' })).toBe(false);
  });

  test('redacted thinking is preserved', () => {
    expect(isStripableThinking({ type: 'thinking', redacted: true })).toBe(false);
  });

  test('non-thinking blocks are never stripable', () => {
    expect(isStripableThinking({ type: 'text' })).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// stripReasoning
// ──────────────────────────────────────────────────────────────────────

function asst(blocks: Record<string, unknown>[]): ReasoningMessage {
  return { role: 'assistant', content: blocks };
}

describe('stripReasoning', () => {
  test('drops stripable thinking from older assistant turns, keeps last N', () => {
    const messages: ReasoningMessage[] = [
      asst([
        { type: 'thinking', text: 'a' },
        { type: 'text', text: 'A' },
      ]),
      { role: 'user', content: 'u' },
      asst([
        { type: 'thinking', text: 'b' },
        { type: 'text', text: 'B' },
      ]),
    ];
    const out = stripReasoning(messages, 1);
    // Older assistant (index 0) loses thinking; last assistant (index 2) keeps it.
    expect((out[0].content as unknown[]).length).toBe(1);
    expect((out[0].content as { type: string }[])[0].type).toBe('text');
    expect((out[2].content as unknown[]).length).toBe(2);
  });

  test('keepLast=0 strips every assistant turn', () => {
    const messages: ReasoningMessage[] = [
      asst([{ type: 'thinking' }, { type: 'text', text: 'A' }]),
      asst([{ type: 'thinking' }, { type: 'text', text: 'B' }]),
    ];
    const out = stripReasoning(messages, 0);
    expect((out[0].content as unknown[]).length).toBe(1);
    expect((out[1].content as unknown[]).length).toBe(1);
  });

  test('returns the SAME reference when nothing changed (cache-stable)', () => {
    const messages: ReasoningMessage[] = [
      asst([{ type: 'text', text: 'A' }]),
      { role: 'user', content: 'u' },
      asst([{ type: 'thinking' }, { type: 'text', text: 'B' }]),
    ];
    expect(stripReasoning(messages, 1)).toBe(messages);
  });

  test('preserves signed thinking even on older turns', () => {
    const messages: ReasoningMessage[] = [
      asst([
        { type: 'thinking', thinkingSignature: 'opaque-sig' },
        { type: 'text', text: 'A' },
      ]),
      { role: 'user', content: 'u' },
      asst([{ type: 'text', text: 'B' }]),
    ];
    expect(stripReasoning(messages, 1)).toBe(messages);
  });

  test('never emits a content-less assistant message', () => {
    const messages: ReasoningMessage[] = [
      asst([{ type: 'thinking' }]),
      { role: 'user', content: 'u' },
      asst([{ type: 'text', text: 'B' }]),
    ];
    // index 0 is all-thinking; stripping would empty it, so it's left untouched.
    const out = stripReasoning(messages, 1);
    expect((out[0].content as unknown[]).length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// shouldStripForModel
// ──────────────────────────────────────────────────────────────────────

describe('shouldStripForModel', () => {
  test('matches a bare id', () => {
    expect(shouldStripForModel(['gemma4-31b'], 'gemma4-31b', 'llama-cpp')).toBe(true);
  });

  test('matches a qualified provider/id', () => {
    expect(shouldStripForModel(['llama-cpp/gemma4-31b'], 'gemma4-31b', 'llama-cpp')).toBe(true);
  });

  test('no match when absent', () => {
    expect(shouldStripForModel(['other'], 'gemma4-31b', 'llama-cpp')).toBe(false);
  });

  test('undefined id never matches', () => {
    expect(shouldStripForModel(['gemma4-31b'], undefined, 'llama-cpp')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// coerce + merge
// ──────────────────────────────────────────────────────────────────────

describe('coerceStripReasoningLayer', () => {
  test('keeps non-empty string models, trims, drops junk', () => {
    expect(coerceStripReasoningLayer({ models: ['a', ' b ', '', 3, null] })).toEqual({ models: ['a', 'b'] });
  });

  test('accepts non-negative integer keepLast', () => {
    expect(coerceStripReasoningLayer({ keepLast: 2 })).toEqual({ keepLast: 2 });
    expect(coerceStripReasoningLayer({ keepLast: -1 })).toEqual({});
    expect(coerceStripReasoningLayer({ keepLast: 1.9 })).toEqual({ keepLast: 1 });
  });

  test('non-object yields empty', () => {
    expect(coerceStripReasoningLayer(null)).toEqual({});
    expect(coerceStripReasoningLayer([1, 2])).toEqual({});
  });
});

describe('mergeStripReasoningLayers', () => {
  test('unions models and lets project override keepLast', () => {
    const merged = mergeStripReasoningLayers({ models: ['a'], keepLast: 3 }, { models: ['a', 'b'], keepLast: 1 });
    expect(merged.models).toEqual(['a', 'b']);
    expect(merged.keepLast).toBe(1);
  });

  test('falls back to user then default keepLast', () => {
    expect(mergeStripReasoningLayers({ keepLast: 4 }, {}).keepLast).toBe(4);
    expect(mergeStripReasoningLayers({}, {}).keepLast).toBe(DEFAULT_KEEP_LAST);
  });
});

// ──────────────────────────────────────────────────────────────────────
// loadStripReasoningConfig (layered, fs-backed)
// ──────────────────────────────────────────────────────────────────────

describe('loadStripReasoningConfig', () => {
  let agentDir: string;
  let projectDir: string;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'sr-agent-'));
    projectDir = mkdtempSync(join(tmpdir(), 'sr-proj-'));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('absent config is an empty allowlist (no-op default)', () => {
    expect(loadStripReasoningConfig(projectDir)).toEqual({ models: [], keepLast: DEFAULT_KEEP_LAST });
  });

  test('unions user + project models and lets project override keepLast', () => {
    writeFileSync(join(agentDir, 'strip-reasoning.json'), JSON.stringify({ models: ['u'], keepLast: 5 }));
    const piDir = join(projectDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'strip-reasoning.json'), JSON.stringify({ models: ['p'], keepLast: 2 }));
    const cfg = loadStripReasoningConfig(projectDir);
    expect([...cfg.models].sort()).toEqual(['p', 'u']);
    expect(cfg.keepLast).toBe(2);
  });

  test('user-only config applies when project has none', () => {
    writeFileSync(join(agentDir, 'strip-reasoning.json'), JSON.stringify({ models: ['u'], keepLast: 3 }));
    expect(loadStripReasoningConfig(projectDir)).toEqual({ models: ['u'], keepLast: 3 });
  });
});
