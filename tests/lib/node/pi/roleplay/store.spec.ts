/**
 * Tests for lib/node/pi/roleplay/store.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  castSlug,
  chooseSlug,
  cloneState,
  emptyState,
  findEntry,
  formatRoleplayBlock,
  formatText,
  parseFrontmatter,
  removeEntry,
  renderIndexMd,
  resolveEntry,
  type RoleplayEntry,
  serializeEntry,
  slugifyName,
  uniqueSlug,
  upsertEntry,
} from '../../../../../lib/node/pi/roleplay/store.ts';

const char = (id: string, name = id, description = `desc ${id}`): RoleplayEntry => ({
  id,
  kind: 'character',
  name,
  description,
});

// ── Slugs ───────────────────────────────────────────────────────────────

test('castSlug normalizes names and falls back to default', () => {
  expect(castSlug('Exusiai & Texas')).toBe('exusiai-texas');
  expect(castSlug('  ')).toBe('default');
  expect(castSlug('!!!')).toBe('default');
});

test('slugifyName falls back to entry', () => {
  expect(slugifyName('Dr. Kal’tsit')).toBe('dr-kal-tsit');
  expect(slugifyName('***')).toBe('entry');
});

test('uniqueSlug appends a numeric suffix on collision', () => {
  const taken = new Set(['exusiai', 'exusiai-2']);
  expect(uniqueSlug('exusiai', taken)).toBe('exusiai-3');
  expect(uniqueSlug('texas', taken)).toBe('texas');
});

test('chooseSlug excludes the entry being renamed in place', () => {
  const entries = [char('exusiai')];
  expect(chooseSlug(entries, 'Exusiai')).toBe('exusiai-2');
  expect(chooseSlug(entries, 'Exusiai', 'exusiai')).toBe('exusiai');
});

// ── Frontmatter ───────────────────────────────────────────────────────────

test('serialize -> parse round-trips a character', () => {
  const raw = serializeEntry({ name: 'Exusiai', description: 'PL sniper', kind: 'character', body: 'Voice: bright.' });
  const parsed = parseFrontmatter(raw);
  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter).toEqual({
    name: 'Exusiai',
    description: 'PL sniper',
    kind: 'character',
    character: {
      aliases: [],
      triggers: [],
      pinned: false,
      order: 0,
      sticky: 3,
      cooldown: 0,
      probability: 100,
      delay: 0,
    },
  });
  expect(parsed!.body.trim()).toBe('Voice: bright.');
});

test('parseFrontmatter round-trips quote/colon-bearing values', () => {
  const raw = serializeEntry({ name: 'Name: with "quotes"', description: 'a: b # c', kind: 'character', body: 'x' });
  const parsed = parseFrontmatter(raw);
  expect(parsed!.frontmatter.name).toBe('Name: with "quotes"');
  expect(parsed!.frontmatter.description).toBe('a: b # c');
});

test('parseFrontmatter rejects an unknown kind and missing fences', () => {
  expect(parseFrontmatter('---\nname: x\ndescription: y\nkind: villain\n---\nbody')).toBeNull();
  expect(parseFrontmatter('no frontmatter here')).toBeNull();
  expect(parseFrontmatter('---\nname: x\nkind: character\n---\nbody')).toBeNull(); // missing description
});

test('parseFrontmatter reads a description reformatted as a YAML block scalar', () => {
  // A committed card whose long description a markdown/YAML formatter
  // rewrote as a `|` block scalar must still parse (the old line parser
  // rejected the whole file on the colon-less continuation lines).
  const raw =
    '---\nname: Kal\ndescription: |\n  first line of lore\n  second line of lore\nkind: character\n---\nbody\n';
  const parsed = parseFrontmatter(raw);
  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.description).toBe('first line of lore\nsecond line of lore');
});

test('parseFrontmatter reads a value wrapped onto indented continuation lines', () => {
  const raw =
    '---\nname: Kal\ndescription:\n  a long description that a\n  formatter wrapped for width\nkind: character\n---\nbody\n';
  const parsed = parseFrontmatter(raw);
  expect(parsed!.frontmatter.description).toBe('a long description that a formatter wrapped for width');
});

test('parseFrontmatter reads lore metadata reformatted as a YAML block sequence', () => {
  // `triggers` re-emitted as a multi-line block list instead of `[a, b]`.
  const raw = [
    '---',
    'name: RI',
    'description: org',
    'kind: lore',
    'triggers:',
    '  - Rhodes Island',
    '  - RI',
    'constant: true',
    'order: 100',
    '---',
    'body',
    '',
  ].join('\n');
  const lore = parseFrontmatter(raw)!.frontmatter.lore!;
  expect(lore.triggers).toStrictEqual(['Rhodes Island', 'RI']);
  expect(lore.constant).toBe(true);
  expect(lore.order).toBe(100);
});

test('serialize -> parse round-trips a lore entry with all metadata', () => {
  const raw = serializeEntry({
    name: 'Rhodes Island',
    description: 'pharma-paramilitary org',
    kind: 'lore',
    body: 'The landship HQ.',
    lore: {
      triggers: ['Rhodes Island', 'RI'],
      secondaryKeys: ['Doctor'],
      secondaryMode: 'AND',
      constant: false,
      order: 100,
      depth: 4,
      recurse: true,
      probability: 50,
      sticky: 2,
      cooldown: 3,
      delay: 1,
      group: 'org',
      groupWeight: 80,
    },
  });
  const parsed = parseFrontmatter(raw);
  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.kind).toBe('lore');
  expect(parsed!.frontmatter.lore).toStrictEqual({
    triggers: ['Rhodes Island', 'RI'],
    secondaryKeys: ['Doctor'],
    secondaryMode: 'AND',
    constant: false,
    order: 100,
    depth: 4,
    recurse: true,
    probability: 50,
    sticky: 2,
    cooldown: 3,
    delay: 1,
    group: 'org',
    groupWeight: 80,
  });
});

test('serialize -> parse round-trips lore trigger values that contain commas', () => {
  const raw = serializeEntry({
    name: 'Treaty',
    description: 'the accord',
    kind: 'lore',
    body: 'b',
    lore: {
      triggers: ['Ursus, the empire', 'Kazimierz'],
      secondaryKeys: ['a, b, c'],
      secondaryMode: 'OR',
      constant: false,
      order: 0,
      recurse: false,
      probability: 100,
      sticky: 0,
      cooldown: 0,
      delay: 0,
      group: '',
      groupWeight: 100,
    },
  });
  const lore = parseFrontmatter(raw)!.frontmatter.lore!;
  // A comma inside a trigger must not split it into two entries.
  expect(lore.triggers).toStrictEqual(['Ursus, the empire', 'Kazimierz']);
  expect(lore.secondaryKeys).toStrictEqual(['a, b, c']);
});

test('lore frontmatter defaults to empty/false when fields are omitted', () => {
  const raw = serializeEntry({ name: 'World', description: 'facts', kind: 'lore', body: 'b' });
  const lore = parseFrontmatter(raw)!.frontmatter.lore!;
  expect(lore).toStrictEqual({
    triggers: [],
    secondaryKeys: [],
    secondaryMode: 'AND',
    constant: false,
    order: 0,
    recurse: false,
    probability: 100,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    group: '',
    groupWeight: 100,
  });
});

test('character frontmatter carries no lore metadata', () => {
  const raw = serializeEntry({ name: 'Exusiai', description: 'sniper', kind: 'character', body: 'b' });
  expect(parseFrontmatter(raw)!.frontmatter.lore).toBeUndefined();
});

test('character frontmatter defaults to name-only, unpinned when metadata is omitted', () => {
  const raw = serializeEntry({ name: 'Exusiai', description: 'sniper', kind: 'character', body: 'b' });
  // A bare card serializes no `character:` fields (defaults) but parses to the
  // zero-config meta so the fold keys on the name only.
  expect(raw).not.toContain('pinned:');
  expect(raw).not.toContain('aliases:');
  expect(parseFrontmatter(raw)!.frontmatter.character).toStrictEqual({
    aliases: [],
    triggers: [],
    pinned: false,
    order: 0,
    sticky: 3,
    cooldown: 0,
    probability: 100,
    delay: 0,
  });
});

test('serialize -> parse round-trips a character entry with fold metadata', () => {
  const raw = serializeEntry({
    name: 'Kaltsit',
    description: 'the doctor',
    kind: 'character',
    body: 'Voice: clinical.',
    character: {
      aliases: ["Dr. Kal'tsit", 'the surgeon'],
      triggers: ['chief medical officer'],
      pinned: true,
      order: 10,
      sticky: 5,
      cooldown: 2,
      probability: 80,
      delay: 1,
    },
  });
  const parsed = parseFrontmatter(raw);
  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.kind).toBe('character');
  expect(parsed!.frontmatter.character).toStrictEqual({
    aliases: ["Dr. Kal'tsit", 'the surgeon'],
    triggers: ['chief medical officer'],
    pinned: true,
    order: 10,
    sticky: 5,
    cooldown: 2,
    probability: 80,
    delay: 1,
  });
});

test('character serialize omits a default sticky but round-trips a non-default one', () => {
  const def = serializeEntry({
    name: 'A',
    description: 'd',
    kind: 'character',
    body: 'b',
    character: {
      aliases: [],
      triggers: [],
      pinned: false,
      order: 0,
      sticky: 3,
      cooldown: 0,
      probability: 100,
      delay: 0,
    },
  });
  expect(def).not.toContain('sticky:');
  const custom = serializeEntry({
    name: 'A',
    description: 'd',
    kind: 'character',
    body: 'b',
    character: {
      aliases: [],
      triggers: [],
      pinned: false,
      order: 0,
      sticky: 0,
      cooldown: 0,
      probability: 100,
      delay: 0,
    },
  });
  expect(custom).toContain('sticky: 0');
  expect(parseFrontmatter(custom)!.frontmatter.character!.sticky).toBe(0);
});

test('serialize -> parse round-trips a relationship entry with all metadata', () => {
  const raw = serializeEntry({
    name: 'Exusiai and Doctor',
    description: 'warm, bantering',
    kind: 'relationship',
    body: 'They share an easy rapport.',
    relationship: {
      affinity: 72,
      trust: 'high',
      lastInteraction: '2026-06-07',
      openThreads: ['the unanswered dinner invite', "her curiosity about the Doctor's past"],
    },
  });
  const parsed = parseFrontmatter(raw);
  expect(parsed).not.toBeNull();
  expect(parsed!.frontmatter.kind).toBe('relationship');
  expect(parsed!.frontmatter.relationship).toStrictEqual({
    affinity: 72,
    trust: 'high',
    lastInteraction: '2026-06-07',
    openThreads: ['the unanswered dinner invite', "her curiosity about the Doctor's past"],
  });
});

test('relationship frontmatter defaults + clamps affinity, omits empty optional fields', () => {
  const empty = parseFrontmatter(serializeEntry({ name: 'Pair', description: 'd', kind: 'relationship', body: 'b' }))!
    .frontmatter.relationship!;
  expect(empty).toStrictEqual({ affinity: 50, trust: '', openThreads: [] });
  // affinity out of range is clamped on parse
  const hi = parseFrontmatter('---\nname: p\ndescription: d\nkind: relationship\naffinity: 250\n---\nb')!.frontmatter
    .relationship!;
  expect(hi.affinity).toBe(100);
  const lo = parseFrontmatter('---\nname: p\ndescription: d\nkind: relationship\naffinity: -9\n---\nb')!.frontmatter
    .relationship!;
  expect(lo.affinity).toBe(0);
});

test('summary and timeline entries round-trip as plain records (no kind metadata)', () => {
  for (const kind of ['summary', 'timeline'] as const) {
    const raw = serializeEntry({ name: 'Day 1', description: 'recap', kind, body: 'What happened.' });
    const parsed = parseFrontmatter(raw)!;
    expect(parsed.frontmatter.kind).toBe(kind);
    expect(parsed.frontmatter.lore).toBeUndefined();
    expect(parsed.frontmatter.relationship).toBeUndefined();
    expect(parsed.body.trim()).toBe('What happened.');
  }
});

test('parseFrontmatter tolerates a body containing --- rules', () => {
  const parsed = parseFrontmatter('---\nname: x\ndescription: y\nkind: character\n---\nintro\n\n---\n\nmore');
  expect(parsed!.body).toBe('intro\n\n---\n\nmore');
});

// ── Index CRUD ──────────────────────────────────────────────────────────

test('upsertEntry inserts, replaces, and sorts by id', () => {
  let entries = upsertEntry([], char('texas', 'Texas'));
  entries = upsertEntry(entries, char('exusiai', 'Exusiai'));
  expect(entries.map((e) => e.id)).toEqual(['exusiai', 'texas']);
  entries = upsertEntry(entries, char('exusiai', 'Exusiai Renamed'));
  expect(entries).toHaveLength(2);
  expect(findEntry(entries, 'exusiai')!.name).toBe('Exusiai Renamed');
});

test('removeEntry drops the matching id', () => {
  const entries = [char('a'), char('b')];
  expect(removeEntry(entries, 'a').map((e) => e.id)).toEqual(['b']);
  expect(removeEntry(entries, 'missing')).toHaveLength(2);
});

test('resolveEntry surfaces a helpful error and kind mismatch', () => {
  const state = { cast: 'pl', entries: [char('exusiai')] };
  expect(resolveEntry(state, { id: 'exusiai' })).toMatchObject({ id: 'exusiai' });
  expect(resolveEntry(state, {})).toEqual({ error: '`id` is required' });
  expect(resolveEntry(state, { id: 'nobody' })).toHaveProperty('error');
});

test('resolveEntry disambiguates a slug shared across kinds via kind', () => {
  const loreEntry: RoleplayEntry = { id: 'rhodes', kind: 'lore', name: 'Rhodes', description: 'org' };
  const state = { cast: 'pl', entries: [char('rhodes'), loreEntry] };
  expect(resolveEntry(state, { id: 'rhodes' })).toHaveProperty('error'); // ambiguous
  expect(resolveEntry(state, { id: 'rhodes', kind: 'lore' })).toMatchObject({ kind: 'lore' });
  expect(resolveEntry(state, { id: 'rhodes', kind: 'character' })).toMatchObject({ kind: 'character' });
});

test('cloneState is a deep copy', () => {
  const state = { cast: 'pl', entries: [char('a')] };
  const copy = cloneState(state);
  copy.entries[0].name = 'mutated';
  expect(state.entries[0].name).toBe('a');
});

// ── Renderers ─────────────────────────────────────────────────────────────

test('renderIndexMd emits a predictable header + section even when empty', () => {
  const md = renderIndexMd(emptyState('pl'));
  expect(md).toContain('# Roleplay cast: pl');
  expect(md).toContain('## Characters');
  expect(md).toContain('## Lore');
});

test('formatText summarizes the cast', () => {
  expect(formatText(emptyState('pl'))).toBe('(roleplay cast "pl" is empty)');
  const txt = formatText({ cast: 'pl', entries: [char('exusiai', 'Exusiai')] });
  expect(txt).toContain('Cast "pl" (1):');
  expect(txt).toContain('[character] exusiai - Exusiai');
});

test('formatRoleplayBlock returns null for an empty cast', () => {
  expect(formatRoleplayBlock(emptyState('pl'))).toBeNull();
});

test('formatRoleplayBlock injects the index with a trailer', () => {
  const block = formatRoleplayBlock({ cast: 'pl', entries: [char('exusiai', 'Exusiai')] });
  expect(block).toContain('## Roleplay — cast: pl');
  expect(block).toContain('### Characters');
  expect(block).toContain('- Exusiai (`exusiai`)');
  expect(block).toContain('roleplay` action `read`');
});

test('formatRoleplayBlock honors the char budget and emits a truncation trailer', () => {
  const entries = Array.from({ length: 50 }, (_, i) => char(`c${i}`, `Char ${i}`, 'x'.repeat(40)));
  const block = formatRoleplayBlock({ cast: 'pl', entries }, { maxChars: 500 })!;
  expect(block.length).toBeLessThan(700);
  expect(block).toMatch(/more entry\(ies\) not shown/);
});
