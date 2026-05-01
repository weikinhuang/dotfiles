/**
 * Tests for lib/node/pi/memory-reducer.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { expect, test } from 'vitest';
import {
  cloneIndex,
  cloneState,
  emptyIndex,
  emptyState,
  findEntry,
  formatText,
  isMemoryStateShape,
  type MemoryEntry,
  parseFrontmatter,
  removeEntry,
  renderMemoryMd,
  serializeMemory,
  takenSlugs,
  upsertEntry,
} from '../../../../lib/node/pi/memory-reducer.ts';

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const gUser = (id: string, name = id, description = `desc ${id}`): MemoryEntry => ({
  id,
  scope: 'global',
  type: 'user',
  name,
  description,
});

const pProject = (id: string, name = id, description = `desc ${id}`): MemoryEntry => ({
  id,
  scope: 'project',
  type: 'project',
  name,
  description,
});

// ──────────────────────────────────────────────────────────────────────
// Shape validator
// ──────────────────────────────────────────────────────────────────────

test('isMemoryStateShape: accepts empty state', () => {
  expect(isMemoryStateShape(emptyState())).toBe(true);
});

test('isMemoryStateShape: accepts populated state with slug', () => {
  const s = { index: { global: [gUser('a')], project: [] }, projectSlug: '--tmp--' };

  expect(isMemoryStateShape(s)).toBe(true);
});

test('isMemoryStateShape: rejects missing index', () => {
  expect(isMemoryStateShape({ projectSlug: null })).toBe(false);
});

test('isMemoryStateShape: rejects non-string projectSlug', () => {
  expect(isMemoryStateShape({ index: emptyIndex(), projectSlug: 42 })).toBe(false);
});

test('isMemoryStateShape: rejects entry with bad type', () => {
  const bad = { id: 'a', scope: 'global', type: 'bogus', name: 'n', description: 'd' };

  expect(isMemoryStateShape({ index: { global: [bad], project: [] }, projectSlug: null })).toBe(false);
});

test('isMemoryStateShape: rejects entry with bad scope', () => {
  const bad = { id: 'a', scope: 'weird', type: 'user', name: 'n', description: 'd' };

  expect(isMemoryStateShape({ index: { global: [bad], project: [] }, projectSlug: null })).toBe(false);
});

test('isMemoryStateShape: rejects entry missing name', () => {
  const bad = { id: 'a', scope: 'global', type: 'user', description: 'd' };

  expect(isMemoryStateShape({ index: { global: [bad], project: [] }, projectSlug: null })).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// Frontmatter parse / serialize
// ──────────────────────────────────────────────────────────────────────

test('parseFrontmatter: roundtrips a simple memory', () => {
  const input = { name: 'Alice prefers tabs', description: 'a preference', type: 'user' as const, body: 'she does.\n' };
  const out = serializeMemory(input);
  const parsed = parseFrontmatter(out);

  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter).toEqual({
    name: 'Alice prefers tabs',
    description: 'a preference',
    type: 'user',
  });
  expect(parsed!.body.trim()).toBe('she does.');
});

test('parseFrontmatter: body containing --- is preserved', () => {
  const input = {
    name: 'n',
    description: 'd',
    type: 'project' as const,
    body: 'para one\n\n---\n\npara two with yaml-like line: value',
  };
  const out = serializeMemory(input);
  const parsed = parseFrontmatter(out);

  expect(parsed).not.toBeNull();
  expect(parsed!.body).toContain('---');
  expect(parsed!.body).toContain('para two with yaml-like line: value');
});

test('parseFrontmatter: quoted values with colons', () => {
  const input = {
    name: 'url: http://example.com',
    description: 'has: a colon',
    type: 'reference' as const,
    body: '',
  };
  const out = serializeMemory(input);
  const parsed = parseFrontmatter(out);

  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.name).toBe('url: http://example.com');
  expect(parsed!.frontmatter.description).toBe('has: a colon');
});

test('parseFrontmatter: roundtrips values with backslash and double-quote', () => {
  const input = {
    name: 'path\\to\\file "quoted"',
    description: 'a\\b"c',
    type: 'user' as const,
    body: 'hi',
  };
  const out = serializeMemory(input);
  const parsed = parseFrontmatter(out);

  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.name).toBe('path\\to\\file "quoted"');
  expect(parsed!.frontmatter.description).toBe('a\\b"c');
});

test('parseFrontmatter: roundtrips values containing # (YAML comment char)', () => {
  const input = {
    name: 'name with #hashtag',
    description: 'has #hash mid-string',
    type: 'user' as const,
    body: 'b',
  };
  const out = serializeMemory(input);

  // Must be quoted — an unquoted `#` would look like a comment to any
  // standards-compliant YAML reader.
  expect(out).toContain('name: "name with #hashtag"');

  const parsed = parseFrontmatter(out);

  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.name).toBe('name with #hashtag');
  expect(parsed!.frontmatter.description).toBe('has #hash mid-string');
});

test('parseFrontmatter: file ending with \\n--- (no trailing newline) yields empty body', () => {
  const raw = '---\nname: n\ndescription: d\ntype: user\n---';
  const parsed = parseFrontmatter(raw);

  expect(parsed).not.toBeNull();
  expect(parsed!.body).toBe('');
});

test('parseFrontmatter: CRLF input', () => {
  const raw = '---\r\nname: n\r\ndescription: d\r\ntype: user\r\n---\r\n\r\nbody\r\n';
  const parsed = parseFrontmatter(raw);

  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.name).toBe('n');
  expect(parsed!.body.trim()).toBe('body');
});

test('parseFrontmatter: rejects missing fence', () => {
  expect(parseFrontmatter('just a body\n')).toBeNull();
});

test('parseFrontmatter: rejects unclosed fence', () => {
  expect(parseFrontmatter('---\nname: n\n')).toBeNull();
});

test('parseFrontmatter: rejects missing required key', () => {
  const raw = '---\nname: n\ntype: user\n---\n\nbody\n';

  expect(parseFrontmatter(raw)).toBeNull();
});

test('parseFrontmatter: rejects bogus type', () => {
  const raw = '---\nname: n\ndescription: d\ntype: nonsense\n---\n\nbody\n';

  expect(parseFrontmatter(raw)).toBeNull();
});

test('parseFrontmatter: allows empty description', () => {
  const raw = '---\nname: n\ndescription: \ntype: user\n---\n\nbody\n';
  const parsed = parseFrontmatter(raw);

  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.description).toBe('');
});

test('parseFrontmatter: ignores unknown keys', () => {
  const raw = '---\nname: n\ndescription: d\ntype: user\nfuture: yes\n---\n\nbody\n';
  const parsed = parseFrontmatter(raw);

  expect(parsed).not.toBeNull();
});

test('serializeMemory: multi-line body is normalised but preserved', () => {
  const out = serializeMemory({ name: 'n', description: 'd', type: 'user', body: 'line1\r\nline2\r\n\r\n' });

  expect(out).toContain('\nline1\nline2\n');
  expect(out).not.toContain('\r');
});

// ──────────────────────────────────────────────────────────────────────
// Index CRUD
// ──────────────────────────────────────────────────────────────────────

test('upsertEntry: inserts into correct scope and sorts by type/id', () => {
  let idx = emptyIndex();
  idx = upsertEntry(idx, gUser('b'));
  idx = upsertEntry(idx, gUser('a'));
  idx = upsertEntry(idx, pProject('c'));

  expect(idx.global.map((e) => e.id)).toEqual(['a', 'b']);
  expect(idx.project.map((e) => e.id)).toEqual(['c']);
});

test('upsertEntry: updates in place when id already exists', () => {
  let idx = emptyIndex();
  idx = upsertEntry(idx, gUser('a', 'old-name', 'old'));
  idx = upsertEntry(idx, gUser('a', 'new-name', 'new'));

  expect(idx.global.length).toBe(1);
  expect(idx.global[0].name).toBe('new-name');
  expect(idx.global[0].description).toBe('new');
});

test('upsertEntry: does not mutate input', () => {
  const before = emptyIndex();
  const after = upsertEntry(before, gUser('a'));

  expect(before.global).toEqual([]);
  expect(after.global.length).toBe(1);
});

test('removeEntry: removes by id', () => {
  let idx = upsertEntry(emptyIndex(), gUser('a'));
  idx = upsertEntry(idx, gUser('b'));
  const after = removeEntry(idx, 'global', 'a');

  expect(after.global.map((e) => e.id)).toEqual(['b']);
});

test('removeEntry: no-op on unknown id', () => {
  const idx = upsertEntry(emptyIndex(), gUser('a'));
  const after = removeEntry(idx, 'global', 'nope');

  expect(after.global.length).toBe(1);
});

test('findEntry: returns matching entry', () => {
  const idx = upsertEntry(emptyIndex(), gUser('a'));

  expect(findEntry(idx, 'global', 'a')?.name).toBe('a');
  expect(findEntry(idx, 'global', 'nope')).toBeUndefined();
  expect(findEntry(idx, 'project', 'a')).toBeUndefined();
});

test('takenSlugs: returns slugs of the given scope', () => {
  let idx = upsertEntry(emptyIndex(), gUser('a'));
  idx = upsertEntry(idx, gUser('b'));
  idx = upsertEntry(idx, pProject('c'));

  expect(Array.from(takenSlugs(idx, 'global')).sort()).toEqual(['a', 'b']);
  expect(Array.from(takenSlugs(idx, 'project')).sort()).toEqual(['c']);
});

// ──────────────────────────────────────────────────────────────────────
// MEMORY.md render
// ──────────────────────────────────────────────────────────────────────

test('renderMemoryMd: global scope shows only user/feedback headings', () => {
  const out = renderMemoryMd([gUser('a')], 'global');

  expect(out).toContain('# Memory Index');
  expect(out).toContain('## user');
  expect(out).toContain('## feedback');
  expect(out).not.toContain('## project');
  expect(out).not.toContain('## reference');
  expect(out).toContain('- [a](user/a.md) — desc a');
});

test('renderMemoryMd: project scope shows all four type headings', () => {
  const entries: MemoryEntry[] = [
    { id: 'x', scope: 'project', type: 'feedback', name: 'X', description: 'x-desc' },
    pProject('y'),
  ];
  const out = renderMemoryMd(entries, 'project');

  expect(out).toContain('## user');
  expect(out).toContain('## feedback');
  expect(out).toContain('## project');
  expect(out).toContain('## reference');
  expect(out).toContain('- [X](feedback/x.md) — x-desc');
  expect(out).toContain('- [y](project/y.md) — desc y');
});

test('renderMemoryMd: empty input still renders headers', () => {
  const out = renderMemoryMd([], 'global');

  expect(out).toContain('# Memory Index');
  expect(out).toContain('## user');
});

// ──────────────────────────────────────────────────────────────────────
// formatText
// ──────────────────────────────────────────────────────────────────────

test('formatText: no memories yields friendly message', () => {
  expect(formatText(emptyState())).toMatch(/no memories/i);
});

test('formatText: renders both scopes when populated', () => {
  const state = {
    index: { global: [gUser('a')], project: [pProject('b')] },
    projectSlug: '--tmp--',
  };
  const out = formatText(state);

  expect(out).toMatch(/Global \(1\)/);
  expect(out).toMatch(/Project --tmp-- \(1\)/);
  expect(out).toMatch(/\[user\] a/);
  expect(out).toMatch(/\[project\] b/);
});

// ──────────────────────────────────────────────────────────────────────
// clone helpers
// ──────────────────────────────────────────────────────────────────────

test('cloneState: does not alias input', () => {
  const s = { index: { global: [gUser('a')], project: [] }, projectSlug: null };
  const c = cloneState(s);
  c.index.global[0].name = 'mutated';

  expect(s.index.global[0].name).toBe('a');
});

test('cloneIndex: does not alias input', () => {
  const idx = upsertEntry(emptyIndex(), gUser('a'));
  const c = cloneIndex(idx);
  c.global[0].name = 'mutated';

  expect(idx.global[0].name).toBe('a');
});
