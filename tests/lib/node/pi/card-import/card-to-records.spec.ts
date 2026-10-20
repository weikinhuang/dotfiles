/**
 * Tests for lib/node/pi/card-import/card-to-records.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { cardToRecords, normalizeCard, parseCardJson } from '../../../../../lib/node/pi/card-import/card-to-records.ts';

// ── normalizeCard: card versions ──────────────────────────────────────────

test('normalizes a V1 (flat) card', () => {
  const card = normalizeCard({
    name: 'Exusiai',
    description: 'PL sniper',
    personality: 'bright, teasing',
    first_mes: 'Yo!',
  });
  expect(card).not.toHaveProperty('error');
  if ('error' in card) throw new Error(card.error);
  expect(card.name).toBe('Exusiai');
  expect(card.description).toBe('PL sniper');
  expect(card.firstMes).toBe('Yo!');
});

test('normalizes a V2 card (fields under data)', () => {
  const card = normalizeCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: 'Texas', description: 'Lupo', alternate_greetings: ['hi', 'hey'], system_prompt: 'be cool' },
  });
  if ('error' in card) throw new Error(card.error);
  expect(card.name).toBe('Texas');
  expect(card.alternateGreetings).toStrictEqual(['hi', 'hey']);
  expect(card.systemPrompt).toBe('be cool');
});

test('normalizes a V3 card and its character_book', () => {
  const card = normalizeCard({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Amiya',
      character_book: {
        entries: [{ keys: ['Rhodes Island', 'RI'], content: 'the org', insertion_order: 50, comment: 'RI' }],
      },
    },
  });
  if ('error' in card) throw new Error(card.error);
  expect(card.characterBook).toHaveLength(1);
  expect(card.characterBook[0].keys).toStrictEqual(['Rhodes Island', 'RI']);
});

test('normalizeCard rejects empty / nameless input', () => {
  expect(normalizeCard({})).toHaveProperty('error');
  expect(normalizeCard({ description: 'x' })).toHaveProperty('error');
  expect(normalizeCard(null)).toHaveProperty('error');
});

test('normalizeCard rejects an array input (arrays are not records)', () => {
  // Regression: a JSON array must not be read as a card object (its numeric
  // indices are not fields), so it degrades to the not-an-object error rather
  // than being partially parsed as a record.
  expect(normalizeCard([{ name: 'X', description: 'y' }])).toEqual({ error: 'card is empty or not an object' });
  expect(normalizeCard(['a', 'b'])).toEqual({ error: 'card is empty or not an object' });
});

test('parseCardJson surfaces invalid JSON', () => {
  expect(parseCardJson('{not json')).toEqual({ error: 'card is not valid JSON' });
});

// ── cardToRecords: mapping ────────────────────────────────────────────────

test('produces a character record with composed body', () => {
  const card = normalizeCard({
    name: 'Exusiai',
    description: 'PL sniper',
    personality: 'bright',
    scenario: 'a mission',
    first_mes: 'Yo!',
    mes_example: '<START>...',
    creator_notes: 'A fan favorite.',
  });
  if ('error' in card) throw new Error(card.error);
  const plan = cardToRecords(card);
  expect(plan.characterName).toBe('Exusiai');
  const charRec = plan.records.find((r) => r.kind === 'character')!;
  expect(charRec.name).toBe('Exusiai');
  expect(charRec.description).toBe('A fan favorite.');
  expect(charRec.body).toContain('**Description:**');
  expect(charRec.body).toContain('PL sniper');
  expect(charRec.body).toContain('**First message:**');
  expect(charRec.body).toContain('Yo!');
});

test('folds system prompt + alternate greetings into the character body', () => {
  const card = normalizeCard({
    spec: 'chara_card_v2',
    data: { name: 'Texas', description: 'd', system_prompt: 'stay terse', alternate_greetings: ['hi', 'hey'] },
  });
  if ('error' in card) throw new Error(card.error);
  const body = cardToRecords(card).records[0].body;
  expect(body).toContain('**System prompt:**');
  expect(body).toContain('stay terse');
  expect(body).toContain('**Alternate greetings:**');
  expect(body).toContain('1. hi');
  expect(body).toContain('2. hey');
});

test('maps character_book entries to lore records with metadata', () => {
  const card = normalizeCard({
    spec: 'chara_card_v3',
    data: {
      name: 'Amiya',
      character_book: {
        entries: [
          {
            keys: ['Rhodes', 'RI'],
            secondary_keys: ['Doctor'],
            selective: true,
            selectiveLogic: 3,
            constant: false,
            insertion_order: 100,
            comment: 'Rhodes Island',
            content: 'a pharma-paramilitary org',
          },
        ],
      },
    },
  });
  if ('error' in card) throw new Error(card.error);
  const lore = cardToRecords(card).records.find((r) => r.kind === 'lore')!;
  expect(lore.name).toBe('Rhodes Island');
  expect(lore.body).toBe('a pharma-paramilitary org');
  expect(lore.lore).toStrictEqual({
    triggers: ['Rhodes', 'RI'],
    secondaryKeys: ['Doctor'],
    secondaryMode: 'AND',
    constant: false,
    order: 100,
    recurse: false,
    probability: 100,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    group: '',
    groupWeight: 100,
    enabled: true,
  });
});

test('maps timed-effect / group knobs from extensions and flat fields', () => {
  const card = normalizeCard({
    spec: 'chara_card_v3',
    data: {
      name: 'Amiya',
      character_book: {
        entries: [
          {
            keys: ['weather'],
            content: 'it is raining',
            // spec-compliant: timed effects under `extensions`
            extensions: { probability: 40, sticky: 3, cooldown: 5, delay: 2, group: 'ambient', group_weight: 70 },
          },
          {
            keys: ['sun'],
            content: 'the sun is out',
            // legacy flat placement + useProbability:false -> probability forced to 100
            useProbability: false,
            probability: 25,
            group: 'ambient',
          },
        ],
      },
    },
  });
  if ('error' in card) throw new Error(card.error);
  const lore = cardToRecords(card).records.filter((r) => r.kind === 'lore');
  expect(lore[0].lore).toMatchObject({
    probability: 40,
    sticky: 3,
    cooldown: 5,
    delay: 2,
    group: 'ambient',
    groupWeight: 70,
  });
  expect(lore[1].lore).toMatchObject({ probability: 100, group: 'ambient', groupWeight: 100 });
});

test('selectiveLogic maps to the secondary mode (0=OR, 1=NOT_ALL, 2=NOT, 3=AND)', () => {
  const make = (logic: number): ReturnType<typeof normalizeCard> =>
    normalizeCard({
      spec: 'chara_card_v2',
      data: {
        name: 'X',
        character_book: {
          entries: [{ keys: ['k'], secondary_keys: ['s'], selective: true, selectiveLogic: logic, content: 'c' }],
        },
      },
    });
  const mode = (logic: number): string => {
    const card = make(logic);
    if ('error' in card) throw new Error(card.error);
    return cardToRecords(card).records.find((r) => r.kind === 'lore')!.lore!.secondaryMode;
  };
  expect(mode(0)).toBe('OR');
  expect(mode(1)).toBe('NOT_ALL');
  expect(mode(2)).toBe('NOT');
  expect(mode(3)).toBe('AND');
});

/** Build a one-entry V2 card and return its plan. */
function planFor(entry: Record<string, unknown>, data: Record<string, unknown> = {}): ReturnType<typeof cardToRecords> {
  const card = normalizeCard({
    spec: 'chara_card_v2',
    data: {
      name: 'X',
      description: 'd',
      ...data,
      character_book: { entries: [{ keys: ['k'], content: 'c', comment: 'E', ...entry }] },
    },
  });
  if ('error' in card) throw new Error(card.error);
  return cardToRecords(card);
}

test('selectiveLogic defaults to 0 (AND_ANY -> OR) when absent', () => {
  const plan = planFor({ secondary_keys: ['s', 't'], selective: true });
  expect(plan.records.find((r) => r.kind === 'lore')!.lore!.secondaryMode).toBe('OR');
});

test('selectiveLogic is read from extensions (ST export placement)', () => {
  const plan = planFor({ secondary_keys: ['s'], selective: true, extensions: { selectiveLogic: 3 } });
  expect(plan.records.find((r) => r.kind === 'lore')!.lore!.secondaryMode).toBe('AND');
});

test('NOT_ALL with several secondary keys maps exactly (no approximation warning)', () => {
  const plan = planFor({ secondary_keys: ['s', 't'], selective: true, selectiveLogic: 1 });
  expect(plan.records.find((r) => r.kind === 'lore')!.lore!.secondaryMode).toBe('NOT_ALL');
  expect(plan.warnings.filter((w) => w.includes('NOT_ALL'))).toStrictEqual([]);
});

test('at-depth placement (extensions.position 4) maps to depth', () => {
  const lore = (ext: Record<string, unknown>): Record<string, unknown> =>
    planFor({ extensions: ext }).records.find((r) => r.kind === 'lore')!.lore as unknown as Record<string, unknown>;
  expect(lore({ position: 4, depth: 2 }).depth).toBe(2);
  expect(lore({ position: 4 }).depth).toBe(4);
  expect(lore({ position: 1, depth: 2 })).not.toHaveProperty('depth');
  // flat V2 `position` is a before/after string, never a depth placement
  const flat = planFor({ position: 'after_char', depth: 2 }).records.find((r) => r.kind === 'lore')!.lore!;
  expect(flat).not.toHaveProperty('depth');
});

test('recurse stays false regardless of ST recursion knobs', () => {
  const plan = planFor({ extensions: { exclude_recursion: false, prevent_recursion: false } });
  expect(plan.records.find((r) => r.kind === 'lore')!.lore!.recurse).toBe(false);
});

test('warns on regex keys, case_sensitive, and match_whole_words:false', () => {
  const plan = planFor({ keys: ['/foo.*/i'], case_sensitive: true, extensions: { match_whole_words: false } });
  expect(plan.warnings.some((w) => w.includes('regex'))).toBe(true);
  expect(plan.warnings.some((w) => w.includes('case-sensitive'))).toBe(true);
  expect(plan.warnings.some((w) => w.includes('whole-word'))).toBe(true);
  expect(plan.records.filter((r) => r.kind === 'lore')).toHaveLength(1);
});

test('extensions.case_sensitive true warns; ST export defaults (use_regex true, nulls) do not', () => {
  expect(planFor({ extensions: { case_sensitive: true } }).warnings.some((w) => w.includes('case-sensitive'))).toBe(
    true,
  );
  const plain = planFor({ use_regex: true, extensions: { case_sensitive: null, match_whole_words: null } });
  expect(plain.warnings).toStrictEqual([]);
});

test('V3 nickname becomes a character alias', () => {
  const card = normalizeCard({ spec: 'chara_card_v3', data: { name: 'Amiya', nickname: 'Bunny', description: 'd' } });
  if ('error' in card) throw new Error(card.error);
  const charRec = cardToRecords(card).records.find((r) => r.kind === 'character')!;
  expect(charRec.character?.aliases).toStrictEqual(['Bunny']);
});

test('no character meta when nickname is absent or equals the name', () => {
  expect(planFor({}).records[0].character).toBeUndefined();
  expect(planFor({}, { nickname: 'x' }).records[0].character).toBeUndefined();
});

test('imports disabled entries with enabled:false; skips empty-content entries with warnings', () => {
  const card = normalizeCard({
    spec: 'chara_card_v2',
    data: {
      name: 'X',
      character_book: {
        entries: [
          { keys: ['a'], content: 'kept', comment: 'A' },
          { keys: ['b'], content: 'off', enabled: false, comment: 'B' },
          { keys: ['c'], content: '   ', comment: 'C' },
        ],
      },
    },
  });
  if ('error' in card) throw new Error(card.error);
  const plan = cardToRecords(card);
  const lore = plan.records.filter((r) => r.kind === 'lore');
  expect(lore.map((r) => [r.name, r.lore!.enabled])).toStrictEqual([
    ['A', true],
    ['B', false],
  ]);
  expect(plan.warnings.some((w) => w.includes('"B"') && w.includes('enabled: false'))).toBe(true);
  expect(plan.warnings.some((w) => w.includes('entry 3') && w.includes('no content'))).toBe(true);
});

test('non-selective entry ignores secondary keys', () => {
  const card = normalizeCard({
    spec: 'chara_card_v2',
    data: {
      name: 'X',
      character_book: { entries: [{ keys: ['k'], secondary_keys: ['s'], selective: false, content: 'c' }] },
    },
  });
  if ('error' in card) throw new Error(card.error);
  const lore = cardToRecords(card).records.find((r) => r.kind === 'lore')!;
  expect(lore.lore!.secondaryKeys).toStrictEqual([]);
});
