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
  });
});

test('selectiveLogic maps to the secondary mode (0=OR, 2=NOT, 3=AND)', () => {
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
  expect(mode(2)).toBe('NOT');
  expect(mode(3)).toBe('AND');
});

test('skips disabled and empty-content book entries with warnings', () => {
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
  expect(lore).toHaveLength(1);
  expect(lore[0].name).toBe('A');
  expect(plan.warnings.length).toBeGreaterThanOrEqual(2);
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
