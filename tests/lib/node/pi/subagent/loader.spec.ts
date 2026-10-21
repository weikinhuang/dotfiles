/**
 * Tests for lib/node/pi/subagent/loader.ts.
 *
 * Pure module - pi's `parseFrontmatter` is injected, so tests supply a
 * small YAML-subset parser that covers the frontmatter shapes used in
 * the default agent definitions.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { formatAgentListDescription } from '../../../../../lib/node/pi/subagent/format.ts';
import {
  ANY_TOOL_NAME,
  type AgentLoadResult,
  type AgentLoadWarning,
  type FrontmatterParser,
  loadAgents,
  makeNodeReadLayer,
  type ReadLayer,
  resolveAgentWithRescan,
  resolveKnownToolNames,
  validateAgent,
} from '../../../../../lib/node/pi/subagent/loader.ts';

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

describe('makeNodeReadLayer', () => {
  test('lists directory entries and reads UTF-8 files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-loader-'));
    try {
      writeFileSync(join(dir, 'explore.md'), 'body\n', 'utf8');
      const fs = makeNodeReadLayer();

      expect(fs.listMarkdownFiles(dir)).toContain('explore.md');
      expect(fs.readFile(join(dir, 'explore.md'))).toBe('body\n');
      expect(fs.listMarkdownFiles(join(dir, 'missing'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
    expect(out?.context).toBe('fresh');
    expect(out?.body).toBe('You are an exploration sub-agent.');
    // New gate fields default to empty / undefined when omitted.
    expect(out?.bashAllow).toEqual([]);
    expect(out?.bashDeny).toEqual([]);
    expect(out?.writeRoots).toEqual([]);
    expect(out?.requestOptions).toBeUndefined();
  });

  test('parses bashAllow / bashDeny / writeRoots / requestOptions', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/agent.md',
      source: 'project',
      frontmatter: {
        name: 'planner',
        description: 'plan agent',
        bashAllow: ['rg *', 'ai-fetch-web *'],
        bashDeny: ['curl *'],
        writeRoots: ['plans/', '~/.pi/agent/personas/{projectSlug}/'],
        requestOptions: {
          apis: ['openai-completions'],
          temperature: 0.6,
          chat_template_kwargs: { enable_thinking: true },
        },
      },
      body: 'body',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(warnings).toEqual([]);
    expect(out?.bashAllow).toEqual(['rg *', 'ai-fetch-web *']);
    expect(out?.bashDeny).toEqual(['curl *']);
    expect(out?.writeRoots).toEqual(['plans/', '~/.pi/agent/personas/{projectSlug}/']);
    expect(out?.requestOptions).toEqual({
      apis: ['openai-completions'],
      temperature: 0.6,
      chat_template_kwargs: { enable_thinking: true },
    });
  });

  test('non-string bashAllow entries dropped with warnings', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/agent.md',
      source: 'project',
      frontmatter: {
        name: 'planner',
        description: 'plan agent',
        bashAllow: ['rg *', 42, 'ai-fetch-web *'],
      },
      body: 'body',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out?.bashAllow).toEqual(['rg *', 'ai-fetch-web *']);
    expect(warnings.some((w) => w.reason.includes('bashAllow'))).toBe(true);
  });

  test('non-array bashAllow → warning, field dropped to []', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/agent.md',
      source: 'project',
      frontmatter: {
        name: 'planner',
        description: 'plan agent',
        bashAllow: 'rg *',
      },
      body: 'body',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out?.bashAllow).toEqual([]);
    expect(warnings.some((w) => w.reason.includes('bashAllow'))).toBe(true);
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

  test('parses context: inherit', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/x.md',
      source: 'user',
      frontmatter: { name: 'x', description: 'd', context: 'inherit' },
      body: '',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(warnings).toEqual([]);
    expect(out?.context).toBe('inherit');
  });

  test('rejects unknown context', () => {
    const warnings: AgentLoadWarning[] = [];
    const out = validateAgent({
      path: '/p/x.md',
      source: 'user',
      frontmatter: { name: 'x', description: 'd', context: 'parent' },
      body: '',
      knownToolNames: KNOWN_TOOLS,
      warnings,
    });

    expect(out).toBeNull();
    expect(warnings[0]?.reason).toMatch(/context/);
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

  test('README.md is skipped without a frontmatter warning', () => {
    // Directory-index READMEs are human-facing docs, not agent specs - the
    // loader must not treat them as malformed agents.
    const files = {
      '/g/README.md': '# pi subagent definitions\n\nIndex of agents in this dir.\n',
      '/g/readme.md': '# lowercase readme variant',
      '/g/explore.md': `---
name: explore
description: global explore
---
body`,
    };
    const dirs = { '/g': ['README.md', 'readme.md', 'explore.md'] };
    const result = loadAgents({
      layers: [{ source: 'global', dir: '/g' }],
      knownToolNames: KNOWN_TOOLS,
      fs: makeFs(files, dirs),
      parseFrontmatter,
    });

    expect(result.agents.size).toBe(1);
    expect(result.agents.get('explore')?.source).toBe('global');
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

// ──────────────────────────────────────────────────────────────────────
// Startup ordering + lazy re-scan
// ──────────────────────────────────────────────────────────────────────

const AGENT_MD = (name: string, tools = '[read, bash]'): string =>
  `---\nname: ${name}\ndescription: ${name} agent for tests\ntools: ${tools}\n---\n\n# ${name}\n`;

describe('resolveKnownToolNames', () => {
  test('returns the registry names when pi.getAllTools() works', () => {
    const filter = resolveKnownToolNames(() => [{ name: 'read' }, { name: 'bash' }]);
    expect(filter.has('read')).toBe(true);
    expect(filter.has('write')).toBe(false);
  });

  test('falls back to a permissive filter when getAllTools throws (extension-loading stub)', () => {
    const filter = resolveKnownToolNames(() => {
      throw new Error('Extension runtime not initialized. Action methods cannot be called during extension loading.');
    });
    expect(filter).toBe(ANY_TOOL_NAME);
    expect(filter.has('anything')).toBe(true);
  });

  test('regression: a factory-time load (before pi binds getAllTools) still lists agents in the tool description', () => {
    const fs = makeFs(
      { '/g/explore.md': AGENT_MD('explore', '[read, grep]'), '/g/general-purpose.md': AGENT_MD('general-purpose') },
      { '/g': ['explore.md', 'general-purpose.md'] },
    );
    const result = loadAgents({
      layers: [{ source: 'global', dir: '/g' }],
      knownToolNames: resolveKnownToolNames(() => {
        throw new Error('Extension runtime not initialized');
      }),
      fs,
      parseFrontmatter,
    });
    expect(result.nameOrder).toEqual(['explore', 'general-purpose']);
    expect(result.warnings).toEqual([]);
    expect(result.agents.get('general-purpose')?.tools).toEqual(['read', 'bash']);
    const description = formatAgentListDescription(
      result.nameOrder.map((n) => ({ name: n, description: result.agents.get(n)?.description ?? '' })),
    );
    expect(description).not.toContain('No agent definitions loaded');
    expect(description).toContain('explore');
    expect(description).toContain('general-purpose');
  });
});

describe('resolveAgentWithRescan', () => {
  test('a hit does not rescan', () => {
    const fs = makeFs({ '/g/explore.md': AGENT_MD('explore') }, { '/g': ['explore.md'] });
    const loaded = loadAgents({
      layers: [{ source: 'global', dir: '/g' }],
      knownToolNames: KNOWN_TOOLS,
      fs,
      parseFrontmatter,
    });
    let rescans = 0;
    const out = resolveAgentWithRescan(
      'explore',
      () => loaded,
      () => {
        rescans++;
      },
    );
    expect(out.agent?.name).toBe('explore');
    expect(out.rescanned).toBe(false);
    expect(rescans).toBe(0);
  });

  test('picks up a project agent created mid-session without /reload', () => {
    const root = mkdtempSync(join(tmpdir(), 'subagent-rescan-'));
    try {
      const layers = [{ source: 'project' as const, dir: root }];
      const load = (): AgentLoadResult =>
        loadAgents({ layers, knownToolNames: KNOWN_TOOLS, fs: makeNodeReadLayer(), parseFrontmatter });
      let current = load();
      expect(current.agents.has('foo')).toBe(false);

      writeFileSync(join(root, 'foo.md'), AGENT_MD('foo'), 'utf8');
      let rescans = 0;
      const out = resolveAgentWithRescan(
        'foo',
        () => current,
        () => {
          rescans++;
          current = load();
        },
      );
      expect(rescans).toBe(1);
      expect(out.rescanned).toBe(true);
      expect(out.agent?.name).toBe('foo');
      expect(out.agent?.source).toBe('project');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a name still unknown after the single rescan returns undefined', () => {
    const empty: AgentLoadResult = { agents: new Map(), nameOrder: [], warnings: [] };
    let rescans = 0;
    const out = resolveAgentWithRescan(
      'nope',
      () => empty,
      () => {
        rescans++;
      },
    );
    expect(out).toEqual({ agent: undefined, rescanned: true });
    expect(rescans).toBe(1);
  });
});
