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
 *   - Every entry sets `extensions.match_whole_words: true` and
 *     `case_sensitive: false` (our matcher's fixed semantics); depth
 *     entries add `extensions.role: 0` (system).
 *
 * {@link planCardExport} wraps the mapper and reports record data a V2
 * card cannot carry (character fold metadata, lore `recurse`, lore
 * descriptions, preserved unknown frontmatter keys).
 */

import { emptyCharacterMeta, type CharacterMeta, type LoreMeta, type SecondaryMode } from '../roleplay/store.ts';

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
  /** Fold metadata; card V2 has no slot for it (reported by {@link planCardExport}). */
  character?: CharacterMeta;
  /** Preserved unknown frontmatter keys; not exported (reported by {@link planCardExport}). */
  extra?: Readonly<Record<string, unknown>>;
}

export interface ExportLore {
  name: string;
  description: string;
  body: string;
  lore: LoreMeta;
  /** Preserved unknown frontmatter keys; not exported (reported by {@link planCardExport}). */
  extra?: Readonly<Record<string, unknown>>;
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
    // Our matcher is always whole-word + case-insensitive; say so explicitly.
    match_whole_words: true,
    case_sensitive: false,
  };
  if (m.depth !== undefined) {
    extensions.depth = m.depth;
    // ST at-depth role: 0 = system (1 = user, 2 = assistant).
    extensions.role = 0;
  }
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

/** Character fold-metadata fields that differ from the defaults (V2 cards cannot carry them). */
function droppedCharacterMeta(m: CharacterMeta): string[] {
  const d = emptyCharacterMeta();
  const out: string[] = [];
  if (m.aliases.length > 0) out.push(`aliases (${m.aliases.join(', ')})`);
  if (m.triggers.length > 0) out.push(`triggers (${m.triggers.join(', ')})`);
  if (m.pinned) out.push('pinned');
  if (m.order !== d.order) out.push(`order ${m.order}`);
  if (m.sticky !== d.sticky) out.push(`sticky ${m.sticky}`);
  if (m.cooldown !== d.cooldown) out.push(`cooldown ${m.cooldown}`);
  if (m.probability !== d.probability) out.push(`probability ${m.probability}`);
  if (m.delay !== d.delay) out.push(`delay ${m.delay}`);
  return out;
}

/** True when the importer would re-derive `description` from the exported entry (so nothing is lost). */
function loreDescriptionDerivable(rec: ExportLore): boolean {
  const d = rec.description.trim();
  if (d.length === 0 || d === rec.name.trim() || d === 'imported lore') return true;
  return d === `triggers: ${rec.lore.triggers.join(', ')}`;
}

/**
 * Export a character + lore as a Card V2 (see {@link recordsToCard}) and
 * list the record data the card cannot carry, so the caller can warn:
 * character fold metadata (aliases / triggers / pinned / fold knobs), lore
 * `recurse` (ST has no per-entry opt-in), lore descriptions the importer
 * would not re-derive, and preserved unknown frontmatter keys.
 */
export function planCardExport(
  character: ExportCharacter,
  lore: readonly ExportLore[],
): { card: CardV2; warnings: string[] } {
  const warnings: string[] = [];
  const charDropped = character.character ? droppedCharacterMeta(character.character) : [];
  if (charDropped.length > 0) {
    warnings.push(`character "${character.name}": card has no field for ${charDropped.join(', ')}; dropped`);
  }
  const charExtra = Object.keys(character.extra ?? {});
  if (charExtra.length > 0) {
    warnings.push(`character "${character.name}": custom frontmatter keys dropped: ${charExtra.join(', ')}`);
  }
  for (const rec of lore) {
    const dropped: string[] = [];
    if (rec.lore.recurse) dropped.push('recurse: true (ST has no per-entry recursion opt-in)');
    if (!loreDescriptionDerivable(rec)) dropped.push(`description "${rec.description}"`);
    const extra = Object.keys(rec.extra ?? {});
    if (extra.length > 0) dropped.push(`custom frontmatter keys ${extra.join(', ')}`);
    if (dropped.length > 0) warnings.push(`lore "${rec.name}": dropped ${dropped.join('; ')}`);
  }
  return { card: recordsToCard(character, lore), warnings };
}

/**
 * Parse `/roleplay export [character] [path]` arguments. The longest
 * leading run of whitespace-separated words that equals a character's
 * name or id (case-insensitively, inner whitespace collapsed) selects it,
 * so multi-word names (`Mary Jane out.json`) and punctuated ones
 * (`Dr. Who`) work; the remainder is the path. With no match, `character`
 * is absent and the whole input is the path. Empty parts are omitted.
 * Returns the matched character's `id`.
 */
export function parseExportArgs(
  raw: string,
  characters: readonly { id: string; name: string }[],
): { character?: string; path?: string } {
  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  const tokens = [...trimmed.matchAll(/\S+/g)];
  for (let k = tokens.length; k >= 1; k -= 1) {
    const candidate = norm(
      tokens
        .slice(0, k)
        .map((m) => m[0])
        .join(' '),
    );
    const hit = characters.find((c) => norm(c.name) === candidate || c.id.toLowerCase() === candidate);
    if (hit) {
      const last = tokens[k - 1];
      const path = trimmed.slice(last.index + last[0].length).trim();
      return path.length > 0 ? { character: hit.id, path } : { character: hit.id };
    }
  }
  return { path: trimmed };
}
