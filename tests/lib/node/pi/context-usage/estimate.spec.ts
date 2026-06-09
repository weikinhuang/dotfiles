/**
 * Tests for lib/node/pi/context-usage/estimate.ts. Pure module.
 */

import { describe, expect, test } from 'vitest';

import {
  buildBreakdown,
  charsToTokens,
  estimateMessageTokens,
  splitInjectedAddenda,
} from '../../../../../lib/node/pi/context-usage/estimate.ts';
import type { BreakdownInput, CategoryNode } from '../../../../../lib/node/pi/context-usage/types.ts';

const find = (node: CategoryNode | undefined, id: string): CategoryNode | undefined => {
  if (!node) return undefined;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return undefined;
};

describe('charsToTokens', () => {
  test('ceil divide by 4, clamps negatives', () => {
    expect(charsToTokens(0)).toBe(0);
    expect(charsToTokens(1)).toBe(1);
    expect(charsToTokens(4)).toBe(1);
    expect(charsToTokens(5)).toBe(2);
    expect(charsToTokens(-9)).toBe(0);
  });
});

describe('estimateMessageTokens', () => {
  test('user string content', () => {
    expect(estimateMessageTokens({ role: 'user', content: 'a'.repeat(40) })).toBe(10);
  });
  test('user image content counts 4800 chars', () => {
    expect(estimateMessageTokens({ role: 'user', content: [{ type: 'image', data: 'x' }] })).toBe(1200);
  });
  test('assistant splits text/thinking/toolCall', () => {
    const tok = estimateMessageTokens({
      role: 'assistant',
      content: [
        { type: 'text', text: 'a'.repeat(20) },
        { type: 'thinking', thinking: 'b'.repeat(20) },
        { type: 'toolCall', name: 'read', arguments: { path: 'x' } },
      ],
    });
    // 20 + 20 + (4 + len('{"path":"x"}')=12) = 56 chars → 14 tokens
    expect(tok).toBe(charsToTokens(56));
  });
  test('toolResult content', () => {
    expect(
      estimateMessageTokens({ role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'z'.repeat(8) }] }),
    ).toBe(2);
  });
  test('bashExecution command + output', () => {
    expect(estimateMessageTokens({ role: 'bashExecution', command: 'ls', output: 'a'.repeat(6) })).toBe(2);
  });
  test('summaries', () => {
    expect(estimateMessageTokens({ role: 'compactionSummary', summary: 'x'.repeat(12) })).toBe(3);
  });
});

describe('splitInjectedAddenda', () => {
  test('splits labeled blank-line sections', () => {
    const base = 'BASE PROMPT BODY';
    const eff = `${base}\n\n## Todos\n- a\n- b\n\n## Memory\nfoo bar`;
    const sections = splitInjectedAddenda(eff, base);
    expect(sections).toHaveLength(2);
    expect(sections[0].label).toContain('Todos');
    expect(sections[1].label).toContain('Memory');
  });
  test('single block → [] (caller shows one row)', () => {
    const base = 'BASE';
    expect(splitInjectedAddenda(`${base}\n\nonly one block`, base)).toEqual([]);
  });
  test('effective not extending base → []', () => {
    expect(splitInjectedAddenda('totally different', 'BASE PROMPT')).toEqual([]);
  });
});

describe('buildBreakdown', () => {
  const baseInput = (over: Partial<BreakdownInput> = {}): BreakdownInput => ({
    effectiveSystemPrompt: 'X'.repeat(400),
    baseSystemPrompt: 'X'.repeat(400),
    systemPromptOptions: {
      contextFiles: [
        { path: 'AGENTS.md', content: 'a'.repeat(800) },
        { path: 'sub/AGENTS.md', content: 'b'.repeat(400) },
      ],
      skills: [{ name: 'skill-one', description: 'd', body: 'c'.repeat(200) }],
      toolSnippets: { read: 'read a file', bash: 'run a command' },
      promptGuidelines: ['be concise', 'show paths'],
    },
    allTools: [
      { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: {} } } },
      { name: 'bash', description: 'Run bash', parameters: { type: 'object', properties: { command: {} } } },
      { name: 'inactive_tool', description: 'x', parameters: {} },
    ],
    activeToolNames: ['read', 'bash'],
    messages: [
      { role: 'user', content: 'hello '.repeat(20) },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'response '.repeat(20) },
          { type: 'thinking', thinking: 'reasoning '.repeat(40) },
          { type: 'toolCall', name: 'read', arguments: { path: '/x' } },
        ],
        usage: { input: 1000, output: 200, cacheRead: 800, cacheWrite: 50, totalTokens: 2050 },
      },
      { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'file '.repeat(50) }] },
      { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'out '.repeat(80) }], isError: true },
    ],
    contextWindow: 200000,
    realTokens: 12000,
    modelId: 'qwen3-6-27b',
    provider: 'llama-cpp',
    ...over,
  });

  test('root tokens = context window; top-level categories present', () => {
    const b = buildBreakdown(baseInput());
    expect(b.root.tokens).toBe(200000);
    const ids = (b.root.children ?? []).map((c) => c.id).sort();
    expect(ids).toEqual(['conv', 'sys', 'tools']);
  });

  test('every non-root node: children sum to parent tokens', () => {
    const b = buildBreakdown(baseInput());
    const mismatches: string[] = [];
    const visit = (node: CategoryNode, isRoot: boolean): void => {
      if (node.children && node.children.length > 0) {
        const sum = node.children.reduce((s, c) => s + c.tokens, 0);
        if (!isRoot && node.tokens !== sum) mismatches.push(`${node.id}: ${node.tokens} != ${sum}`);
        node.children.forEach((c) => visit(c, false));
      }
    };
    visit(b.root, true);
    expect(mismatches).toEqual([]);
  });

  test('context files sized individually and sorted desc', () => {
    const b = buildBreakdown(baseInput());
    const files = find(b.root, 'sys.contextFiles');
    expect(files?.children?.map((c) => c.label)).toEqual(['AGENTS.md', 'sub/AGENTS.md']);
    expect(files?.children?.[0].tokens).toBe(charsToTokens(800));
    // raw content attached for the scrollable viewer
    expect(files?.children?.[0].content).toBe('a'.repeat(800));
  });

  test('leaf nodes carry raw content for the viewer', () => {
    const b = buildBreakdown(baseInput());
    expect(find(b.root, 'sys.skill.0')?.content).toBe('c'.repeat(200));
    const params = b.root.children
      ?.find((c) => c.id === 'tools')
      ?.children?.[0]?.children?.find((c) => c.id.endsWith('.params'));
    expect(params?.content).toContain('"type": "object"');
    const bash = find(b.root, 'conv.tool.bash');
    expect(bash?.children?.[0].content).toContain('out');
  });

  test('only active tools are sized; inactive noted in detail', () => {
    const b = buildBreakdown(baseInput());
    const tools = find(b.root, 'tools');
    expect(tools?.label).toBe('System tools (2)');
    expect(tools?.children?.map((c) => c.label).sort()).toEqual(['bash', 'read']);
    expect(tools?.detail).toContain('1 configured but inactive');
  });

  test('assistant split into response / reasoning / tool-args', () => {
    const b = buildBreakdown(baseInput());
    const asst = find(b.root, 'conv.assistant');
    const labels = asst?.children?.map((c) => c.id).sort();
    expect(labels).toEqual(['conv.asst.args', 'conv.asst.text', 'conv.asst.think']);
    // reasoning bucket is real and non-trivial
    expect(find(b.root, 'conv.asst.think')?.tokens).toBeGreaterThan(0);
  });

  test('tool results grouped by tool name with individual entries', () => {
    const b = buildBreakdown(baseInput());
    const results = find(b.root, 'conv.toolResults');
    const groups = results?.children?.map((c) => c.label).sort();
    expect(groups).toEqual(['bash', 'read']);
    const bash = find(b.root, 'conv.tool.bash');
    expect(bash?.children?.[0].label).toContain('error');
  });

  test('injected addenda appears when effective extends base', () => {
    const base = 'B'.repeat(400);
    const eff = `${base}\n\n## Todos\n- x\n\n## Scratchpad\nnote`;
    const b = buildBreakdown(baseInput({ effectiveSystemPrompt: eff, baseSystemPrompt: base }));
    const injected = find(b.root, 'sys.injected');
    expect(injected).toBeTruthy();
    expect(injected?.children?.length).toBe(2);
  });

  test('lastUsage taken from most recent assistant message', () => {
    const b = buildBreakdown(baseInput());
    expect(b.lastUsage?.input).toBe(1000);
    expect(b.lastUsage?.cacheRead).toBe(800);
  });

  test('estimatedUsed = sum of top-level categories', () => {
    const b = buildBreakdown(baseInput());
    const sum = (b.root.children ?? []).reduce((s, c) => s + c.tokens, 0);
    expect(b.estimatedUsed).toBe(sum);
  });

  test('zero context window falls back to estimated used', () => {
    const b = buildBreakdown(baseInput({ contextWindow: 0 }));
    expect(b.root.tokens).toBe(b.estimatedUsed);
  });
});
