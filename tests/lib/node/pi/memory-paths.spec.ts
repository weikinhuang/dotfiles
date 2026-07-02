/**
 * Tests for lib/node/pi/memory-paths.ts.
 *
 * Uses the real filesystem via `os.tmpdir()` with `PI_MEMORY_ROOT` pointed
 * at isolated per-test directories.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  atomicWriteFile,
  chooseMemorySlug,
  fileFor,
  globalDir,
  indexFileFor,
  listSessionMemoryDirs,
  memoryRoot,
  projectDir,
  projectSlug,
  pruneOrphanSessionDirs,
  readMemoryBody,
  readMemoryFrontmatter,
  rebuildMemoryIndex,
  scanScope,
  sessionDir,
  sessionsParentDir,
  slugifyName,
  uniqueSlug,
} from '../../../../lib/node/pi/memory-paths.ts';
import { emptyState, type MemoryEntry, serializeMemory, upsertEntry } from '../../../../lib/node/pi/memory-reducer.ts';

let sandbox: string;
const originalRoot = process.env.PI_MEMORY_ROOT;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-memory-'));
  process.env.PI_MEMORY_ROOT = sandbox;
});

afterEach(() => {
  if (originalRoot === undefined) delete process.env.PI_MEMORY_ROOT;
  else process.env.PI_MEMORY_ROOT = originalRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// cwdSlug - must match pi's session-dir naming convention.
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// slugifyName / uniqueSlug
// ──────────────────────────────────────────────────────────────────────

test('slugifyName: lowercases and replaces whitespace/punct', () => {
  expect(slugifyName('Alice Prefers Tabs!')).toBe('alice-prefers-tabs');
  expect(slugifyName('  hello_world  ')).toBe('hello-world');
});

test('slugifyName: handles empty input', () => {
  expect(slugifyName('')).toBe('memory');
  expect(slugifyName('   !!! ')).toBe('memory');
});

test('uniqueSlug: returns base if free', () => {
  expect(uniqueSlug('alice', new Set())).toBe('alice');
});

test('uniqueSlug: appends -2, -3 on collision', () => {
  expect(uniqueSlug('alice', new Set(['alice']))).toBe('alice-2');
  expect(uniqueSlug('alice', new Set(['alice', 'alice-2']))).toBe('alice-3');
});

test('chooseMemorySlug: slugifies and skips collisions in the selected scope', () => {
  const entry: MemoryEntry = {
    id: 'alice-prefers-tabs',
    scope: 'global',
    type: 'user',
    name: 'Alice',
    description: 'd',
  };
  const state = { ...emptyState(), index: upsertEntry(emptyState().index, entry) };

  expect(chooseMemorySlug(state, 'global', 'Alice Prefers Tabs')).toBe('alice-prefers-tabs-2');
  expect(chooseMemorySlug(state, 'project', 'Alice Prefers Tabs')).toBe('alice-prefers-tabs');
  expect(chooseMemorySlug(state, 'global', 'Alice Prefers Tabs', 'alice-prefers-tabs')).toBe('alice-prefers-tabs');
});

// ──────────────────────────────────────────────────────────────────────
// memoryRoot / dir helpers
// ──────────────────────────────────────────────────────────────────────

test('memoryRoot: honours PI_MEMORY_ROOT', () => {
  expect(memoryRoot()).toBe(sandbox);
});

test('memoryRoot: defaults to ~/.pi/agent/memory when unset', () => {
  delete process.env.PI_MEMORY_ROOT;
  const r = memoryRoot();

  expect(r).toMatch(/\.pi[/\\]agent[/\\]memory$/);
});

test('globalDir / projectDir / fileFor / indexFileFor line up', () => {
  const cwd = '/tmp/pi-test';

  expect(globalDir()).toBe(join(sandbox, 'global'));
  expect(projectDir(cwd)).toBe(join(sandbox, 'projects', '--tmp-pi-test--'));
  expect(fileFor('global', 'user', 'alice', cwd)).toBe(join(sandbox, 'global', 'user', 'alice.md'));
  expect(fileFor('project', 'project', 'release', cwd)).toBe(
    join(sandbox, 'projects', '--tmp-pi-test--', 'project', 'release.md'),
  );
  expect(indexFileFor('global', cwd)).toBe(join(sandbox, 'global', 'MEMORY.md'));
  expect(indexFileFor('project', cwd)).toBe(join(sandbox, 'projects', '--tmp-pi-test--', 'MEMORY.md'));
});

test('projectSlug: defaults to cwdSlug when PI_MEMORY_PROJECT_SLUG unset', () => {
  delete process.env.PI_MEMORY_PROJECT_SLUG;
  expect(projectSlug('/tmp/pi-test')).toBe('--tmp-pi-test--');
});

test('projectSlug: honours PI_MEMORY_PROJECT_SLUG regardless of cwd', () => {
  process.env.PI_MEMORY_PROJECT_SLUG = 'rp';
  try {
    expect(projectSlug('/tmp/pi-test')).toBe('rp');
    expect(projectSlug('/somewhere/else/entirely')).toBe('rp');
  } finally {
    delete process.env.PI_MEMORY_PROJECT_SLUG;
  }
});

test('projectSlug: blank/whitespace override falls back to cwdSlug', () => {
  process.env.PI_MEMORY_PROJECT_SLUG = '   ';
  try {
    expect(projectSlug('/tmp/pi-test')).toBe('--tmp-pi-test--');
  } finally {
    delete process.env.PI_MEMORY_PROJECT_SLUG;
  }
});

test('projectDir: uses the fixed slug when PI_MEMORY_PROJECT_SLUG is set', () => {
  process.env.PI_MEMORY_PROJECT_SLUG = 'rp';
  try {
    // Two different cwds resolve to the same project dir under the override.
    expect(projectDir('/tmp/pi-test')).toBe(join(sandbox, 'projects', 'rp'));
    expect(projectDir('/renamed/workspace')).toBe(join(sandbox, 'projects', 'rp'));
    // Session paths derive from projectDir, so they follow the override too.
    expect(sessionsParentDir('/renamed/workspace')).toBe(join(sandbox, 'projects', 'rp', 'sessions'));
    expect(sessionDir('/renamed/workspace', 's1')).toBe(join(sandbox, 'projects', 'rp', 'sessions', 's1'));
  } finally {
    delete process.env.PI_MEMORY_PROJECT_SLUG;
  }
});

test('sessionDir / session fileFor / indexFileFor are keyed under the project dir', () => {
  const cwd = '/tmp/pi-test';
  const sid = 'sess-1';

  expect(sessionsParentDir(cwd)).toBe(join(sandbox, 'projects', '--tmp-pi-test--', 'sessions'));
  expect(sessionDir(cwd, sid)).toBe(join(sandbox, 'projects', '--tmp-pi-test--', 'sessions', sid));
  expect(fileFor('session', 'note', 'scratch', cwd, sid)).toBe(
    join(sandbox, 'projects', '--tmp-pi-test--', 'sessions', sid, 'note', 'scratch.md'),
  );
  expect(indexFileFor('session', cwd, sid)).toBe(
    join(sandbox, 'projects', '--tmp-pi-test--', 'sessions', sid, 'MEMORY.md'),
  );
});

test('fileFor: session scope without a sessionId throws', () => {
  expect(() => fileFor('session', 'note', 'scratch', '/tmp/pi-test')).toThrow(/session scope requires a sessionId/);
});

// ──────────────────────────────────────────────────────────────────────
// atomicWriteFile - parent auto-created, replaces existing file.
// ──────────────────────────────────────────────────────────────────────

test('atomicWriteFile: creates parent and writes contents', () => {
  const target = join(sandbox, 'a', 'b', 'c.txt');
  atomicWriteFile(target, 'hello');

  expect(readFileSync(target, 'utf8')).toBe('hello');
});

test('atomicWriteFile: overwrites existing file', () => {
  const target = join(sandbox, 'c.txt');
  atomicWriteFile(target, 'v1');
  atomicWriteFile(target, 'v2');

  expect(readFileSync(target, 'utf8')).toBe('v2');
});

test('atomicWriteFile: bare filename (relative path in cwd)', () => {
  const originalCwd = process.cwd();
  process.chdir(sandbox);
  try {
    atomicWriteFile('bare.txt', 'ok');

    expect(readFileSync(join(sandbox, 'bare.txt'), 'utf8')).toBe('ok');
  } finally {
    process.chdir(originalCwd);
  }
});

// ──────────────────────────────────────────────────────────────────────
// scanScope: reads real files + handles malformed siblings.
// ──────────────────────────────────────────────────────────────────────

function writeMemory(dir: string, filename: string, fm: Record<string, string>, body: string): void {
  mkdirSync(dir, { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push('---', '', body, '');
  writeFileSync(join(dir, filename), lines.join('\n'), 'utf8');
}

test('scanScope: global skips project-only types', () => {
  const scopeDir = join(sandbox, 'global');
  writeMemory(join(scopeDir, 'user'), 'alice.md', { name: 'Alice', description: 'd', type: 'user' }, 'body');
  writeMemory(
    join(scopeDir, 'feedback'),
    'tests.md',
    { name: 'Tests', description: 'tests rule', type: 'feedback' },
    '',
  );
  // A project-only type under global - should be ignored even if present.
  writeMemory(join(scopeDir, 'project'), 'bogus.md', { name: 'X', description: 'd', type: 'project' }, '');
  const { entries, warnings } = scanScope(scopeDir, 'global');
  const ids = entries.map((e) => e.id).sort();

  expect(ids).toEqual(['alice', 'tests']);
  expect(entries.every((e) => e.scope === 'global')).toBe(true);
  expect(warnings).toEqual([]);
});

test('scanScope: project sees all four types', () => {
  const scopeDir = join(sandbox, 'projects', '--tmp--');
  writeMemory(join(scopeDir, 'user'), 'u.md', { name: 'u', description: 'd', type: 'user' }, '');
  writeMemory(join(scopeDir, 'feedback'), 'f.md', { name: 'f', description: 'd', type: 'feedback' }, '');
  writeMemory(join(scopeDir, 'project'), 'p.md', { name: 'p', description: 'd', type: 'project' }, '');
  writeMemory(join(scopeDir, 'reference'), 'r.md', { name: 'r', description: 'd', type: 'reference' }, '');
  const { entries } = scanScope(scopeDir, 'project');

  expect(entries.map((e) => e.type).sort()).toEqual(['feedback', 'project', 'reference', 'user']);
});

test('scanScope: malformed file yields a warning but does not block others', () => {
  const scopeDir = join(sandbox, 'global');
  writeMemory(join(scopeDir, 'user'), 'ok.md', { name: 'ok', description: 'd', type: 'user' }, '');
  // Malformed: no frontmatter.
  mkdirSync(join(scopeDir, 'user'), { recursive: true });
  writeFileSync(join(scopeDir, 'user', 'bad.md'), '# just markdown\n', 'utf8');
  const { entries, warnings } = scanScope(scopeDir, 'global');

  expect(entries.map((e) => e.id)).toEqual(['ok']);
  expect(warnings).toHaveLength(1);
  expect(warnings[0].path).toContain('bad.md');
});

test('scanScope: non-md files are ignored', () => {
  const scopeDir = join(sandbox, 'global');
  mkdirSync(join(scopeDir, 'user'), { recursive: true });
  writeFileSync(join(scopeDir, 'user', 'notes.txt'), 'ignored', 'utf8');
  writeMemory(join(scopeDir, 'user'), 'a.md', { name: 'a', description: 'd', type: 'user' }, '');
  const { entries, warnings } = scanScope(scopeDir, 'global');

  expect(entries.map((e) => e.id)).toEqual(['a']);
  expect(warnings).toEqual([]);
});

test('scanScope: mismatched directory/type yields a warning', () => {
  const scopeDir = join(sandbox, 'global');
  // File's frontmatter says user but it lives under feedback/.
  writeMemory(join(scopeDir, 'feedback'), 'wrong.md', { name: 'n', description: 'd', type: 'user' }, '');
  const { entries, warnings } = scanScope(scopeDir, 'global');

  expect(entries).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0].reason).toContain('type');
});

test('scanScope: populates created/updated from frontmatter; absent yields undefined', () => {
  const scopeDir = join(sandbox, 'projects', '--tmp--');
  writeMemory(
    join(scopeDir, 'project'),
    'stamped.md',
    {
      name: 'Stamped',
      description: 'd',
      type: 'project',
      created: '2026-06-01T08:00:00Z',
      updated: '2026-06-10T09:30:00Z',
    },
    'body',
  );
  writeMemory(join(scopeDir, 'project'), 'bare.md', { name: 'Bare', description: 'd', type: 'project' }, 'body');
  const { entries } = scanScope(scopeDir, 'project');
  const stamped = entries.find((e) => e.id === 'stamped');
  const bare = entries.find((e) => e.id === 'bare');

  expect(stamped?.created).toBe('2026-06-01T08:00:00.000Z');
  expect(stamped?.updated).toBe('2026-06-10T09:30:00.000Z');
  expect(bare?.created).toBeUndefined();
  expect(bare?.updated).toBeUndefined();
});

test('readMemoryFrontmatter: returns parsed frontmatter incl. timestamps, or null when absent', () => {
  const cwd = '/tmp/pi-test';
  const entry: MemoryEntry = { id: 'p', scope: 'project', type: 'project', name: 'P', description: 'd' };
  atomicWriteFile(
    fileFor('project', 'project', 'p', cwd),
    serializeMemory({
      name: 'P',
      description: 'd',
      type: 'project',
      body: 'b',
      created: '2026-06-01T00:00:00Z',
      updated: '2026-06-02T00:00:00Z',
    }),
  );

  expect(readMemoryFrontmatter(entry, cwd)?.created).toBe('2026-06-01T00:00:00.000Z');
  expect(readMemoryFrontmatter({ ...entry, id: 'missing' }, cwd)).toBeNull();
});

test('readMemoryBody: returns parsed body or raw markdown when frontmatter is absent', () => {
  const cwd = '/tmp/pi-test';
  const entry: MemoryEntry = {
    id: 'alice',
    scope: 'global',
    type: 'user',
    name: 'Alice',
    description: 'd',
  };
  atomicWriteFile(
    fileFor('global', 'user', 'alice', cwd),
    ['---', 'name: Alice', 'description: d', 'type: user', '---', '', 'body text', ''].join('\n'),
  );
  atomicWriteFile(fileFor('global', 'user', 'raw', cwd), '# raw body\n');

  expect(readMemoryBody(entry, cwd)?.trim()).toBe('body text');
  expect(readMemoryBody({ ...entry, id: 'raw' }, cwd)).toBe('# raw body\n');
});

test('rebuildMemoryIndex: scans global and project scopes with project slug', () => {
  const cwd = '/tmp/pi-test';
  writeMemory(globalDir(), 'ignore.md', { name: 'bad', description: 'd', type: 'user' }, 'body');
  writeMemory(join(globalDir(), 'user'), 'alice.md', { name: 'Alice', description: 'd', type: 'user' }, 'body');
  writeMemory(join(projectDir(cwd), 'project'), 'launch.md', { name: 'Launch', description: 'd', type: 'project' }, '');

  const rebuilt = rebuildMemoryIndex(cwd);

  expect(rebuilt.state.projectSlug).toBe('--tmp-pi-test--');
  expect(rebuilt.state.index.global.map((e) => e.id)).toEqual(['alice']);
  expect(rebuilt.state.index.project.map((e) => e.id)).toEqual(['launch']);
  expect(rebuilt.state.index.session).toEqual([]);
  expect(rebuilt.state.sessionId).toBeNull();
});

test('rebuildMemoryIndex: projectSlug snapshot reflects PI_MEMORY_PROJECT_SLUG override', () => {
  process.env.PI_MEMORY_PROJECT_SLUG = 'rp';
  try {
    const cwd = '/renamed/workspace';
    writeMemory(
      join(projectDir(cwd), 'project'),
      'launch.md',
      { name: 'Launch', description: 'd', type: 'project' },
      '',
    );

    const rebuilt = rebuildMemoryIndex(cwd);

    expect(rebuilt.state.projectSlug).toBe('rp');
    expect(rebuilt.state.index.project.map((e) => e.id)).toEqual(['launch']);
  } finally {
    delete process.env.PI_MEMORY_PROJECT_SLUG;
  }
});

test('scanScope: session sees only the note type', () => {
  const cwd = '/tmp/pi-test';
  const dir = sessionDir(cwd, 'sess-1');
  writeMemory(join(dir, 'note'), 'a.md', { name: 'a', description: 'd', type: 'note' }, 'body');
  // A durable type under the session dir must be ignored.
  writeMemory(join(dir, 'user'), 'bogus.md', { name: 'b', description: 'd', type: 'user' }, '');
  const { entries, warnings } = scanScope(dir, 'session');

  expect(entries.map((e) => e.id)).toEqual(['a']);
  expect(entries.every((e) => e.scope === 'session' && e.type === 'note')).toBe(true);
  expect(warnings).toEqual([]);
});

test('rebuildMemoryIndex: scans the current session dir when a sessionId is given', () => {
  const cwd = '/tmp/pi-test';
  const sid = 'sess-current';
  writeMemory(
    join(sessionDir(cwd, sid), 'note'),
    'scratch.md',
    { name: 'Scratch', description: 'd', type: 'note' },
    'b',
  );
  // Another session's notes must NOT leak into this session's index.
  writeMemory(
    join(sessionDir(cwd, 'sess-other'), 'note'),
    'other.md',
    { name: 'Other', description: 'd', type: 'note' },
    '',
  );

  const rebuilt = rebuildMemoryIndex(cwd, sid);

  expect(rebuilt.state.sessionId).toBe(sid);
  expect(rebuilt.state.index.session.map((e) => e.id)).toEqual(['scratch']);
});

test('readMemoryBody: resolves a session note via its sessionId', () => {
  const cwd = '/tmp/pi-test';
  const sid = 'sess-1';
  atomicWriteFile(
    fileFor('session', 'note', 'scratch', cwd, sid),
    ['---', 'name: Scratch', 'description: d', 'type: note', '---', '', 'note body', ''].join('\n'),
  );
  const entry: MemoryEntry = { id: 'scratch', scope: 'session', type: 'note', name: 'Scratch', description: 'd' };

  expect(readMemoryBody(entry, cwd, sid)?.trim()).toBe('note body');
});

test('listSessionMemoryDirs / pruneOrphanSessionDirs: prune dirs with no live transcript', () => {
  const cwd = '/tmp/pi-test';
  for (const sid of ['live-1', 'live-2', 'orphan-1', 'orphan-2']) {
    writeMemory(join(sessionDir(cwd, sid), 'note'), 'n.md', { name: 'n', description: 'd', type: 'note' }, 'b');
  }

  expect(listSessionMemoryDirs(cwd).sort()).toEqual(['live-1', 'live-2', 'orphan-1', 'orphan-2']);

  const removed = pruneOrphanSessionDirs(cwd, new Set(['live-1', 'live-2'])).sort();

  expect(removed).toEqual(['orphan-1', 'orphan-2']);
  expect(listSessionMemoryDirs(cwd).sort()).toEqual(['live-1', 'live-2']);
});

test('pruneOrphanSessionDirs: no-op when parent dir is absent', () => {
  expect(pruneOrphanSessionDirs('/tmp/never-used', new Set(['x']))).toEqual([]);
});
