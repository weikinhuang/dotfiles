import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  copilotLegacyError,
  type CopilotParseResult,
  type CopilotSessionRecord,
  defaultCopilotHome,
  isEmptyCopilotSession,
  listCopilotSessionDirs,
  loadCopilotSessionDir,
  parseCopilotEvents,
  parseWorkspaceTitle,
  pickCopilotSessionDir,
  summarizeCopilotEvents,
} from '../../../../lib/node/ai-tooling/copilot-events.ts';

function ev(type: string, data: Record<string, unknown>, timestamp: string, agentId?: string): string {
  return JSON.stringify({
    type,
    data,
    id: `${type}-${timestamp}`,
    timestamp,
    parentId: null,
    ...(agentId ? { agentId } : {}),
  });
}

function usage(timestamp: string, u: Record<string, unknown>, agentId?: string): string {
  return ev('session.usage_record', { usage: u }, timestamp, agentId);
}

function okSession(r: CopilotParseResult): CopilotSessionRecord {
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
  return r.session;
}

const LINES = [
  ev(
    'session.start',
    {
      sessionId: 'sess-1',
      copilotVersion: '1.0.103',
      producer: 'copilot-agent',
      startTime: '2026-10-01T10:00:00.000Z',
      selectedModel: 'claude-sonnet-4.5',
      context: { cwd: '/proj', gitRoot: '/proj', branch: 'main' },
    },
    '2026-10-01T10:00:00.010Z',
  ),
  ev('user.message', { content: '  ' }, '2026-10-01T10:00:01.000Z'),
  ev('user.message', { content: 'fix auth\nand add tests' }, '2026-10-01T10:00:02.000Z'),
  usage('2026-10-01T10:00:05.000Z', {
    model: 'claude-sonnet-4.5',
    inputTokens: 18592,
    outputTokens: 100,
    cacheReadTokens: 13434,
    cacheWriteTokens: 5148,
    reasoningTokens: 7,
    cost: 1,
  }),
  ev('tool.execution_start', { toolCallId: 't1', toolName: 'bash' }, '2026-10-01T10:00:06.000Z'),
  ev('tool.execution_start', { toolCallId: 't1', toolName: 'bash' }, '2026-10-01T10:00:06.500Z'),
  ev('tool.execution_start', { toolCallId: 't2', toolName: 'view' }, '2026-10-01T10:00:07.000Z'),
  ev('tool.execution_start', { toolCallId: 'task-1', toolName: 'task' }, '2026-10-01T10:00:08.000Z'),
  ev(
    'subagent.started',
    { toolCallId: 'task-1', agentName: 'explore', agentDisplayName: 'Explore', agentDescription: 'look around' },
    '2026-10-01T10:00:08.100Z',
  ),
  ev('user.message', { content: 'sub prompt' }, '2026-10-01T10:00:08.200Z', 'agent-a'),
  usage(
    '2026-10-01T10:00:09.000Z',
    { model: 'gpt-4.1', inputTokens: 40, outputTokens: 15, cacheReadTokens: 30, parentToolCallId: 'task-1', cost: 0 },
    'agent-a',
  ),
  ev(
    'tool.execution_start',
    { toolCallId: 's1', toolName: 'grep', parentToolCallId: 'task-1' },
    '2026-10-01T10:00:09.500Z',
    'agent-a',
  ),
  'not json',
  usage('2026-10-01T10:00:20.000Z', {
    model: 'gpt-5',
    inputTokens: 20000,
    outputTokens: 400,
    cacheReadTokens: 18000,
    cacheWriteTokens: 1000,
    reasoningTokens: 3,
    cost: 0.33,
  }),
  ev('session.shutdown', { shutdownType: 'routine', modelMetrics: {} }, '2026-10-01T10:05:00.000Z'),
];

describe('parseCopilotEvents', () => {
  test('skips blank, malformed, and type-less lines', () => {
    const events = parseCopilotEvents(['', '{bad', '[1]', '{"data":{}}', ev('user.message', {}, 't')].join('\n'));
    expect(events).toEqual([{ type: 'user.message', data: {}, timestamp: 't' }]);
  });

  test('keeps the top-level agentId', () => {
    expect(parseCopilotEvents(ev('user.message', {}, 't', 'a1'))[0].agentId).toBe('a1');
  });
});

describe('summarizeCopilotEvents', () => {
  const s = okSession(summarizeCopilotEvents(parseCopilotEvents(LINES.join('\n')), { sessionId: 'dir-id' }));

  test('session metadata comes from session.start; end is the last non-shutdown event', () => {
    expect(s.sessionId).toBe('dir-id');
    expect(s.copilotVersion).toBe('1.0.103');
    expect(s.cwd).toBe('/proj');
    expect(s.startTime).toBe('2026-10-01T10:00:00.000Z');
    expect(s.endTime).toBe('2026-10-01T10:00:20.000Z');
  });

  test('session.shutdown is the end time only when no other event has a timestamp', () => {
    const only = parseCopilotEvents(ev('session.shutdown', {}, '2026-10-02T00:00:00.000Z'));
    expect(okSession(summarizeCopilotEvents(only, { sessionId: 'x' })).endTime).toBe('2026-10-02T00:00:00.000Z');
  });

  test('root user turns and the first non-empty prompt as preview', () => {
    expect(s.userTurns).toBe(2);
    expect(s.preview).toBe('fix auth and add tests');
  });

  test('sums root usage only; input keeps its cache-inclusive meaning', () => {
    expect(s.tokens).toEqual({ input: 38592, output: 500, cacheRead: 31434, cacheWrite: 6148, reasoning: 10 });
    expect(s.model).toBe('gpt-5');
    expect(s.modelBreakdown.map((m) => m.model)).toEqual(['claude-sonnet-4.5', 'gpt-5']);
    expect(s.rootUsage).toHaveLength(2);
    expect(s.premiumRequests).toBeCloseTo(1.33);
  });

  test('lastContextTokens is the last root call input (already includes cache)', () => {
    expect(s.lastContextTokens).toBe(20000);
  });

  test('root tool calls are unique by toolCallId', () => {
    expect(s.toolCalls).toBe(3);
    expect(s.toolBreakdown).toEqual({ bash: 1, view: 1, task: 1 });
  });

  test('sub-agents group usage and tools by parentToolCallId', () => {
    expect(s.subagents).toEqual([
      {
        agentId: 'task-1',
        agentLabel: 'explore',
        description: 'look around',
        model: 'gpt-4.1',
        tokens: { input: 40, output: 15, cacheRead: 30, cacheWrite: 0, reasoning: 0 },
        modelBreakdown: [
          { model: 'gpt-4.1', tokens: { input: 40, output: 15, cacheRead: 30, cacheWrite: 0, reasoning: 0 } },
        ],
        toolCalls: 1,
        toolBreakdown: { grep: 1 },
      },
    ]);
  });

  test('falls back to the selected model and no context for a session without calls', () => {
    const empty = okSession(summarizeCopilotEvents(parseCopilotEvents(LINES[0]), { sessionId: 'e', title: 'T' }));
    expect(empty.model).toBe('claude-sonnet-4.5');
    expect(empty.title).toBe('T');
    expect(empty.lastContextTokens).toBeUndefined();
    expect(isEmptyCopilotSession(empty)).toBe(true);
    expect(isEmptyCopilotSession(s)).toBe(false);
  });

  test('reports the pre-usage_record format as legacy', () => {
    const legacy = [
      ev('session.start', { copilotVersion: '1.0.89', startTime: 't0' }, 't0'),
      ev('user.message', { content: 'hi' }, 't1'),
      ev('model.model_call_success', { modelCall: { model: 'gpt-5' } }, 't2'),
    ];
    expect(summarizeCopilotEvents(parseCopilotEvents(legacy.join('\n')), { sessionId: 'old' })).toEqual({
      kind: 'legacy',
      sessionId: 'old',
      copilotVersion: '1.0.89',
    });
    expect(copilotLegacyError('old', '1.0.89')).toContain('old');
    expect(copilotLegacyError('old', '1.0.89')).toContain('1.0.89');
  });
});

describe('parseWorkspaceTitle', () => {
  test('reads name:, falling back to summary:', () => {
    expect(parseWorkspaceTitle('id: x\nname: Fix Sidenav\nsummary: other\n')).toBe('Fix Sidenav');
    expect(parseWorkspaceTitle('id: x\nsummary: "Quoted: yes"\n')).toBe('Quoted: yes');
    expect(parseWorkspaceTitle("name: 'it''s'\n")).toBe("it's");
    expect(parseWorkspaceTitle('id: x\nsummary_count: 0\n')).toBeUndefined();
  });

  test('joins block-scalar names (copilot 1.0.103 writes long prompts as `name: |-`)', () => {
    const yaml = 'id: x\nname: |-\n  Run each command\n\n  (1) stat README.md\nuser_named: false\n';
    expect(parseWorkspaceTitle(yaml)).toBe('Run each command (1) stat README.md');
    expect(parseWorkspaceTitle('name: >\nsummary: fallback\n')).toBe('fallback');
  });
});

describe('pickCopilotSessionDir', () => {
  const dirs = [
    { id: 'aaaa1111', dir: '/s/aaaa1111', mtimeMs: 1 },
    { id: 'aaaa2222', dir: '/s/aaaa2222', mtimeMs: 2 },
    { id: 'bbbb', dir: '/s/bbbb', mtimeMs: 3 },
  ];

  test('exact, unique prefix, ambiguous, not found', () => {
    expect(pickCopilotSessionDir(dirs, 'bbbb')).toEqual({ ok: true, session: dirs[2] });
    expect(pickCopilotSessionDir(dirs, 'aaaa2')).toEqual({ ok: true, session: dirs[1] });
    expect(pickCopilotSessionDir(dirs, 'aaaa')).toEqual({
      ok: false,
      error: 'ambiguous',
      matches: ['aaaa1111', 'aaaa2222'],
    });
    expect(pickCopilotSessionDir(dirs, 'zz')).toEqual({ ok: false, error: 'not-found' });
  });
});

describe('defaultCopilotHome', () => {
  test('COPILOT_HOME wins, else ~/.copilot', () => {
    expect(defaultCopilotHome({ COPILOT_HOME: '/profiles/work' })).toBe('/profiles/work');
    expect(defaultCopilotHome({})).toBe('~/.copilot');
  });
});

describe('listCopilotSessionDirs / loadCopilotSessionDir', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('lists session dirs, marks the ones with events.jsonl, and reads workspace.yaml titles', () => {
    root = mkdtempSync(join(tmpdir(), 'copilot-events-'));
    mkdirSync(join(root, 'with-events'));
    mkdirSync(join(root, 'never-prompted'));
    writeFileSync(join(root, 'stray-file'), '');
    writeFileSync(join(root, 'with-events', 'events.jsonl'), LINES.join('\n'));
    writeFileSync(join(root, 'with-events', 'workspace.yaml'), 'id: with-events\nname: Fix Auth\n');

    const dirs = listCopilotSessionDirs(root).sort((a, b) => a.id.localeCompare(b.id));
    expect(dirs.map((d) => [d.id, d.eventsPath !== undefined])).toEqual([
      ['never-prompted', false],
      ['with-events', true],
    ]);
    expect(loadCopilotSessionDir(dirs[0])).toBeUndefined();
    const s = okSession(loadCopilotSessionDir(dirs[1])!);
    expect(s.sessionId).toBe('with-events');
    expect(s.title).toBe('Fix Auth');
  });
});
