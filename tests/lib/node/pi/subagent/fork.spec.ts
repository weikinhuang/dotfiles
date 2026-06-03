/**
 * Specs for `lib/node/pi/subagent/fork.ts` - fork-mode decision +
 * prompt construction. Pure module, no fs/pi.
 */

import { describe, expect, test } from 'vitest';

import { buildForkPrompt, RECURSIVE_TOOL_NAMES, resolveForkMode } from '../../../../../lib/node/pi/subagent/fork.ts';

describe('resolveForkMode', () => {
  const file = '/sessions/parent.jsonl';

  test('per-call true forks when parent is persisted', () => {
    expect(resolveForkMode({ perCall: true, agentDefault: 'fresh', parentSessionFile: file })).toEqual({ fork: true });
  });

  test('per-call false overrides an inherit agent default', () => {
    expect(resolveForkMode({ perCall: false, agentDefault: 'inherit', parentSessionFile: file })).toEqual({
      fork: false,
    });
  });

  test('agent default inherit forks when per-call is unset', () => {
    expect(resolveForkMode({ perCall: undefined, agentDefault: 'inherit', parentSessionFile: file })).toEqual({
      fork: true,
    });
  });

  test('agent default fresh does not fork when per-call is unset', () => {
    expect(resolveForkMode({ perCall: undefined, agentDefault: 'fresh', parentSessionFile: file })).toEqual({
      fork: false,
    });
  });

  test('downgrades to fresh with a reason when parent session is not persisted', () => {
    const d = resolveForkMode({ perCall: true, agentDefault: 'inherit', parentSessionFile: undefined });
    expect(d.fork).toBe(false);
    expect(d.reason).toMatch(/not persisted/);
  });

  test('treats a blank session file as not persisted', () => {
    expect(resolveForkMode({ perCall: true, agentDefault: 'fresh', parentSessionFile: '   ' }).fork).toBe(false);
  });
});

describe('buildForkPrompt', () => {
  test('embeds the agent name, body, and task', () => {
    const out = buildForkPrompt({ agent: { name: 'explore', body: 'Be thorough.' }, task: 'Map the auth flow.' });
    expect(out).toContain('"explore"');
    expect(out).toContain('Be thorough.');
    expect(out).toContain('Map the auth flow.');
    expect(out).toMatch(/## Task/);
  });

  test('omits an empty body cleanly', () => {
    const out = buildForkPrompt({ agent: { name: 'x', body: '   ' }, task: 'go' });
    expect(out).not.toMatch(/\n\n\n/);
    expect(out).toContain('go');
  });
});

describe('RECURSIVE_TOOL_NAMES', () => {
  test('covers both subagent tools', () => {
    expect([...RECURSIVE_TOOL_NAMES].sort()).toEqual(['subagent', 'subagent_send']);
  });
});
