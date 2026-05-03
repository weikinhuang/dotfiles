/**
 * Tests for lib/node/pi/subagent-loader.ts.
 *
 * Pure module — pi's `parseFrontmatter` is injected, so tests supply a
 * small YAML-subset parser that covers the frontmatter shapes used in
 * the default agent definitions.
 */

import { describe, expect, test } from 'vitest';

import {
  type AgentLoadWarning,
  type FrontmatterParser,
  loadAgents,
  type ReadLayer,
  validateAgent,
} from '../../../../lib/node/pi/subagent-loader.ts';

/**
 * Minimal YAML frontmatter parser sufficient for the test fixtures.
 * Handles the field shapes the default agents use: scalars, inline
 * arrays (`[a, b]`), and numeric literals. Mirrors pi's
 * `parseFrontmatter` contract (`{ frontmatter, body }`).
 */
const parseFrontmatter: FrontmatterParser = (src) => {
  const normalized = src.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: normalized };
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, '');
  const fm: Record<string, unknown> = {};
  for (const rawLine of header.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const val = line.slice(sep + 1).trim();
    if (val === '') continue;
    if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }
    const asNum = Number(val);
    if (Number.isFinite(asNum) && /^-?\d+(\.\d+)?$/.test(val)) {
      fm[key] = asNum;
      continue;
    }
    fm[key] = val.replace(/^["']|["']$/g, '');
  }
  return { frontmatter: fm, body };
};

function makeFs(files: Record<string, string>, dirs: Record<string, string[]>): ReadLayer {
  return {
    listMarkdownFiles: (dir) => dirs[dir] ?? null,
    readFile: (path) => files[path] ?? null,
  };
}

const KNOWN_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']);

// ──────────────────────────────────────────────────────────────────────
// validateAgent
// ──────────────────────────────────────────────────────────────────────

describe('validateAgent', () => {
  test('accepts a minimal explore-style definition', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/explore.md',
      source: 'global',
      frontmatter: {
        name: 'explore',
        description: 'read-only exploration',
      },
      body: 'You are an exploration sub-agent.\n',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(warnings).toEqual([]);
    expect(out?.name).toBe('explore');
    expect(out?.tools).toEqual(['read', 'grep', 'find', 'ls']);
    expect(out?.model).toBe('inherit');
    expect(out?.maxTurns).toBe(20);
    expect(out?.timeoutMs).toBe(180_000);
    expect(out?.isolation).toBe('shared-cwd');
    expect(out?.body).toBe('You are an exploration sub-agent.');
  });

  test('rejects invalid name shape', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/bad.md',
      source: 'user',
      frontmatter: { name: 'Bad_Name', description: 'x' },
      body: '',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out).toBeNull();
    expect(warnings[0]?.reason).toMatch(/must match/);
  });

  test('rejects missing description', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/x.md',
      source: 'user',
      frontmatter: { name: 'x' },
      body: '',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out).toBeNull();
    expect(warnings[0]?.reason).toMatch(/description/);
  });

  test('drops unknown tools with a warning, keeps known ones', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/x.md',
      source: 'user',
      frontmatter: {
        name: 'x',
        description: 'desc',
        tools: ['read', 'subagent', 'grep'],
      },
      body: '',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out?.tools).toEqual(['read', 'grep']);
    expect(warnings[0]?.reason).toMatch(/unknown tool "subagent"/);
  });

  test('rejects malformed model', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/x.md',
      source: 'user',
      frontmatter: { name: 'x', description: 'd', model: 'no-slash' },
      body: '',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out).toBeNull();
    expect(warnings[0]?.reason).toMatch(/invalid model/);
  });

  test('accepts provider/id model', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/x.md',
      source: 'user',
      frontmatter: { name: 'x', description: 'd', model: 'anthropic/claude-opus-4-7' },
      body: '',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out?.model).toEqual({ provider: 'anthropic', modelId: 'claude-opus-4-7' });
  });

  test('rejects invalid thinkingLevel', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/x.md',
      source: 'user',
      frontmatter: { name: 'x', description: 'd', thinkingLevel: 'turbo' },
      body: '',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out).toBeNull();
    expect(warnings[0]?.reason).toMatch(/thinkingLevel/);
  });

  test('accepts thinkingLevel: inherit as a synonym for unset', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/x.md',
      source: 'user',
      frontmatter: { name: 'x', description: 'd', thinkingLevel: 'inherit' },
      body: '',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out).not.toBeNull();
    expect(out?.thinkingLevel).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test('rejects non-positive maxTurns', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/x.md',
      source: 'user',
      frontmatter: { name: 'x', description: 'd', maxTurns: 0 },
      body: '',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out).toBeNull();
    expect(warnings[0]?.reason).toMatch(/maxTurns/);
  });

  test('rejects unknown isolation', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/x.md',
      source: 'user',
      frontmatter: { name: 'x', description: 'd', isolation: 'container' },
      body: '',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out).toBeNull();
    expect(warnings[0]?.reason).toMatch(/isolation/);
  });

  test('tools as non-array is fatal', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/x.md',
      source: 'user',
      frontmatter: { name: 'x', description: 'd', tools: 'read' },
      body: '',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out).toBeNull();
    expect(warnings[0]?.reason).toMatch(/tools/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// loadAgents
// ──────────────────────────────────────────────────────────────────────

describe('loadAgents', () => {
  test('merges layers with highest-priority winning', () => {
    const files = {
      '/global/explore.md': `---
name: explore
description: global explore
---
body`,
      '/user/explore.md': `---
name: explore
description: user explore
---
body`,
      '/project/build.md': `---
name: build
description: project build
tools: [bash, edit]
---
body`,
    };
    const dirs = {
      '/global': ['explore.md'],
      '/user': ['explore.md'],
      '/project': ['build.md'],
    };
    const result = loadAgents({
      layers: [
        { source: 'global', dir: '/global' },
        { source: 'user', dir: '/user' },
        { source: 'project', dir: '/project' },
      ],
      knownToolNames: KNOWN_TOOLS,
      fs: makeFs(files, dirs),
      parseFrontmatter,
    });
    const explore = result.agents.get('explore');

    expect(explore?.description).toBe('user explore');
    expect(explore?.source).toBe('user');
    expect(result.agents.get('build')?.source).toBe('project');
    expect(result.nameOrder).toEqual(['build', 'explore']);
  });

  test('missing directories are silently skipped', () => {
    const result = loadAgents({
      layers: [{ source: 'project', dir: '/nowhere' }],
      knownToolNames: KNOWN_TOOLS,
      fs: makeFs({}, {}),
      parseFrontmatter,
    });

    expect(result.agents.size).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  test('non-.md files are ignored', () => {
    const files = { '/g/README.txt': 'nope' };
    const dirs = { '/g': ['README.txt'] };
    const result = loadAgents({
      layers: [{ source: 'global', dir: '/g' }],
      knownToolNames: KNOWN_TOOLS,
      fs: makeFs(files, dirs),
      parseFrontmatter,
    });

    expect(result.agents.size).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  test('malformed frontmatter yields one warning and skips the file', () => {
    const files = { '/g/broken.md': 'no frontmatter here' };
    const dirs = { '/g': ['broken.md'] };
    const result = loadAgents({
      layers: [{ source: 'global', dir: '/g' }],
      knownToolNames: KNOWN_TOOLS,
      fs: makeFs(files, dirs),
      parseFrontmatter,
    });

    expect(result.agents.size).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].reason).toMatch(/frontmatter/);
  });

  test('malformed higher-priority file does not shadow a valid lower-priority agent', () => {
    const files = {
      '/global/explore.md': `---
name: explore
description: global explore
---
body`,
      '/user/explore.md': 'not valid markdown',
    };
    const dirs = {
      '/global': ['explore.md'],
      '/user': ['explore.md'],
    };
    const result = loadAgents({
      layers: [
        { source: 'global', dir: '/global' },
        { source: 'user', dir: '/user' },
      ],
      knownToolNames: KNOWN_TOOLS,
      fs: makeFs(files, dirs),
      parseFrontmatter,
    });

    // Global survives because the user-scope override failed validation.
    expect(result.agents.get('explore')?.source).toBe('global');
    expect(result.agents.get('explore')?.description).toBe('global explore');
    expect(result.warnings.some((w) => w.path === '/user/explore.md')).toBe(true);
  });
});
