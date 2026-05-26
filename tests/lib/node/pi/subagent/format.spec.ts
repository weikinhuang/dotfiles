/**
 * Tests for lib/node/pi/subagent/format.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import {
  type AgentListItem,
  type AgentPreviewSource,
  formatAgentListDescription,
  formatAgentListRowDescription,
  formatAgentPreview,
  formatContextBar,
  formatParallelSubagentStatus,
  formatRunningChildRow,
  formatRunningChildrenList,
  formatScorecardLead,
  formatSpawnMessage,
  formatSubagentScorecard,
  formatSubagentStatus,
  formatToolCallCounts,
  scorecardGlyph,
  scorecardStopReasonToState,
  subagentDetailsToSnapshot,
  type RunningChildListItem,
  type SubagentRunSnapshot,
} from '../../../../../lib/node/pi/subagent/format.ts';

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
    expect(lines[3]).not.toContain('[global]'); // global is the default - untagged
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

describe('formatSpawnMessage', () => {
  test('embeds handle + agent + task preview', () => {
    const out = formatSpawnMessage({ handle: 'sub_explore_1', agent: 'explore', task: 'find all callers of foo' });

    expect(out).toContain('handle: sub_explore_1');
    expect(out).toContain('agent:  explore');
    expect(out).toContain('task:   find all callers of foo');
    expect(out).toContain('`subagent_send`');
  });

  test('truncates long tasks with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = formatSpawnMessage({ handle: 'sub_plan_1', agent: 'plan', task: long });

    expect(out).toMatch(/…/);

    // The line containing the task must fit inside the preview cap + prefix.
    const taskLine = out.split('\n').find((l) => l.includes('task:'))!;

    expect(taskLine.length).toBeLessThan(120);
  });
});

describe('formatRunningChildrenList', () => {
  test('empty list yields a single message', () => {
    expect(formatRunningChildrenList([])).toBe('No background sub-agents running.');
  });

  test('lists entries sorted by start time with status line and elapsed', () => {
    const base: SubagentRunSnapshot = {
      agent: 'explore',
      state: 'running',
      turns: 1,
      input: 100,
      cacheRead: 50,
      output: 20,
      cost: 0.001,
    };
    const entries: RunningChildListItem[] = [
      { handle: 'sub_explore_2', snapshot: { ...base, agent: 'explore' }, startedAt: 200 },
      {
        handle: 'sub_plan_1',
        snapshot: { ...base, agent: 'plan', state: 'completed', durationMs: 1200 },
        startedAt: 100,
      },
    ];

    const out = formatRunningChildrenList(entries, 10_200);
    const lines = out.split('\n');

    expect(lines[0]).toBe('Background sub-agents:');
    expect(lines[1]).toContain('sub_plan_1');
    expect(lines[1]).toContain('subagent:plan ✓');
    expect(lines[2]).toContain('sub_explore_2');
    expect(lines[2]).toContain('subagent:explore ⏳');
    expect(lines[2]).toMatch(/10s$/);
  });

  test('only appends elapsed to running entries', () => {
    const entries: RunningChildListItem[] = [
      {
        handle: 'sub_plan_1',
        snapshot: {
          agent: 'plan',
          state: 'completed',
          turns: 2,
          input: 0,
          cacheRead: 0,
          output: 0,
          cost: 0,
          durationMs: 3000,
        },
        startedAt: 0,
      },
    ];
    const out = formatRunningChildrenList(entries, 10_000);

    expect(out).toContain('3.0s'); // from the formatter itself
    // No trailing 10s - would duplicate the duration the completed-line already carries.
    expect(out.trimEnd()).not.toMatch(/\s10s$/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// /agents overlay helpers
// ──────────────────────────────────────────────────────────────────────

const previewAgent: AgentPreviewSource = {
  name: 'explore',
  description:
    'Read-only code exploration. Use when the user asks "find X across the codebase" or "summarize what this module does" - keeps the parent context clean by running grep/find/read in a throwaway session.',
  source: 'global',
  path: '/Users/me/.dotfiles/config/pi/agents/explore.md',
  tools: ['read', 'grep', 'find', 'ls'],
  model: 'inherit',
  maxTurns: 20,
  timeoutMs: 180_000,
  isolation: 'shared-cwd',
};

describe('formatAgentListRowDescription', () => {
  test('caps at ~55 chars with an ellipsis', () => {
    const out = formatAgentListRowDescription('a'.repeat(120));

    expect(out.length).toBeLessThanOrEqual(55);
    expect(out).toMatch(/…$/);
  });

  test('collapses whitespace inside the row', () => {
    expect(formatAgentListRowDescription('multi\nline   desc')).toBe('multi line desc');
  });
});

describe('formatAgentPreview', () => {
  test('emits path, frontmatter summary, blank, prose', () => {
    const lines = formatAgentPreview(previewAgent);

    expect(lines[0]).toContain('/explore.md');
    expect(lines[1]).toBe('');
    expect(lines[2]).toContain('tools:');
    expect(lines[2]).toContain('read, grep, find, ls');
    expect(lines[3]).toContain('model:  inherit');
    expect(lines[3]).toContain('maxTurns: 20');
    expect(lines[3]).toContain('timeoutMs: 180s');
    expect(lines[4]).toContain('isolation: shared-cwd');
    expect(lines[5]).toBe('');
    expect(lines[6]).toContain('Read-only code exploration');
  });

  test('renders provider/id model when not inherit', () => {
    const lines = formatAgentPreview({
      ...previewAgent,
      model: { provider: 'amazon-bedrock', modelId: 'claude-sonnet-4' },
    });

    expect(lines.some((l) => l.includes('amazon-bedrock/claude-sonnet-4'))).toBe(true);
  });

  test('caps the description prose with an ellipsis', () => {
    const lines = formatAgentPreview({ ...previewAgent, description: 'x '.repeat(400) });
    const prose = lines[lines.length - 1];

    expect(prose).toMatch(/…$/);
    expect(prose.length).toBeLessThan(360);
  });
});

// ──────────────────────────────────────────────────────────────────────
// /agents:running overlay helpers
// ──────────────────────────────────────────────────────────────────────

describe('formatContextBar', () => {
  test('renders filled cells proportional to usage', () => {
    const out = formatContextBar({ contextTokens: 25_000, contextWindow: 100_000 }, { width: 8 });

    expect(out).toContain('▰▰');
    expect(out).toContain('▱');
    expect(out).toMatch(/25%$/);
  });

  test('renders empty bar with --% when context is unknown', () => {
    expect(formatContextBar({}, { width: 4 })).toBe('▱▱▱▱  --%');
  });

  test('clamps to width when usage exceeds 100%', () => {
    const out = formatContextBar({ contextTokens: 500_000, contextWindow: 100_000 }, { width: 8 });

    expect(out).toContain('▰▰▰▰▰▰▰▰');
    expect(out).toMatch(/100%$/);
  });
});

describe('formatToolCallCounts', () => {
  test('returns null when nothing recorded', () => {
    expect(formatToolCallCounts({})).toBeNull();
    expect(formatToolCallCounts({ byTool: {} })).toBeNull();
  });

  test('sorts descending by count, joins with ·', () => {
    const out = formatToolCallCounts({ byTool: { bash: 1, grep: 3, read: 7 } });

    expect(out).toBe('read(7) · grep(3) · bash(1)');
  });

  test('truncates after top 5 with +N more', () => {
    const byTool = { a: 6, b: 5, c: 4, d: 3, e: 2, f: 1, g: 1 };
    const out = formatToolCallCounts({ byTool });

    expect(out).toContain('a(6)');
    expect(out).toContain('e(2)');
    expect(out).toContain('+2 more');
    expect(out).not.toContain('f(1)');
  });
});

describe('formatRunningChildRow', () => {
  const baseSnap: SubagentRunSnapshot = {
    agent: 'explore',
    state: 'running',
    model: 'qwen3-coder-30b',
    turns: 3,
    input: 1200,
    cacheRead: 4500,
    output: 180,
    cost: 0.004,
    contextTokens: 8000,
    contextWindow: 100_000,
    maxTurns: 20,
    byTool: { read: 7, grep: 3, bash: 1 },
  };

  test('emits 4 lines for a running child with tools', () => {
    const lines = formatRunningChildRow({ handle: 'bg-1', snapshot: baseSnap, startedAt: 0 }, 12_000);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('bg-1');
    expect(lines[0]).toContain('explore');
    expect(lines[0]).toContain('⏳');
    expect(lines[0]).toContain('12s');
    expect(lines[0]).toContain('turn 3/20');
    expect(lines[1]).toContain('M(3)');
    expect(lines[1]).toContain('↑1k');
    expect(lines[1]).toContain('R 79%');
    expect(lines[2]).toContain('ctx');
    expect(lines[2]).toContain('8%');
    expect(lines[2]).toContain('model qwen3-coder-30b');
    expect(lines[3]).toContain('tools: read(7) · grep(3) · bash(1)');
  });

  test('omits tools line when byTool is empty', () => {
    const lines = formatRunningChildRow({ handle: 'bg-2', snapshot: { ...baseSnap, byTool: {} }, startedAt: 0 }, 3000);

    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.startsWith('       tools:'))).toBeUndefined();
  });

  test('falls back to bare turn count when maxTurns is unset', () => {
    const lines = formatRunningChildRow(
      { handle: 'bg-3', snapshot: { ...baseSnap, maxTurns: undefined }, startedAt: 0 },
      3000,
    );

    expect(lines[0]).toContain('turn 3');
    expect(lines[0]).not.toContain('/');
  });

  test('uses the snapshot state to pick the glyph for terminal children', () => {
    const lines = formatRunningChildRow(
      { handle: 'bg-4', snapshot: { ...baseSnap, state: 'completed' }, startedAt: 0 },
      4200,
    );

    expect(lines[0]).toContain('✓');
    expect(lines[0]).toContain('done');
  });
});

// ──────────────────────────────────────────────────────────────────────
// scorecard
// ──────────────────────────────────────────────────────────────────────

describe('scorecardGlyph', () => {
  test('maps every stop reason to a glyph', () => {
    expect(scorecardGlyph('completed').glyph).toBe('✓');
    expect(scorecardGlyph('max_turns').glyph).toBe('∎');
    expect(scorecardGlyph('aborted').glyph).toBe('⚠');
    expect(scorecardGlyph('error').glyph).toBe('✗');
    expect(scorecardGlyph('spawned').glyph).toBe('⏳');
    expect(scorecardGlyph('running').glyph).toBe('⏳');
  });

  test('missing / unknown stopReason defaults to spawned glyph', () => {
    expect(scorecardGlyph(undefined).glyph).toBe('⏳');
  });
});

describe('formatScorecardLead', () => {
  test('includes agent, source, handle, suffix', () => {
    const out = formatScorecardLead({
      agent: 'explore',
      agentSource: 'global',
      handle: 'sub_explore_1',
      stopReason: 'spawned',
      suffix: 'spawned in background',
    });

    expect(out.startsWith('⏳ explore (global)')).toBe(true);
    expect(out).toContain('sub_explore_1');
    expect(out).toContain('spawned in background');
  });

  test('handles missing optional fields', () => {
    const out = formatScorecardLead({ agent: 'plan', stopReason: 'completed' });

    expect(out).toBe('✓ plan');
  });
});

describe('subagentDetailsToSnapshot', () => {
  test('maps stop reasons to running snapshot states', () => {
    expect(scorecardStopReasonToState('completed')).toBe('completed');
    expect(scorecardStopReasonToState('max_turns')).toBe('max_turns');
    expect(scorecardStopReasonToState('aborted')).toBe('aborted');
    expect(scorecardStopReasonToState('error')).toBe('error');
    expect(scorecardStopReasonToState('running')).toBe('running');
    expect(scorecardStopReasonToState('spawned')).toBe('running');
  });

  test('rehydrates partial result details for scorecard rendering', () => {
    expect(
      subagentDetailsToSnapshot(
        {
          agent: 'explore',
          agentSource: 'project',
          task: 'map the repo',
          model: 'qwen3',
          turns: 3,
          tokens: { input: 1200, cacheRead: 4500, cacheWrite: 300, output: 180 },
          cost: 0.004,
          durationMs: 4200,
          handle: 'sub_explore_1',
          maxTurns: 20,
          byTool: { read: 7 },
          contextTokens: 8000,
          contextWindow: 100_000,
        },
        'completed',
      ),
    ).toEqual({
      agent: 'explore',
      agentSource: 'project',
      state: 'completed',
      model: 'qwen3',
      turns: 3,
      input: 1200,
      cacheRead: 4500,
      cacheWrite: 300,
      output: 180,
      cost: 0.004,
      durationMs: 4200,
      contextTokens: 8000,
      contextWindow: 100_000,
      task: 'map the repo',
      handle: 'sub_explore_1',
      maxTurns: 20,
      byTool: { read: 7 },
    });
  });

  test('fills scorecard defaults when result details are sparse', () => {
    expect(subagentDetailsToSnapshot({}, 'spawned')).toMatchObject({
      agent: '',
      state: 'running',
      turns: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      cost: 0,
    });
  });
});

describe('formatSubagentScorecard', () => {
  test('renders the three-line scorecard for a completed run with tools', () => {
    const lines = formatSubagentScorecard({
      agent: 'explore',
      state: 'completed',
      model: 'qwen3-coder-30b',
      turns: 3,
      input: 1200,
      cacheRead: 4500,
      output: 180,
      cost: 0.004,
      durationMs: 4200,
      contextTokens: 8000,
      contextWindow: 100_000,
      maxTurns: 20,
      byTool: { read: 7, grep: 3, bash: 1 },
    });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('3 turns / 20 max');
    expect(lines[0]).toContain('↑1k / ↻ 5k / ↓180');
    expect(lines[0]).toContain('R 79%');
    expect(lines[0]).toContain('$0.004');
    expect(lines[0]).toContain('4.2s');
    expect(lines[1]).toContain('stop: completed');
    expect(lines[1]).toContain('ctx:8%');
    expect(lines[1]).toContain('model: qwen3-coder-30b');
    expect(lines[2]).toContain('tools: read(7) · grep(3) · bash(1)');
  });

  test('hides tools line when no calls recorded', () => {
    const lines = formatSubagentScorecard({
      agent: 'plan',
      state: 'running',
      turns: 1,
      input: 4000,
      cacheRead: 0,
      output: 111,
      cost: 0,
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('1 turn');
    expect(lines[1]).toContain('stop: running');
  });

  test('singular "turn" when turns=1', () => {
    const lines = formatSubagentScorecard({
      agent: 'plan',
      state: 'completed',
      turns: 1,
      maxTurns: 20,
      input: 0,
      cacheRead: 0,
      output: 0,
      cost: 0,
    });

    expect(lines[0]).toMatch(/\b1 turn\b/);
    expect(lines[0]).not.toMatch(/\b1 turns\b/);
  });

  test('omits maxTurns segment when not provided', () => {
    const lines = formatSubagentScorecard({
      agent: 'plan',
      state: 'completed',
      turns: 2,
      input: 0,
      cacheRead: 0,
      output: 0,
      cost: 0,
    });

    expect(lines[0]).toContain('2 turns');
    expect(lines[0]).not.toContain('max');
  });
});
