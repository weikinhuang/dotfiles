/**
 * Tests for lib/node/pi/subagent-format.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';
import {
  type AgentListItem,
  formatAgentListDescription,
  formatParallelSubagentStatus,
  formatSubagentStatus,
  type SubagentRunSnapshot,
} from '../../../../lib/node/pi/subagent-format.ts';

describe('formatAgentListDescription', () => {
  test('empty list tells the user where to drop definitions', () => {
    const out = formatAgentListDescription([]);

    expect(out).toContain('No agent definitions loaded');
    expect(out).toContain('~/.pi/agents/');
  });

  test('sorts alphabetically and tags non-global sources', () => {
    const items: AgentListItem[] = [
      { name: 'plan', description: 'produces plans', source: 'global' },
      { name: 'explore', description: 'read-only exploration', source: 'user' },
      { name: 'build', description: 'builds', source: 'project' },
    ];
    const out = formatAgentListDescription(items);
    const lines = out.split('\n');

    expect(lines[0]).toMatch(/Available:/);
    expect(lines[1]).toContain('build');
    expect(lines[1]).toContain('[project]');
    expect(lines[2]).toContain('explore');
    expect(lines[2]).toContain('[user]');
    expect(lines[3]).toContain('plan');
    expect(lines[3]).not.toContain('[global]'); // global is the default — untagged
  });

  test('truncates long descriptions', () => {
    const long = 'a'.repeat(500);
    const out = formatAgentListDescription([{ name: 'x', description: long }]);

    // Shortened body ends with an ellipsis well before 500 chars.
    expect(out).toMatch(/…/);
    expect(out.length).toBeLessThan(250);
  });

  test('collapses internal whitespace in descriptions', () => {
    const out = formatAgentListDescription([{ name: 'x', description: 'multi\nline\n\n desc' }]);

    expect(out).toContain('multi line desc');
  });
});

describe('formatSubagentStatus (running)', () => {
  test('renders turn counter + ratio + model', () => {
    const snap: SubagentRunSnapshot = {
      agent: 'explore',
      state: 'running',
      model: 'qwen3',
      turns: 2,
      input: 320,
      cacheRead: 2100,
      output: 180,
      cost: 0.004,
      contextTokens: 8000,
      contextWindow: 100_000,
    };
    const out = formatSubagentStatus(snap);

    expect(out).toContain('subagent:explore ⏳');
    expect(out).toContain('M(2):↑320/↻ 2k/↓180');
    expect(out).toContain('R 87%');
    expect(out).toContain('$0.004');
    expect(out).toContain('ctx:8%');
    expect(out).toContain('model:qwen3');
  });

  test('omits ratio when no input/cacheRead yet', () => {
    const out = formatSubagentStatus({
      agent: 'plan',
      state: 'running',
      turns: 0,
      input: 0,
      cacheRead: 0,
      output: 0,
      cost: 0,
    });

    expect(out).toBe('subagent:plan ⏳ M:↑0/↻ 0/↓0');
  });
});

describe('formatSubagentStatus (completed)', () => {
  test('renders turns + tokens + cost + duration', () => {
    const out = formatSubagentStatus({
      agent: 'explore',
      state: 'completed',
      turns: 3,
      input: 1200,
      cacheRead: 5400,
      output: 410,
      cost: 0.013,
      durationMs: 4200,
    });

    expect(out).toContain('subagent:explore ✓');
    expect(out).toContain('3 turns');
    expect(out).toContain('↑1k');
    expect(out).toContain('↻ 5k');
    expect(out).toContain('↓410');
    expect(out).toContain('$0.013');
    expect(out).toContain('4.2s');
  });

  test('singular "turn" when turns=1', () => {
    const out = formatSubagentStatus({
      agent: 'explore',
      state: 'completed',
      turns: 1,
      input: 0,
      cacheRead: 0,
      output: 0,
      cost: 0,
    });

    expect(out).toMatch(/\b1 turn\b/);
    expect(out).not.toMatch(/\b1 turns\b/);
  });

  test('error state uses ✗ glyph', () => {
    const out = formatSubagentStatus({
      agent: 'plan',
      state: 'error',
      turns: 0,
      input: 0,
      cacheRead: 0,
      output: 0,
      cost: 0,
    });

    expect(out.startsWith('subagent:plan ✗')).toBe(true);
  });

  test('max_turns state uses ∎ glyph', () => {
    const out = formatSubagentStatus({
      agent: 'plan',
      state: 'max_turns',
      turns: 12,
      input: 0,
      cacheRead: 0,
      output: 0,
      cost: 0,
    });

    expect(out.startsWith('subagent:plan ∎')).toBe(true);
  });
});

describe('formatParallelSubagentStatus', () => {
  test('running + done collapse into one line with cost', () => {
    const out = formatParallelSubagentStatus([
      { agent: 'a', state: 'completed', turns: 1, input: 0, cacheRead: 0, output: 0, cost: 0.01 },
      { agent: 'b', state: 'completed', turns: 1, input: 0, cacheRead: 0, output: 0, cost: 0.005 },
      { agent: 'c', state: 'running', turns: 0, input: 0, cacheRead: 0, output: 0, cost: 0.006 },
    ]);

    expect(out).toContain('2/3 done');
    expect(out).toContain('1 running');
    expect(out).toContain('$0.021');
  });

  test('all-done omits the running segment', () => {
    const out = formatParallelSubagentStatus([
      { agent: 'a', state: 'completed', turns: 1, input: 0, cacheRead: 0, output: 0, cost: 0 },
    ]);

    expect(out).toBe('subagent: 1/1 done');
  });
});
