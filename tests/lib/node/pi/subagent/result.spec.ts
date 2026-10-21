/**
 * Tests for lib/node/pi/subagent/result.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import {
  type AgentMessageLike,
  classifyStopReason,
  extractFinalAssistantText,
  formatRunResultText,
  formatStopSummary,
  resolveFinalText,
  type StopSummaryInput,
} from '../../../../../lib/node/pi/subagent/result.ts';

describe('extractFinalAssistantText', () => {
  test('returns empty string for missing / empty messages', () => {
    expect(extractFinalAssistantText(undefined)).toBe('');
    expect(extractFinalAssistantText([])).toBe('');
  });

  test('returns last assistant text parts, joined', () => {
    const msgs: AgentMessageLike[] = [
      { role: 'user', content: [{ type: 'text', text: 'go find X' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is ' },
          { type: 'text', text: 'the answer.' },
        ],
      },
    ];

    expect(extractFinalAssistantText(msgs)).toBe('Here is the answer.');
  });

  test('skips tool-call-only final assistant message, falls back to earlier text', () => {
    const msgs: AgentMessageLike[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'draft summary' }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] },
      { role: 'assistant', content: [{ type: 'toolCall' }] },
    ];

    expect(extractFinalAssistantText(msgs)).toBe('draft summary');
  });

  test('tool-call-only assistant with no prior text → empty', () => {
    const msgs: AgentMessageLike[] = [{ role: 'assistant', content: [{ type: 'toolCall' }] }];

    expect(extractFinalAssistantText(msgs)).toBe('');
  });

  test('drops empty text parts and non-text parts', () => {
    const msgs: AgentMessageLike[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'hidden' },
          { type: 'text', text: '' },
          { type: 'text', text: 'final' },
        ],
      },
    ];

    expect(extractFinalAssistantText(msgs)).toBe('final');
  });

  test('trims whitespace around final text', () => {
    const msgs: AgentMessageLike[] = [
      { role: 'assistant', content: [{ type: 'text', text: '   \n\n  Hello world\n\n' }] },
    ];

    expect(extractFinalAssistantText(msgs)).toBe('Hello world');
  });
});

describe('classifyStopReason', () => {
  test('default case is "completed"', () => {
    expect(classifyStopReason({})).toBe('completed');
  });

  test('max_turns wins over aborted + error', () => {
    expect(classifyStopReason({ reachedMaxTurns: true, aborted: true, error: true })).toBe('max_turns');
  });

  test('aborted wins over error', () => {
    expect(classifyStopReason({ aborted: true, error: true })).toBe('aborted');
  });

  test('error lands last before completed', () => {
    expect(classifyStopReason({ error: true })).toBe('error');
  });
});

describe('resolveFinalText', () => {
  const base = { agent: 'explore', maxTurns: 20 };

  test('returns a non-empty final answer verbatim regardless of stopReason', () => {
    for (const stopReason of ['completed', 'error', 'max_turns', 'aborted'] as const) {
      expect(resolveFinalText({ ...base, stopReason, finalText: 'the answer' })).toBe('the answer');
    }
  });

  test('completed with empty text stays empty', () => {
    expect(resolveFinalText({ ...base, stopReason: 'completed', finalText: '' })).toBe('');
  });

  test('error fallback prefers errorFromChild, then childErrorMessage, then a default', () => {
    expect(resolveFinalText({ ...base, stopReason: 'error', finalText: '', errorFromChild: 'boom' })).toBe(
      'subagent explore: boom',
    );
    expect(resolveFinalText({ ...base, stopReason: 'error', finalText: '', childErrorMessage: 'threw' })).toBe(
      'subagent explore: threw',
    );
    expect(resolveFinalText({ ...base, stopReason: 'error', finalText: '' })).toBe(
      'subagent explore: child session errored',
    );
  });

  test('max_turns fallback names the turn budget', () => {
    expect(resolveFinalText({ ...base, stopReason: 'max_turns', finalText: '', maxTurns: 7 })).toBe(
      'subagent explore exhausted its 7-turn budget without producing a final answer.',
    );
  });

  test('aborted fallback', () => {
    expect(resolveFinalText({ ...base, stopReason: 'aborted', finalText: '' })).toBe('subagent explore was aborted.');
  });
});

describe('formatStopSummary / formatRunResultText', () => {
  const base: StopSummaryInput = {
    agent: 'general-purpose',
    stopReason: 'aborted',
    timedOut: true,
    timeoutMs: 300_000,
    durationMs: 300_412,
    turns: 23,
    maxTurns: 50,
    touchedFiles: ['src/a.ts', 'tests/a.spec.ts'],
  };

  test('completed runs return the final answer verbatim and no summary', () => {
    expect(formatStopSummary({ ...base, stopReason: 'completed', timedOut: false })).toBeUndefined();
    expect(formatRunResultText({ ...base, stopReason: 'completed', timedOut: false, finalText: 'done' })).toBe('done');
  });

  test('timeout leads with the timeout + touched files; last message trails', () => {
    const out = formatRunResultText({ ...base, finalText: 'Now update the tests.' });
    const lines = out.split('\n');
    expect(lines[0]).toBe(
      'subagent "general-purpose" timed out after 300s (23 turns); partial changes may be on disk:',
    );
    expect(lines.slice(1, 3)).toEqual(['- src/a.ts', '- tests/a.spec.ts']);
    expect(out.endsWith('\n\nLast message:\nNow update the tests.')).toBe(true);
  });

  test('no recorded writes says so instead of listing files', () => {
    const out = formatRunResultText({ ...base, touchedFiles: [], turns: 1, finalText: '' });
    expect(out).toBe(
      'subagent "general-purpose" timed out after 300s (1 turn); no write/edit/apply_patch calls were recorded (bash commands may still have changed files).',
    );
  });

  test('max_turns, plain abort, and error each get their own headline', () => {
    expect(formatStopSummary({ ...base, stopReason: 'max_turns', timedOut: false })?.split('\n')[0]).toBe(
      'subagent "general-purpose" hit its 50-turn limit after 300s (23 turns); partial changes may be on disk:',
    );
    expect(formatStopSummary({ ...base, timedOut: false, durationMs: 4_000 })?.split('\n')[0]).toBe(
      'subagent "general-purpose" was aborted after 4s (23 turns); partial changes may be on disk:',
    );
    expect(
      formatStopSummary({ ...base, stopReason: 'error', timedOut: false, errorMessage: 'boom', touchedFiles: [] }),
    ).toMatch(/^subagent "general-purpose" failed after 300s \(23 turns\): boom; no write/);
    expect(formatStopSummary({ ...base, stopReason: 'error', timedOut: false, errorMessage: '  ' })).toContain(
      ': child session errored;',
    );
  });
});
