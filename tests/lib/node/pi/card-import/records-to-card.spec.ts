import { describe, expect, it } from 'vitest';

import {
  cardToRecords,
  normalizeCard,
  type ImportRecord,
} from '../../../../../lib/node/pi/card-import/card-to-records.ts';
import {
  parseCharacterSections,
  parseExportArgs,
  planCardExport,
  recordsToCard,
  splitGreetings,
  type ExportLore,
} from '../../../../../lib/node/pi/card-import/records-to-card.ts';
import { emptyCharacterMeta, emptyLoreMeta, type LoreMeta } from '../../../../../lib/node/pi/roleplay/store.ts';

function importCard(card: unknown): ImportRecord[] {
  const normalized = normalizeCard(card);
  if ('error' in normalized) throw new Error(normalized.error);
  return cardToRecords(normalized).records;
}

const loreFixtures: ExportLore[] = [
  {
    name: 'The Reef',
    description: 'The Reef',
    body: 'A coral maze.',
    lore: {
      ...emptyLoreMeta(),
      triggers: ['reef', 'coral'],
      secondaryKeys: ['night'],
      secondaryMode: 'NOT_ALL',
      constant: true,
      order: 7,
      depth: 2,
      probability: 60,
      sticky: 2,
      cooldown: 3,
      delay: 1,
      group: 'places',
      groupWeight: 40,
      enabled: false,
    },
  },
  ...(['OR', 'NOT', 'AND'] as const).map((mode, i) => ({
    name: `Mode ${mode}`,
    description: `Mode ${mode}`,
    body: `${mode} body`,
    lore: { ...emptyLoreMeta(), triggers: [`k${i}`], secondaryKeys: ['s'], secondaryMode: mode, order: i },
  })),
];

const labelledBody = [
  '**Description:**\nTall.\n\nQuiet.',
  '**Personality:**\nWry.',
  '**Scenario:**\nA harbor.',
  '**First message:**\nHello.',
  '**Example dialogue:**\n<START>\n{{char}}: Hi.',
  '**System prompt:**\nStay in character.',
  '**Post-history instructions:**\nBe brief.',
  '**Alternate greetings:**\n1. Hey.\n\n2. Yo.\n\nStill yo.',
].join('\n\n');

describe('splitGreetings', () => {
  it('splits the importer numbered list, keeping inner blank lines', () => {
    expect(splitGreetings('1. Hey.\n\n2. Yo.\n\nStill yo.')).toEqual(['Hey.', 'Yo.\n\nStill yo.']);
    expect(splitGreetings('')).toEqual([]);
    expect(splitGreetings('loose text')).toEqual(['loose text']);
  });
});

describe('parseCharacterSections', () => {
  it('returns null for a free-form body', () => {
    expect(parseCharacterSections('Just a sheet.\n\n**Notes:**\nx')).toBeNull();
  });

  it('inverts the importer labelled sections', () => {
    expect(parseCharacterSections(labelledBody)).toEqual({
      description: 'Tall.\n\nQuiet.',
      personality: 'Wry.',
      scenario: 'A harbor.',
      first_mes: 'Hello.',
      mes_example: '<START>\n{{char}}: Hi.',
      system_prompt: 'Stay in character.',
      post_history_instructions: 'Be brief.',
      alternate_greetings: '1. Hey.\n\n2. Yo.\n\nStill yo.',
    });
  });
});

describe('recordsToCard', () => {
  it('emits a V2 card with the labelled fields and the lore book', () => {
    const card = recordsToCard({ name: 'Mira', description: 'A diver', body: labelledBody }, loreFixtures);
    expect(card.spec).toBe('chara_card_v2');
    expect(card.spec_version).toBe('2.0');
    expect(card.data).toMatchObject({
      name: 'Mira',
      description: 'Tall.\n\nQuiet.',
      personality: 'Wry.',
      first_mes: 'Hello.',
      creator_notes: 'A diver',
      alternate_greetings: ['Hey.', 'Yo.\n\nStill yo.'],
    });
    const entry = card.data.character_book?.entries[0];
    expect(entry).toMatchObject({
      keys: ['reef', 'coral'],
      secondary_keys: ['night'],
      selective: true,
      constant: true,
      insertion_order: 7,
      enabled: false,
      comment: 'The Reef',
      content: 'A coral maze.',
      extensions: {
        selectiveLogic: 1,
        position: 4,
        depth: 2,
        probability: 60,
        sticky: 2,
        cooldown: 3,
        delay: 1,
        group: 'places',
        group_weight: 40,
      },
    });
    expect(card.data.character_book?.entries.map((e) => e.extensions.selectiveLogic)).toEqual([1, 0, 2, 3]);
  });

  it('puts a free-form body in description and omits an empty book', () => {
    const card = recordsToCard({ name: 'Kai', description: 'd', body: '  Free sheet.  ' }, []);
    expect(card.data.description).toBe('Free sheet.');
    expect(card.data.character_book).toBeUndefined();
  });

  it('round-trips: import(export(x)) preserves the mapped fields', () => {
    const card = recordsToCard({ name: 'Mira', description: 'A diver', body: labelledBody }, loreFixtures);
    const records = importCard(JSON.parse(JSON.stringify(card)));
    const [character, ...lore] = records;
    expect(character).toMatchObject({ kind: 'character', name: 'Mira', description: 'A diver', body: labelledBody });
    expect(lore.map((r) => ({ name: r.name, body: r.body, lore: r.lore }))).toEqual(
      loreFixtures.map((l) => ({ name: l.name, body: l.body, lore: l.lore satisfies LoreMeta })),
    );
  });

  it('round-trips an imported card through export and back', () => {
    const source = {
      spec: 'chara_card_v2',
      data: {
        name: 'Ash',
        description: 'Scarred.',
        personality: 'Blunt.',
        first_mes: 'What?',
        creator_notes: 'A smith',
        alternate_greetings: ['Hm.', 'Go away.'],
        character_book: {
          entries: [{ keys: ['forge'], content: 'Hot.', comment: 'Forge', insertion_order: 3, enabled: true }],
        },
      },
    };
    const first = importCard(source);
    const [character, ...lore] = first;
    const card = recordsToCard(
      character,
      lore.map((r) => ({ name: r.name, description: r.description, body: r.body, lore: r.lore ?? emptyLoreMeta() })),
    );
    expect(importCard(card)).toEqual(first);
  });
});

describe('planCardExport', () => {
  it('marks entries whole-word / case-insensitive and depth entries as system role', () => {
    const { card } = planCardExport({ name: 'Mira', description: 'A diver', body: 'x' }, loreFixtures);
    const [depthEntry, plainEntry] = card.data.character_book!.entries;
    expect(depthEntry.extensions).toMatchObject({ match_whole_words: true, case_sensitive: false, role: 0 });
    expect(plainEntry.extensions).toMatchObject({ match_whole_words: true, case_sensitive: false });
    expect(plainEntry.extensions.role).toBeUndefined();
  });

  it('reports dropped character meta, lore recurse / description, and unknown keys', () => {
    const { warnings } = planCardExport(
      {
        name: 'Mira',
        description: 'A diver',
        body: 'x',
        character: { ...emptyCharacterMeta(), aliases: ['Mi'], pinned: true, triggers: ['diver'] },
        extra: { mood: 'calm' },
      },
      [
        {
          name: 'Reef',
          description: 'A long custom summary',
          body: 'b',
          lore: { ...emptyLoreMeta(), triggers: ['reef'], recurse: true },
          extra: { source: 'wiki' },
        },
        { name: 'Kelp', description: 'triggers: kelp', body: 'b', lore: { ...emptyLoreMeta(), triggers: ['kelp'] } },
      ],
    );
    expect(warnings).toEqual([
      'character "Mira": card has no field for aliases (Mi), triggers (diver), pinned; dropped',
      'character "Mira": custom frontmatter keys dropped: mood',
      'lore "Reef": dropped recurse: true (ST has no per-entry recursion opt-in); description "A long custom summary"; custom frontmatter keys source',
    ]);
  });

  it('has no warnings for a lossless export', () => {
    expect(planCardExport({ name: 'Mira', description: 'A diver', body: 'x' }, loreFixtures).warnings).toEqual([]);
  });
});

describe('parseExportArgs', () => {
  const chars = [
    { id: 'mary-jane', name: 'Mary Jane' },
    { id: 'mary', name: 'Mary' },
    { id: 'dr-who', name: 'Dr. Who' },
  ];

  it('matches the longest leading run of words against names / ids, case-insensitively', () => {
    expect(parseExportArgs('Mary Jane out.json', chars)).toEqual({ character: 'mary-jane', path: 'out.json' });
    expect(parseExportArgs('mary out.json', chars)).toEqual({ character: 'mary', path: 'out.json' });
    expect(parseExportArgs('dr. who', chars)).toEqual({ character: 'dr-who' });
    expect(parseExportArgs('DR-WHO  ~/cards/my card.json', chars)).toEqual({
      character: 'dr-who',
      path: '~/cards/my card.json',
    });
  });

  it('treats unmatched input as the path and empty input as nothing', () => {
    expect(parseExportArgs(' ./out.json ', chars)).toEqual({ path: './out.json' });
    expect(parseExportArgs('Nobody', chars)).toEqual({ path: 'Nobody' });
    expect(parseExportArgs('   ', chars)).toEqual({});
  });
});
