/**
 * Tests for lib/node/pi/memory-reducer.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  cloneIndex,
  cloneState,
  defaultMemoryScope,
  defaultMemoryTypeForScope,
  emptyIndex,
  emptyState,
  entryAgeDays,
  findEntry,
  formatText,
  isMemoryTypeAllowedInScope,
  isMemoryStateShape,
  isStaleEntry,
  type MemoryEntry,
  parseFrontmatter,
  removeEntry,
  renderMemoryMd,
  resolveMemoryEntry,
  serializeMemory,
  takenSlugs,
  upsertEntry,
  validTypesForScope,
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

const sNote = (id: string, name = id, description = `desc ${id}`): MemoryEntry => ({
  id,
  scope: 'session',
  type: 'note',
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
  const s = {
    index: { global: [gUser('a')], project: [], session: [sNote('n')] },
    projectSlug: '--tmp--',
    sessionId: 'abc123',
  };

  expect(isMemoryStateShape(s)).toBe(true);
});

test('isMemoryStateShape: rejects missing index', () => {
  expect(isMemoryStateShape({ projectSlug: null, sessionId: null })).toBe(false);
});

test('isMemoryStateShape: rejects missing session bucket', () => {
  expect(isMemoryStateShape({ index: { global: [], project: [] }, projectSlug: null, sessionId: null })).toBe(false);
});

test('isMemoryStateShape: rejects non-string projectSlug', () => {
  expect(isMemoryStateShape({ index: emptyIndex(), projectSlug: 42, sessionId: null })).toBe(false);
});

test('isMemoryStateShape: rejects non-string sessionId', () => {
  expect(isMemoryStateShape({ index: emptyIndex(), projectSlug: null, sessionId: 42 })).toBe(false);
});

test('isMemoryStateShape: rejects entry with bad type', () => {
  const bad = { id: 'a', scope: 'global', type: 'bogus', name: 'n', description: 'd' };

  expect(
    isMemoryStateShape({ index: { global: [bad], project: [], session: [] }, projectSlug: null, sessionId: null }),
  ).toBe(false);
});

test('isMemoryStateShape: rejects entry with bad scope', () => {
  const bad = { id: 'a', scope: 'weird', type: 'user', name: 'n', description: 'd' };

  expect(
    isMemoryStateShape({ index: { global: [bad], project: [], session: [] }, projectSlug: null, sessionId: null }),
  ).toBe(false);
});

test('isMemoryStateShape: rejects entry missing name', () => {
  const bad = { id: 'a', scope: 'global', type: 'user', description: 'd' };

  expect(
    isMemoryStateShape({ index: { global: [bad], project: [], session: [] }, projectSlug: null, sessionId: null }),
  ).toBe(false);
});

test('isMemoryStateShape: accepts a session note entry', () => {
  const s = { index: { global: [], project: [], session: [sNote('n')] }, projectSlug: null, sessionId: 'sid' };

  expect(isMemoryStateShape(s)).toBe(true);
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

  // Must be quoted - an unquoted `#` would look like a comment to any
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
// Timestamps (created / updated)
// ──────────────────────────────────────────────────────────────────────

test('serializeMemory + parseFrontmatter: roundtrips created/updated timestamps', () => {
  // The extension emits `toISOString()` (with `.000Z` millis), so a true
  // roundtrip uses the normalised form. parseFrontmatter re-normalises any
  // parseable timestamp to ISO-8601 UTC with millis.
  const created = '2026-06-30T14:22:01.000Z';
  const updated = '2026-07-01T09:00:00.000Z';
  const out = serializeMemory({ name: 'n', description: 'd', type: 'project', body: 'b', created, updated });

  // Emitted after `type` and before the closing fence.
  expect(out).toContain('created: ');
  expect(out).toContain('updated: ');

  const parsed = parseFrontmatter(out);

  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.created).toBe(created);
  expect(parsed!.frontmatter.updated).toBe(updated);
});

test('serializeMemory: omits timestamp keys entirely when absent (legacy three-key form)', () => {
  const out = serializeMemory({ name: 'n', description: 'd', type: 'user', body: 'b' });

  expect(out).not.toContain('created:');
  expect(out).not.toContain('updated:');
});

test('parseFrontmatter: old three-key file parses with undefined timestamps', () => {
  const raw = '---\nname: n\ndescription: d\ntype: project\n---\n\nbody\n';
  const parsed = parseFrontmatter(raw);

  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.created).toBeUndefined();
  expect(parsed!.frontmatter.updated).toBeUndefined();
});

test('parseFrontmatter: unparseable timestamp is tolerated (treated as absent)', () => {
  const raw =
    '---\nname: n\ndescription: d\ntype: project\ncreated: not-a-date\nupdated: "also nonsense"\n---\n\nbody\n';
  const parsed = parseFrontmatter(raw);

  // The file must still parse - a bad timestamp is never a reason to reject it.
  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.created).toBeUndefined();
  expect(parsed!.frontmatter.updated).toBeUndefined();
});

test('parseFrontmatter: normalises a parseable non-ISO timestamp to ISO-8601 UTC', () => {
  const raw = '---\nname: n\ndescription: d\ntype: project\ncreated: 2026-06-30T14:22:01Z\n---\n\nbody\n';
  const parsed = parseFrontmatter(raw);

  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.created).toBe('2026-06-30T14:22:01.000Z');
});

test('update flow: created is preserved while updated is bumped (injected clock)', () => {
  // Simulate the extension's actUpdate: read the on-disk frontmatter,
  // carry `created` forward, stamp `updated` with the injected clock.
  const created = new Date('2026-06-01T08:00:00Z').toISOString();
  const original = serializeMemory({
    name: 'n',
    description: 'd',
    type: 'project',
    body: 'original',
    created,
    updated: created,
  });
  const onDisk = parseFrontmatter(original);

  expect(onDisk).not.toBeNull();

  const injectedNow = new Date('2026-06-30T12:34:56Z');
  const rewritten = serializeMemory({
    name: 'n',
    description: 'd2',
    type: 'project',
    body: 'edited',
    created: onDisk!.frontmatter.created,
    updated: injectedNow.toISOString(),
  });
  const after = parseFrontmatter(rewritten);

  expect(after).not.toBeNull();
  expect(after!.frontmatter.created).toBe(created);
  expect(after!.frontmatter.updated).toBe('2026-06-30T12:34:56.000Z');
});

test('isMemoryStateShape: accepts entries carrying timestamp strings', () => {
  const s = {
    index: {
      global: [
        { id: 'a', scope: 'global', type: 'user', name: 'n', description: 'd', created: '2026-01-01T00:00:00Z' },
      ],
      project: [],
      session: [],
    },
    projectSlug: null,
    sessionId: null,
  };

  expect(isMemoryStateShape(s)).toBe(true);
});

test('isMemoryStateShape: rejects a non-string timestamp', () => {
  const bad = { id: 'a', scope: 'global', type: 'user', name: 'n', description: 'd', created: 123 };

  expect(
    isMemoryStateShape({ index: { global: [bad], project: [], session: [] }, projectSlug: null, sessionId: null }),
  ).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// Staleness math
// ──────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-06-30T00:00:00Z');

test('entryAgeDays: truncates to whole days from updated, falling back to created', () => {
  const fromUpdated: MemoryEntry = {
    ...pProject('a'),
    created: '2026-01-01T00:00:00Z',
    updated: '2026-06-15T12:00:00Z',
  };

  // 15 days (truncated) between 2026-06-15T12:00 and 2026-06-30T00:00.
  expect(entryAgeDays(fromUpdated, NOW)).toBe(14);

  const fromCreated: MemoryEntry = { ...pProject('b'), created: '2026-06-20T00:00:00Z' };

  expect(entryAgeDays(fromCreated, NOW)).toBe(10);
});

test('entryAgeDays: undefined when no timestamp, or when the stamp is in the future', () => {
  expect(entryAgeDays(pProject('a'), NOW)).toBeUndefined();
  expect(entryAgeDays({ ...pProject('b'), updated: '2027-01-01T00:00:00Z' }, NOW)).toBeUndefined();
});

test('isStaleEntry: project entry past threshold is stale, fresh one is not', () => {
  const old: MemoryEntry = { ...pProject('old'), updated: '2026-05-01T00:00:00Z' };
  const fresh: MemoryEntry = { ...pProject('fresh'), updated: '2026-06-25T00:00:00Z' };

  expect(isStaleEntry(old, NOW, 30)).toBe(true);
  expect(isStaleEntry(fresh, NOW, 30)).toBe(false);
});

test('isStaleEntry: never marks non-project types regardless of age', () => {
  const oldUser: MemoryEntry = { ...gUser('u'), updated: '2025-01-01T00:00:00Z' };
  const oldNote: MemoryEntry = { ...sNote('n'), updated: '2025-01-01T00:00:00Z' };

  expect(isStaleEntry(oldUser, NOW, 30)).toBe(false);
  expect(isStaleEntry(oldNote, NOW, 30)).toBe(false);
});

test('isStaleEntry: undated project entry is not stale', () => {
  expect(isStaleEntry(pProject('a'), NOW, 30)).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// Index CRUD
// ──────────────────────────────────────────────────────────────────────

test('upsertEntry: inserts into correct scope and sorts by type/id', () => {
  let idx = emptyIndex();
  idx = upsertEntry(idx, gUser('b'));
  idx = upsertEntry(idx, gUser('a'));
  idx = upsertEntry(idx, pProject('c'));
  idx = upsertEntry(idx, sNote('n'));

  expect(idx.global.map((e) => e.id)).toEqual(['a', 'b']);
  expect(idx.project.map((e) => e.id)).toEqual(['c']);
  expect(idx.session.map((e) => e.id)).toEqual(['n']);
});

test('removeEntry: removes from the session scope', () => {
  let idx = upsertEntry(emptyIndex(), sNote('a'));
  idx = upsertEntry(idx, sNote('b'));
  const after = removeEntry(idx, 'session', 'a');

  expect(after.session.map((e) => e.id)).toEqual(['b']);
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

test('defaultMemoryScope: user and feedback are global by default, project types are project-scoped, note is session', () => {
  expect(defaultMemoryScope('user')).toBe('global');
  expect(defaultMemoryScope('feedback')).toBe('global');
  expect(defaultMemoryScope('project')).toBe('project');
  expect(defaultMemoryScope('reference')).toBe('project');
  expect(defaultMemoryScope('note')).toBe('session');
});

test('defaultMemoryTypeForScope: session defaults to note, others have no default', () => {
  expect(defaultMemoryTypeForScope('session')).toBe('note');
  expect(defaultMemoryTypeForScope('global')).toBeUndefined();
  expect(defaultMemoryTypeForScope('project')).toBeUndefined();
});

test('isMemoryTypeAllowedInScope: global accepts only cross-project types', () => {
  expect(isMemoryTypeAllowedInScope('user', 'global')).toBe(true);
  expect(isMemoryTypeAllowedInScope('feedback', 'global')).toBe(true);
  expect(isMemoryTypeAllowedInScope('project', 'global')).toBe(false);
  expect(isMemoryTypeAllowedInScope('reference', 'project')).toBe(true);
});

test('isMemoryTypeAllowedInScope: note is exclusive to the session scope', () => {
  expect(isMemoryTypeAllowedInScope('note', 'session')).toBe(true);
  expect(isMemoryTypeAllowedInScope('note', 'global')).toBe(false);
  expect(isMemoryTypeAllowedInScope('note', 'project')).toBe(false);
  // The session scope rejects the durable types.
  expect(isMemoryTypeAllowedInScope('user', 'session')).toBe(false);
  expect(isMemoryTypeAllowedInScope('project', 'session')).toBe(false);
});

test('validTypesForScope: each scope exposes its own type set', () => {
  expect(validTypesForScope('global')).toEqual(['user', 'feedback']);
  expect(validTypesForScope('project')).toEqual(['user', 'feedback', 'project', 'reference']);
  expect(validTypesForScope('session')).toEqual(['note']);
});

test('resolveMemoryEntry: prefers session then project then global, supports filters, and reports misses', () => {
  const state = {
    index: { global: [gUser('same')], project: [pProject('same')], session: [sNote('same')] },
    projectSlug: '--tmp--',
    sessionId: 'sid',
  };

  expect(resolveMemoryEntry(state, { id: 'same' })).toMatchObject({ scope: 'session' });
  expect(resolveMemoryEntry(state, { id: 'same', scope: 'project' })).toMatchObject({ scope: 'project' });
  expect(resolveMemoryEntry(state, { id: 'same', scope: 'global' })).toMatchObject({ scope: 'global' });
  expect(resolveMemoryEntry(state, { id: 'same', type: 'user' })).toMatchObject({ scope: 'global' });
  expect(resolveMemoryEntry(state, { id: 'same', type: 'note' })).toMatchObject({ scope: 'session' });
  expect(resolveMemoryEntry(state, {})).toEqual({ error: '`id` is required' });
  expect(resolveMemoryEntry(state, { id: 'missing' })).toEqual({ error: 'no memory "missing" found' });
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
  expect(out).toContain('- [a](user/a.md) - desc a');
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
  expect(out).toContain('- [X](feedback/x.md) - x-desc');
  expect(out).toContain('- [y](project/y.md) - desc y');
});

test('renderMemoryMd: empty input still renders headers', () => {
  const out = renderMemoryMd([], 'global');

  expect(out).toContain('# Memory Index');
  expect(out).toContain('## user');
});

test('renderMemoryMd: session scope shows only the note heading', () => {
  const out = renderMemoryMd([sNote('scratch', 'Scratch', 'working note')], 'session');

  expect(out).toContain('# Memory Index');
  expect(out).toContain('## note');
  expect(out).not.toContain('## user');
  expect(out).not.toContain('## project');
  expect(out).toContain('- [Scratch](note/scratch.md) - working note');
});

// ──────────────────────────────────────────────────────────────────────
// formatText
// ──────────────────────────────────────────────────────────────────────

test('formatText: no memories yields friendly message', () => {
  expect(formatText(emptyState())).toMatch(/no memories/i);
});

test('formatText: renders all scopes when populated', () => {
  const state = {
    index: { global: [gUser('a')], project: [pProject('b')], session: [sNote('c')] },
    projectSlug: '--tmp--',
    sessionId: 'sid-1',
  };
  const out = formatText(state);

  expect(out).toMatch(/Global \(1\)/);
  expect(out).toMatch(/Project --tmp-- \(1\)/);
  expect(out).toMatch(/Session sid-1 \(1\)/);
  expect(out).toMatch(/\[user\] a/);
  expect(out).toMatch(/\[project\] b/);
  expect(out).toMatch(/\[note\] c/);
});

// ──────────────────────────────────────────────────────────────────────
// clone helpers
// ──────────────────────────────────────────────────────────────────────

test('cloneState: does not alias input', () => {
  const s = { index: { global: [gUser('a')], project: [], session: [sNote('n')] }, projectSlug: null, sessionId: null };
  const c = cloneState(s);
  c.index.global[0].name = 'mutated';
  c.index.session[0].name = 'mutated';

  expect(s.index.global[0].name).toBe('a');
  expect(s.index.session[0].name).toBe('n');
});

test('cloneIndex: does not alias input', () => {
  const idx = upsertEntry(emptyIndex(), gUser('a'));
  const c = cloneIndex(idx);
  c.global[0].name = 'mutated';

  expect(idx.global[0].name).toBe('a');
});
