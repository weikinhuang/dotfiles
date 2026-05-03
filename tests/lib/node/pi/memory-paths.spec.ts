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
  cwdSlug,
  fileFor,
  globalDir,
  indexFileFor,
  memoryRoot,
  projectDir,
  scanScope,
  slugifyName,
  uniqueSlug,
} from '../../../../lib/node/pi/memory-paths.ts';

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
// cwdSlug — must match pi's session-dir naming convention.
// ──────────────────────────────────────────────────────────────────────

test('cwdSlug: nested posix path', () => {
  expect(cwdSlug('/mnt/d/whuang/Documents/Projects/github.com/weikinhuang/dotfiles')).toBe(
    '--mnt-d-whuang-Documents-Projects-github.com-weikinhuang-dotfiles--',
  );
});

test('cwdSlug: /tmp', () => {
  expect(cwdSlug('/tmp')).toBe('--tmp--');
});

test('cwdSlug: trailing slash is stripped', () => {
  expect(cwdSlug('/tmp/')).toBe('--tmp--');
  expect(cwdSlug('/tmp/pi-test/')).toBe('--tmp-pi-test--');
});

test('cwdSlug: root slash', () => {
  expect(cwdSlug('/')).toBe('----');
});

test('cwdSlug: home-style path', () => {
  expect(cwdSlug('/home/whuang/.pi')).toBe('--home-whuang-.pi--');
});

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

// ──────────────────────────────────────────────────────────────────────
// atomicWriteFile — parent auto-created, replaces existing file.
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
  // A project-only type under global — should be ignored even if present.
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
