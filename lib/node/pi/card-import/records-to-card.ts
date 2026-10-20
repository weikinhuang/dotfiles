/**
 * Pure roleplay-store records -> SillyTavern Character Card V2 mapper: the
 * inverse of {@link ./card-to-records.ts}.
 *
 * No pi imports - unit-testable under `vitest`.
 *
 * Character body: when the body is the importer's labelled-section layout
 * (`**Description:**\n...`, `**Personality:**\n...`, ...), each section maps
 * back to its card field (alternate greetings split from the numbered
 * list); otherwise the whole body becomes `description`. The record
 * description rides in `creator_notes` (the importer's first description
 * source), so a round trip preserves it.
 *
 * Lore meta -> `character_book.entries` (inverse of the importer):
 *   - `triggers` -> `keys`; `secondaryKeys` -> `secondary_keys` with
 *     `selective: true` when non-empty.
 *   - `secondaryMode` -> `extensions.selectiveLogic`: OR=0, NOT_ALL=1,
 *     NOT=2, AND=3.
 *   - `constant`, `order` -> `insertion_order`, `enabled`.
 *   - `depth` -> `extensions.position = 4` + `extensions.depth`.
 *   - `probability` / `sticky` / `cooldown` / `delay` / `group` /
 *     `groupWeight` -> `extensions.{probability, sticky, cooldown, delay,
 *     group, group_weight}` (`useProbability: true`).
 */

import { type LoreMeta, type SecondaryMode } from '../roleplay/store.ts';

export interface CardBookEntryV2 {
  id: number;
  keys: string[];
  secondary_keys: string[];
  selective: boolean;
  constant: boolean;
  insertion_order: number;
  enabled: boolean;
  name: string;
  comment: string;
  content: string;
  position: 'before_char';
  case_sensitive: boolean;
  extensions: Record<string, unknown>;
}

export interface CardDataV2 {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  tags: string[];
  creator: string;
  character_version: string;
  extensions: Record<string, unknown>;
  character_book?: { name: string; entries: CardBookEntryV2[]; extensions: Record<string, unknown> };
}

export interface CardV2 {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: CardDataV2;
}

export interface ExportCharacter {
  name: string;
  description: string;
  body: string;
}

export interface ExportLore {
  name: string;
  description: string;
  body: string;
  lore: LoreMeta;
}

/** Text fields the importer writes as labelled body sections, in its order. */
type SectionField =
  | 'description'
  | 'personality'
  | 'scenario'
  | 'first_mes'
  | 'mes_example'
  | 'system_prompt'
  | 'post_history_instructions'
  | 'alternate_greetings';

/** Importer section label -> card field (see `composeCharacterBody`). */
const SECTION_LABELS: Readonly<Record<string, SectionField>> = {
  Description: 'description',
  Personality: 'personality',
  Scenario: 'scenario',
  'First message': 'first_mes',
  'Example dialogue': 'mes_example',
  'System prompt': 'system_prompt',
  'Post-history instructions': 'post_history_instructions',
  'Alternate greetings': 'alternate_greetings',
};

const HEADER = /^\*\*(.+):\*\*$/;

function labelOf(line: string): SectionField | undefined {
  const m = HEADER.exec(line);
  return m ? SECTION_LABELS[m[1]] : undefined;
}

/** Split the importer's numbered greeting list (`1. a\n\n2. b`) back into greetings. */
export function splitGreetings(list: string): string[] {
  const text = list.trim();
  if (!text.startsWith('1. ')) return text.length > 0 ? [text] : [];
  const out: string[] = [];
  let rest = text.slice(3);
  for (let n = 2; ; n += 1) {
    const marker = `\n\n${n}. `;
    const at = rest.indexOf(marker);
    if (at < 0) {
      out.push(rest.trim());
      break;
    }
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at + marker.length);
  }
  return out.filter((g) => g.length > 0);
}

/**
 * Parse a character body written in the importer's labelled-section layout.
 * Returns `null` when the body does not start with a known section header,
 * so the caller can fall back to "whole body is the description".
 */
export function parseCharacterSections(body: string): Partial<Record<SectionField, string>> | null {
  const lines = body.trim().split('\n');
  if (lines.length === 0 || labelOf(lines[0]) === undefined) return null;
  const out: Partial<Record<SectionField, string>> = {};
  let field: SectionField | undefined;
  let buf: string[] = [];
  const flush = (): void => {
    if (field !== undefined) out[field] = buf.join('\n').trim();
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = labelOf(line);
    // A header starts a section only at the top or after a blank line, and only once per field.
    const boundary = i === 0 || lines[i - 1].trim().length === 0;
    if (next !== undefined && boundary && out[next] === undefined && next !== field) {
      flush();
      field = next;
      buf = [];
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

function selectiveLogic(mode: SecondaryMode): number {
  switch (mode) {
    case 'OR':
      return 0;
    case 'NOT_ALL':
      return 1;
    case 'NOT':
      return 2;
    case 'AND':
      return 3;
  }
}

function loreEntry(rec: ExportLore, id: number): CardBookEntryV2 {
  const m = rec.lore;
  const extensions: Record<string, unknown> = {
    selectiveLogic: selectiveLogic(m.secondaryMode),
    probability: m.probability,
    useProbability: true,
    sticky: m.sticky,
    cooldown: m.cooldown,
    delay: m.delay,
    group: m.group,
    group_weight: m.groupWeight,
    position: m.depth === undefined ? 0 : 4,
  };
  if (m.depth !== undefined) extensions.depth = m.depth;
  return {
    id,
    keys: [...m.triggers],
    secondary_keys: [...m.secondaryKeys],
    selective: m.secondaryKeys.length > 0,
    constant: m.constant,
    insertion_order: m.order,
    enabled: m.enabled,
    name: rec.name,
    comment: rec.name,
    content: rec.body,
    position: 'before_char',
    case_sensitive: false,
    extensions,
  };
}

/** Map a character record plus lore records to a Character Card V2. */
export function recordsToCard(character: ExportCharacter, lore: readonly ExportLore[]): CardV2 {
  const sections = parseCharacterSections(character.body);
  const field = (f: Exclude<SectionField, 'alternate_greetings'>): string => sections?.[f] ?? '';
  const data: CardDataV2 = {
    name: character.name,
    description: sections ? field('description') : character.body.trim(),
    personality: field('personality'),
    scenario: field('scenario'),
    first_mes: field('first_mes'),
    mes_example: field('mes_example'),
    creator_notes: character.description,
    system_prompt: field('system_prompt'),
    post_history_instructions: field('post_history_instructions'),
    alternate_greetings: splitGreetings(sections?.alternate_greetings ?? ''),
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
  };
  if (lore.length > 0) {
    data.character_book = {
      name: `${character.name} lore`,
      entries: lore.map((rec, i) => loreEntry(rec, i)),
      extensions: {},
    };
  }
  return { spec: 'chara_card_v2', spec_version: '2.0', data };
}
