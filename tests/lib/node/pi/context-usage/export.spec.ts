/**
 * Tests for lib/node/pi/context-usage/export.ts. Pure module.
 */

import { describe, expect, test } from 'vitest';

import { exportFilename, renderMarkdown } from '../../../../../lib/node/pi/context-usage/export.ts';
import type { Breakdown } from '../../../../../lib/node/pi/context-usage/types.ts';

const breakdown: Breakdown = {
  root: {
    id: 'root',
    label: 'Context window',
    tokens: 200000,
    children: [
      {
        id: 'sys',
        label: 'System prompt',
        tokens: 6000,
        children: [
          { id: 'sys.core', label: 'Core', tokens: 4000 },
          {
            id: 'sys.files',
            label: 'Context files (1)',
            tokens: 2000,
            children: [{ id: 'f', label: 'AGENTS.md', tokens: 2000, detail: '8,000 bytes' }],
          },
        ],
      },
      { id: 'tools', label: 'System tools (2)', tokens: 4000 },
    ],
  },
  estimatedUsed: 10000,
  realTokens: 12000,
  contextWindow: 200000,
  lastUsage: { input: 1000, output: 200, cacheRead: 800, cacheWrite: 0, totalTokens: 2000 },
  modelId: 'qwen3-6-27b',
  provider: 'llama-cpp',
};

const NOW = new Date('2026-06-09T12:00:00.000Z');

describe('renderMarkdown', () => {
  test('includes header facts', () => {
    const md = renderMarkdown(breakdown, NOW);
    expect(md).toContain('# Context usage breakdown');
    expect(md).toContain('qwen3-6-27b (llama-cpp)');
    expect(md).toContain('Real usage (provider): 12k');
    expect(md).toContain('Estimated used');
    expect(md).toContain('Free space:');
    expect(md).toContain('cache-hit');
    expect(md).toContain('2026-06-09T12:00:00.000Z');
  });

  test('renders nested tree with indentation', () => {
    const md = renderMarkdown(breakdown, NOW);
    expect(md).toContain('- System prompt: 6k');
    expect(md).toContain('  - Core: 4k');
    expect(md).toContain('    - AGENTS.md: 2k');
    expect(md).toContain('— 8,000 bytes');
  });

  test('unknown real usage when null', () => {
    const md = renderMarkdown({ ...breakdown, realTokens: null }, NOW);
    expect(md).toContain('Real usage (provider): unknown');
  });
});

describe('exportFilename', () => {
  test('timestamped, filesystem-safe', () => {
    expect(exportFilename(NOW)).toBe('context-usage-2026-06-09T12-00-00-000Z.md');
  });
});
