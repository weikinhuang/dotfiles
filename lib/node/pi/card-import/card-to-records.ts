/**
 * Pure SillyTavern character-card -> roleplay-store record mapper.
 *
 * No pi imports - unit-testable under `vitest`.
 *
 * Accepts a Character Card in V1 (flat), V2 (`chara_card_v2`), or V3
 * (`chara_card_v3`) shape and normalizes it, then maps it to roleplay
 * store records:
 *   - one `character` record (description / personality / scenario /
 *     first message / example dialogue, plus system prompt, post-history
 *     instructions, and alternate greetings folded in as labelled
 *     sections), and
 *   - one `lore` record per `character_book` entry (keys -> triggers,
 *     secondary keys + selective logic -> secondary gate, constant /
 *     insertion_order preserved).
 *
 * Persona generation (system_prompt -> persona append, greetings ->
 * persona `openers`) is deferred to Phase 5; for now those fields ride
 * along inside the character body so nothing is lost on import.
 */

import { emptyLoreMeta, type LoreMeta, type RoleplayKind } from '../roleplay/store.ts';

export interface ImportRecord {
  kind: RoleplayKind;
  name: string;
  description: string;
  body: string;
  lore?: LoreMeta;
}

export interface ImportPlan {
  characterName: string;
  records: ImportRecord[];
  warnings: string[];
}

interface NormalizedLore {
  keys: string[];
  secondaryKeys: string[];
  selectiveLogic: number;
  selective: boolean;
  constant: boolean;
  insertionOrder: number;
  enabled: boolean;
  name: string;
  comment: string;
  content: string;
  probability: number;
  sticky: number;
  cooldown: number;
  delay: number;
  group: string;
  groupWeight: number;
}

export interface NormalizedCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  creatorNotes: string;
  alternateGreetings: string[];
  characterBook: NormalizedLore[];
}

// ── Coercion helpers ──────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function firstLine(s: string, max = 120): string {
  const line =
    s
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ── Normalization ─────────────────────────────────────────────────────────

function normalizeLoreEntry(raw: unknown): NormalizedLore {
  const e = asRecord(raw);
  // ST stores timed-effect / group knobs spec-compliantly under `extensions`,
  // but older books put them flat - read the extension first, fall back flat.
  const ext = asRecord(e.extensions);
  const pick = (key: string): unknown => (ext[key] !== undefined ? ext[key] : e[key]);
  // `useProbability: false` means "ignore probability" -> treat as always (100).
  const useProbability = bool(pick('useProbability'), true);
  return {
    keys: strArray(e.keys),
    secondaryKeys: strArray(e.secondary_keys),
    selectiveLogic: num(e.selectiveLogic, 3),
    selective: bool(e.selective, false),
    constant: bool(e.constant, false),
    insertionOrder: num(e.insertion_order, 0),
    enabled: bool(e.enabled, true),
    name: str(e.name),
    comment: str(e.comment),
    content: str(e.content),
    probability: useProbability ? num(pick('probability'), 100) : 100,
    sticky: num(pick('sticky'), 0),
    cooldown: num(pick('cooldown'), 0),
    delay: num(pick('delay'), 0),
    group: str(pick('group')),
    groupWeight: num(pick('groupWeight') ?? pick('group_weight'), 100),
  };
}

/**
 * Normalize an already-parsed card object (V1/V2/V3) into a flat shape.
 * V2/V3 nest fields under `data`; V1 has them at the top level.
 */
export function normalizeCard(input: unknown): NormalizedCard | { error: string } {
  const root = asRecord(input);
  if (Object.keys(root).length === 0) return { error: 'card is empty or not an object' };

  // V2/V3 keep the real fields under `data`; V1 is flat.
  const hasData = typeof root.spec === 'string' && root.data !== undefined;
  const d = hasData ? asRecord(root.data) : root;

  const name = str(d.name).trim();
  const book = asRecord(d.character_book);
  const entries = Array.isArray(book.entries) ? book.entries.map(normalizeLoreEntry) : [];

  const card: NormalizedCard = {
    name,
    description: str(d.description),
    personality: str(d.personality),
    scenario: str(d.scenario),
    firstMes: str(d.first_mes),
    mesExample: str(d.mes_example),
    systemPrompt: str(d.system_prompt),
    postHistoryInstructions: str(d.post_history_instructions),
    creatorNotes: str(d.creator_notes),
    alternateGreetings: strArray(d.alternate_greetings),
    characterBook: entries,
  };

  if (card.name.length === 0) return { error: 'card has no `name`' };
  return card;
}

/** Parse a JSON string then normalize. */
export function parseCardJson(json: string): NormalizedCard | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: 'card is not valid JSON' };
  }
  return normalizeCard(parsed);
}

// ── Mapping to records ──────────────────────────────────────────────────────

function composeCharacterBody(card: NormalizedCard): string {
  const sections: string[] = [];
  const add = (label: string, value: string): void => {
    const v = value.trim();
    if (v.length > 0) sections.push(`**${label}:**\n${v}`);
  };
  add('Description', card.description);
  add('Personality', card.personality);
  add('Scenario', card.scenario);
  add('First message', card.firstMes);
  add('Example dialogue', card.mesExample);
  add('System prompt', card.systemPrompt);
  add('Post-history instructions', card.postHistoryInstructions);
  if (card.alternateGreetings.length > 0) {
    const list = card.alternateGreetings.map((g, i) => `${i + 1}. ${g.trim()}`).join('\n\n');
    sections.push(`**Alternate greetings:**\n${list}`);
  }
  return sections.join('\n\n');
}

/** ST `selectiveLogic` -> our coarse secondary mode. */
function secondaryMode(logic: number): LoreMeta['secondaryMode'] {
  switch (logic) {
    case 0: // AND ANY
      return 'OR';
    case 1: // NOT ALL
    case 2: // NOT ANY
      return 'NOT';
    default: // 3 = AND ALL (and unknown)
      return 'AND';
  }
}

function loreFromEntry(entry: NormalizedLore, index: number): ImportRecord {
  const meta = emptyLoreMeta();
  meta.triggers = entry.keys;
  meta.secondaryKeys = entry.selective ? entry.secondaryKeys : [];
  meta.secondaryMode = secondaryMode(entry.selectiveLogic);
  meta.constant = entry.constant;
  meta.order = entry.insertionOrder;
  meta.probability = Math.min(100, Math.max(0, Math.floor(entry.probability)));
  meta.sticky = Math.max(0, Math.floor(entry.sticky));
  meta.cooldown = Math.max(0, Math.floor(entry.cooldown));
  meta.delay = Math.max(0, Math.floor(entry.delay));
  meta.group = entry.group.trim();
  meta.groupWeight = Math.max(0, Math.floor(entry.groupWeight));
  const name = entry.comment.trim() || entry.name.trim() || entry.keys[0] || `lore ${index + 1}`;
  const description =
    entry.comment.trim() || (entry.keys.length > 0 ? `triggers: ${entry.keys.join(', ')}` : 'imported lore');
  return { kind: 'lore', name, description, body: entry.content, lore: meta };
}

/**
 * Map a normalized card to an import plan: one `character` record plus a
 * `lore` record per enabled `character_book` entry. Disabled or
 * empty-content book entries are skipped with a warning.
 */
export function cardToRecords(card: NormalizedCard): ImportPlan {
  const warnings: string[] = [];
  const records: ImportRecord[] = [];

  const charBody = composeCharacterBody(card);
  if (charBody.trim().length === 0) warnings.push('character card has no descriptive fields; body will be sparse');
  const description =
    firstLine(card.creatorNotes) ||
    firstLine(card.personality) ||
    firstLine(card.description) ||
    'imported character card';
  records.push({ kind: 'character', name: card.name, description, body: charBody || `(imported card "${card.name}")` });

  card.characterBook.forEach((entry, i) => {
    if (!entry.enabled) {
      warnings.push(
        `lore entry ${i + 1} ("${entry.comment || entry.name || entry.keys[0] || '?'}") is disabled; skipped`,
      );
      return;
    }
    if (entry.content.trim().length === 0) {
      warnings.push(`lore entry ${i + 1} has no content; skipped`);
      return;
    }
    if (entry.keys.length === 0 && !entry.constant) {
      warnings.push(
        `lore entry ${i + 1} ("${entry.comment || entry.name || '?'}") has no keys and is not constant; it will never fire`,
      );
    }
    records.push(loreFromEntry(entry, i));
  });

  return { characterName: card.name, records, warnings };
}
