/**
 * Pure state types + frontmatter / index helpers for the `roleplay`
 * extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * The roleplay store lives on disk (source of truth) and is keyed by
 * *cast* slug rather than by cwd/session - a cast is a roleplay scenario
 * (a character or an ensemble) that should travel with you across
 * workspaces. See `paths.ts` for the on-disk layout.
 *
 * This module handles:
 *   - `RoleplayEntry` / `RoleplayState` types and the `RoleplayKind` set.
 *   - Strict frontmatter parse + serialize (no external YAML dep). Core
 *     keys `name`, `description`, `kind`; `lore` entries additionally
 *     round-trip `triggers` / `secondaryKeys` / `constant` / `order` /
 *     `depth` / `recurse` via a small inline-list parser, and `character`
 *     entries round-trip the fold metadata `aliases` / `triggers` /
 *     `pinned` / `order` / `sticky` / `cooldown` / `probability` / `delay`.
 *     Keys a kind does not consume ride along on `extra` and are re-emitted
 *     on serialize, so a rewrite never drops hand-authored fields.
 *   - Pure index CRUD (callers pair these with disk writes in the shell).
 *   - `INDEX.md` renderer + the injected `## Roleplay` block.
 *
 * Phase 1 shipped the `character` kind; Phase 2 adds `lore` (keyword-
 * triggered World Info injection). Phase 3+ extends `ROLEPLAY_KINDS`
 * further with `relationship` / `timeline` / `summary`.
 */

import { slugifyAscii } from '../slugify.ts';
import { parseFencedFrontmatter } from '../shared/strict-frontmatter.ts';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export const ROLEPLAY_KINDS = ['character', 'lore', 'relationship', 'summary', 'timeline'] as const;
export type RoleplayKind = (typeof ROLEPLAY_KINDS)[number];

/**
 * Selective-key combination logic for a lore entry's secondary keys:
 * `AND` = all present, `OR` = any present, `NOT` = none present,
 * `NOT_ALL` = not every one present (SillyTavern "NOT ALL").
 */
export type SecondaryMode = 'AND' | 'OR' | 'NOT' | 'NOT_ALL';

/** Every accepted {@link SecondaryMode}, in display order. */
export const SECONDARY_MODES = ['AND', 'OR', 'NOT', 'NOT_ALL'] as const satisfies readonly SecondaryMode[];

/**
 * World-Info / lorebook metadata, present only on `lore` entries
 * (`RoleplayEntry.lore`). Drives keyword-triggered injection:
 *   - `triggers`: primary keys, OR'd. Any hit fires the entry.
 *   - `secondaryKeys` + `secondaryMode`: optional AND/OR/NOT/NOT_ALL gate applied
 *     against the same scan text after a primary hit.
 *   - `constant`: always fire (budget permitting), ignoring triggers.
 *   - `order`: higher wins when the char budget forces eviction.
 *   - `depth`: context-event insertion depth (parsed now, injected at
 *     depth only once Phase 4 wires the `context` handler).
 *   - `recurse`: opt-in; this entry's body is re-scanned to fire further
 *     entries, bounded by `maxRecursion`.
 *   - `probability`: 0-100 chance the entry fires even when matched
 *     (default 100 = always).
 *   - `sticky`: once fired, stay active for this many further turns even
 *     without a re-match (default 0 = not sticky).
 *   - `cooldown`: after deactivating, cannot fire again for this many
 *     turns (default 0 = no cooldown).
 *   - `delay`: not eligible to fire until this many turns into the chat
 *     (default 0 = eligible immediately).
 *   - `group`: inclusion-group name; among fired members sharing a group
 *     only ONE is kept per turn (default '' = ungrouped).
 *   - `groupWeight`: relative weight for the group's weighted-random pick
 *     (default 100).
 *   - `enabled`: author kill-switch (default true). `false` silences the
 *     entry entirely - it never fires (keyword OR constant) and never
 *     injects - so a file can be turned off in place without deleting or
 *     moving it. File-authored only; deliberately NOT a `roleplay` tool
 *     param, so the model can't toggle canon on or off.
 */
export interface LoreMeta {
  triggers: string[];
  secondaryKeys: string[];
  secondaryMode: SecondaryMode;
  constant: boolean;
  order: number;
  depth?: number;
  recurse: boolean;
  probability: number;
  sticky: number;
  cooldown: number;
  delay: number;
  group: string;
  groupWeight: number;
  enabled: boolean;
}

/**
 * Character-card injection metadata, present only on `character` entries
 * (`RoleplayEntry.character`). Gives character sheets the same
 * constant-vs-keyed fold behaviour that {@link LoreMeta} gives lore
 * entries, so a relevant character's whole sheet is auto-injected into the
 * `## Roleplay scene` block instead of relying on a `roleplay read`:
 *   - `pinned`: always fold this sheet in (budget permitting), regardless
 *     of triggers. The character-card analogue of lore's `constant`
 *     (SillyTavern "constant"/blue-circle). Default false.
 *   - `aliases`: extra names/nicknames the fold keys on. The entry `name`
 *     is ALWAYS an implicit key (zero-config), so a bare card folds when
 *     its name is mentioned; `aliases` add titles / nicknames.
 *   - `triggers`: optional extra keywords, OR'd with name + aliases. For
 *     the rare case a sheet should also surface on a non-name keyword.
 *   - `order`: higher wins when the scene budget forces eviction.
 *   - `sticky`: once folded, stay folded for this many further turns even
 *     without a re-match, so an NPC named on turn 1 but not turn 3 does
 *     not flicker out mid-scene (default 3). Mandatory anti-flicker.
 *   - `cooldown`: after the sticky window ends, cannot fold again for this
 *     many turns (default 0 = no cooldown).
 *   - `probability`: 0-100 chance the fold fires on a fresh match
 *     (default 100 = always).
 *   - `delay`: not eligible to fold until this many turns into the chat
 *     (default 0 = eligible immediately).
 */
export interface CharacterMeta {
  aliases: string[];
  triggers: string[];
  pinned: boolean;
  order: number;
  sticky: number;
  cooldown: number;
  probability: number;
  delay: number;
}

/** Default character-fold sticky window (turns) applied when none is authored. */
export const DEFAULT_CHARACTER_STICKY = 3;

export function emptyCharacterMeta(): CharacterMeta {
  return {
    aliases: [],
    triggers: [],
    pinned: false,
    order: 0,
    sticky: DEFAULT_CHARACTER_STICKY,
    cooldown: 0,
    probability: 100,
    delay: 0,
  };
}

function cloneCharacterMeta(m: CharacterMeta): CharacterMeta {
  return { ...m, aliases: [...m.aliases], triggers: [...m.triggers] };
}

export function emptyLoreMeta(): LoreMeta {
  return {
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
    enabled: true,
  };
}

function cloneLoreMeta(m: LoreMeta): LoreMeta {
  return { ...m, triggers: [...m.triggers], secondaryKeys: [...m.secondaryKeys] };
}

/**
 * Relationship metadata, present only on `relationship` entries
 * (`RoleplayEntry.relationship`). Tracks how a pair feels about each
 * other so a scene can pick up where it left off:
 *   - `affinity`: 0-100 warmth/closeness. Model-rewritten as scenes
 *     evolve; decays toward a neutral baseline while neglected (see
 *     `relationship.ts`).
 *   - `trust`: free-form qualitative label (e.g. `high`, `wary`).
 *   - `lastInteraction`: ISO date (`YYYY-MM-DD`) of the last scene the
 *     pair shared; the anchor the decay math measures from. Absent = no
 *     decay applied.
 *   - `openThreads`: dangling plot/relational threads to resume.
 */
export interface RelationshipMeta {
  affinity: number;
  trust: string;
  lastInteraction?: string;
  openThreads: string[];
}

/**
 * True when `v` is a real calendar date in strict ISO `YYYY-MM-DD` form
 * (rejects `2024-02-30`, timestamps, and other shapes).
 */
export function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Validate a tool-supplied `lastInteraction`: an ISO `YYYY-MM-DD` date, or
 * the empty string (after trim) to clear it. Returns an error message, or
 * `null` when valid / absent.
 */
export function lastInteractionError(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t.length === 0 || isIsoDate(t)) return null;
  return `\`lastInteraction\` must be an ISO date (YYYY-MM-DD) or "" to clear; got "${v}"`;
}

/** Slug reserved for the per-kind carry-over file (`<kind>/auto.md`). */
export const CARRY_OVER_SLUG = 'auto';

/** True when `kind`/`slug` names a reserved carry-over record a tool write must not clobber. */
export function isReservedSlug(kind: RoleplayKind, slug: string): boolean {
  return slug === CARRY_OVER_SLUG && (kind === 'summary' || kind === 'timeline');
}

export function emptyRelationshipMeta(): RelationshipMeta {
  return { affinity: 50, trust: '', openThreads: [] };
}

function cloneRelationshipMeta(m: RelationshipMeta): RelationshipMeta {
  return { ...m, openThreads: [...m.openThreads] };
}

export interface RoleplayEntry {
  /** Filename slug (sans `.md`). Stable identifier used by read/update/remove. */
  id: string;
  kind: RoleplayKind;
  name: string;
  description: string;
  /** Lorebook metadata; present iff `kind === 'lore'`. */
  lore?: LoreMeta;
  /** Character-fold metadata; present iff `kind === 'character'` (absent = zero-config name-keyed defaults). */
  character?: CharacterMeta;
  /** Relationship metadata; present iff `kind === 'relationship'`. */
  relationship?: RelationshipMeta;
  /**
   * Name of the activated lore bundle this record was read from
   * (`lore/<bundle>/<id>.md`); absent for base top-level records. A
   * runtime-only annotation the scanner stamps so body reads resolve to
   * the bundle file (never serialized - it is a function of on-disk
   * location, not file content).
   */
  bundle?: string;
  /**
   * Unknown frontmatter keys carried verbatim from the file so an
   * `update` round-trips hand-authored / future fields instead of
   * dropping them. Runtime-only passthrough: never rendered in
   * `INDEX.md` or the injected block, and re-emitted by
   * {@link serializeEntry} after the known keys.
   */
  extra?: Record<string, unknown>;
}

export interface RoleplayState {
  /** Active cast slug this state was scanned for. Empty string when none resolved yet. */
  cast: string;
  entries: RoleplayEntry[];
}

export function emptyState(cast = ''): RoleplayState {
  return { cast, entries: [] };
}

export function cloneEntry(e: RoleplayEntry): RoleplayEntry {
  const copy: RoleplayEntry = { ...e };
  if (e.lore) copy.lore = cloneLoreMeta(e.lore);
  if (e.character) copy.character = cloneCharacterMeta(e.character);
  if (e.relationship) copy.relationship = cloneRelationshipMeta(e.relationship);
  if (e.extra) copy.extra = structuredClone(e.extra);
  return copy;
}

export function cloneState(s: RoleplayState): RoleplayState {
  return { cast: s.cast, entries: s.entries.map(cloneEntry) };
}

// ──────────────────────────────────────────────────────────────────────
// Slugs
// ──────────────────────────────────────────────────────────────────────

/**
 * Filesystem-safe slug. Lowercases, replaces non-alphanumerics with `-`,
 * collapses/trims dashes. Returns `fallback` when the input has no usable
 * characters so callers always get a non-empty slug.
 */
function slugify(input: string, fallback: string): string {
  return slugifyAscii(input, { fallback });
}

/** Slug for a cast / persona name (e.g. "Exusiai & Texas" -> "exusiai-texas"). */
export function castSlug(name: string): string {
  return slugify(name, 'default');
}

/** Slug for an entry *name* (the on-disk filename stem). */
export function slugifyName(name: string): string {
  return slugify(name, 'entry');
}

/** Pick a slug that doesn't collide with any existing entry id. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function takenSlugs(entries: readonly RoleplayEntry[]): Set<string> {
  return new Set(entries.map((e) => e.id));
}

/** Choose a non-colliding slug for a new or renamed entry. */
export function chooseSlug(entries: readonly RoleplayEntry[], name: string, excludeId?: string): string {
  const taken = takenSlugs(entries);
  if (excludeId !== undefined) taken.delete(excludeId);
  return uniqueSlug(slugifyName(name), taken);
}

// ──────────────────────────────────────────────────────────────────────
// Frontmatter (strict YAML subset - mirrors memory-reducer's parser)
// ──────────────────────────────────────────────────────────────────────

export interface Frontmatter {
  name: string;
  description: string;
  kind: RoleplayKind;
  /** Present iff `kind === 'lore'`. */
  lore?: LoreMeta;
  /** Present iff `kind === 'character'`. */
  character?: CharacterMeta;
  /** Present iff `kind === 'relationship'`. */
  relationship?: RelationshipMeta;
  /** Unknown (not consumed for this kind) keys, in file order; absent when none. */
  extra?: Record<string, unknown>;
}

/**
 * Coerce a native YAML frontmatter value to a trimmed string, or
 * `undefined` when it is not string-shaped. Numbers / booleans are
 * stringified; arrays / maps / null land as `undefined`.
 */
function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/**
 * Coerce a YAML value to a trimmed string list. A YAML sequence
 * (`[a, b]` or a block list) arrives as an array; a bare comma-separated
 * scalar (`a, b, c`, as a hand-edit might spell it) is split on commas
 * for backward compatibility. Items are stringified, trimmed, and
 * empties dropped.
 */
function asStringArray(v: unknown): string[] {
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return items.map((x) => (typeof x === 'string' ? x : String(x)).trim()).filter((s) => s.length > 0);
}

/**
 * Coerce a YAML value to a boolean. Native booleans pass through; a
 * number is truthy when non-zero; a string maps `true`/`yes`/`1` and
 * `false`/`no`/`0`. Anything else falls back.
 */
function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === 'yes' || t === '1') return true;
    if (t === 'false' || t === 'no' || t === '0') return false;
  }
  return fallback;
}

/**
 * Coerce a YAML value to an integer. Native numbers are truncated;
 * strings are parsed. Anything unparseable falls back.
 */
function asInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v.trim(), 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** Build lore metadata from the parsed frontmatter key->value map. All fields optional. */
function parseLoreMeta(fields: Readonly<Record<string, unknown>>): LoreMeta {
  const meta = emptyLoreMeta();
  if (fields.triggers !== undefined) meta.triggers = asStringArray(fields.triggers);
  if (fields.secondaryKeys !== undefined) meta.secondaryKeys = asStringArray(fields.secondaryKeys);
  if (fields.secondaryMode !== undefined) {
    const mode = (asString(fields.secondaryMode) ?? '').toUpperCase();
    const known = SECONDARY_MODES.find((m) => m === mode);
    if (known !== undefined) meta.secondaryMode = known;
  }
  if (fields.constant !== undefined) meta.constant = asBool(fields.constant, false);
  if (fields.order !== undefined) meta.order = asInt(fields.order, 0);
  if (fields.recurse !== undefined) meta.recurse = asBool(fields.recurse, false);
  if (fields.depth !== undefined) {
    const d = asInt(fields.depth, -1);
    if (d >= 0) meta.depth = d;
  }
  if (fields.probability !== undefined) meta.probability = Math.min(100, Math.max(0, asInt(fields.probability, 100)));
  if (fields.sticky !== undefined) meta.sticky = Math.max(0, asInt(fields.sticky, 0));
  if (fields.cooldown !== undefined) meta.cooldown = Math.max(0, asInt(fields.cooldown, 0));
  if (fields.delay !== undefined) meta.delay = Math.max(0, asInt(fields.delay, 0));
  if (fields.group !== undefined) meta.group = asString(fields.group) ?? '';
  if (fields.groupWeight !== undefined) meta.groupWeight = Math.max(0, asInt(fields.groupWeight, 100));
  if (fields.enabled !== undefined) meta.enabled = asBool(fields.enabled, true);
  return meta;
}

/** Build character-fold metadata from the parsed frontmatter key->value map. All fields optional. */
function parseCharacterMeta(fields: Readonly<Record<string, unknown>>): CharacterMeta {
  const meta = emptyCharacterMeta();
  if (fields.aliases !== undefined) meta.aliases = asStringArray(fields.aliases);
  if (fields.triggers !== undefined) meta.triggers = asStringArray(fields.triggers);
  if (fields.pinned !== undefined) meta.pinned = asBool(fields.pinned, false);
  if (fields.order !== undefined) meta.order = asInt(fields.order, 0);
  if (fields.sticky !== undefined) meta.sticky = Math.max(0, asInt(fields.sticky, DEFAULT_CHARACTER_STICKY));
  if (fields.cooldown !== undefined) meta.cooldown = Math.max(0, asInt(fields.cooldown, 0));
  if (fields.probability !== undefined) meta.probability = Math.min(100, Math.max(0, asInt(fields.probability, 100)));
  if (fields.delay !== undefined) meta.delay = Math.max(0, asInt(fields.delay, 0));
  return meta;
}

/** Build relationship metadata from the parsed frontmatter key->value map. All fields optional. */
function parseRelationshipMeta(fields: Readonly<Record<string, unknown>>): RelationshipMeta {
  const meta = emptyRelationshipMeta();
  if (fields.affinity !== undefined) {
    const n = asInt(fields.affinity, Number.NaN);
    if (Number.isFinite(n)) meta.affinity = Math.min(100, Math.max(0, n));
  }
  if (fields.trust !== undefined) meta.trust = asString(fields.trust) ?? '';
  if (fields.lastInteraction !== undefined) {
    const v = asString(fields.lastInteraction);
    if (v !== undefined && v.length > 0) meta.lastInteraction = v;
  }
  if (fields.openThreads !== undefined) meta.openThreads = asStringArray(fields.openThreads);
  return meta;
}

export interface ParsedRoleplayFile {
  frontmatter: Frontmatter;
  body: string;
}

const FENCE = '---';

/** Frontmatter keys consumed for every kind. */
const CORE_KEYS: readonly string[] = ['name', 'description', 'kind'];

/** Frontmatter keys consumed per kind (beyond {@link CORE_KEYS}). */
const KIND_KEYS: Record<RoleplayKind, readonly string[]> = {
  lore: [
    'triggers',
    'secondaryKeys',
    'secondaryMode',
    'constant',
    'order',
    'depth',
    'recurse',
    'probability',
    'sticky',
    'cooldown',
    'delay',
    'group',
    'groupWeight',
    'enabled',
  ],
  character: ['aliases', 'triggers', 'pinned', 'order', 'sticky', 'cooldown', 'probability', 'delay'],
  relationship: ['affinity', 'trust', 'lastInteraction', 'openThreads'],
  summary: [],
  timeline: [],
};

/** Collect the keys a given kind does not consume, preserving file order. */
function unknownFields(fields: Readonly<Record<string, unknown>>, kind: RoleplayKind): Record<string, unknown> | null {
  const known = new Set([...CORE_KEYS, ...KIND_KEYS[kind]]);
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [key, value] of Object.entries(fields)) {
    if (known.has(key)) continue;
    out[key] = value;
    any = true;
  }
  return any ? out : null;
}

/**
 * Parse a roleplay markdown file. Returns `null` if the frontmatter fence
 * is missing/incomplete or the three required keys aren't all present and
 * valid. Unknown keys (not consumed by the entry's kind) are preserved on
 * `frontmatter.extra` so a rewrite can re-emit them.
 *
 * Fence detection, header splitting, and body slicing are delegated to
 * the shared {@link parseFencedFrontmatter} (which returns raw, un-quoted
 * values); this function layers roleplay's domain rules (required
 * `name` / `description` / `kind`, per-kind lore/relationship metadata)
 * on top.
 */
export function parseFrontmatter(raw: string): ParsedRoleplayFile | null {
  const parsed = parseFencedFrontmatter(raw);
  if (parsed === null) return null;
  const { fields, body } = parsed;

  const name = asString(fields.name);
  const description = asString(fields.description);
  const kindRaw = asString(fields.kind);

  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof description !== 'string') return null;
  if (kindRaw === undefined || !(ROLEPLAY_KINDS as readonly string[]).includes(kindRaw)) return null;
  const kind = kindRaw as RoleplayKind;

  const frontmatter: Frontmatter = { name, description, kind };
  if (kind === 'lore') frontmatter.lore = parseLoreMeta(fields);
  if (kind === 'character') frontmatter.character = parseCharacterMeta(fields);
  if (kind === 'relationship') frontmatter.relationship = parseRelationshipMeta(fields);
  const extra = unknownFields(fields, kind);
  if (extra) frontmatter.extra = extra;

  return { frontmatter, body };
}

function yamlValue(raw: string): string {
  const s = raw.replace(/\r?\n/g, ' ').trim();
  if (s.length === 0) return '""';
  if (/^[^"':#\\][^:#\n\\]*$/.test(s) && !s.endsWith(' ')) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Serialize one inline-list item. Same bare-scalar rule as {@link yamlValue}
 * but also quotes the inline-list metacharacters (comma and brackets) so an
 * item that contains a comma round-trips through {@link asStringArray}
 * instead of being split into two.
 */
function yamlListItem(raw: string): string {
  const s = raw.replace(/\r?\n/g, ' ').trim();
  if (s.length === 0) return '""';
  if (/^[^"':#\\,[\]][^:#\n\\,[\]]*$/.test(s) && !s.endsWith(' ')) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Render a preserved unknown frontmatter value as YAML. Plain identifier-
 * like strings stay bare; everything else (other strings, numbers,
 * booleans, null, lists, maps) is emitted as JSON, which is valid YAML
 * flow syntax and reparses to the same value. Returns `null` for
 * unrepresentable values (e.g. `undefined`).
 */
function yamlExtraValue(value: unknown): string | null {
  if (
    typeof value === 'string' &&
    /^[A-Za-z][\w ./-]*$/.test(value) &&
    !value.endsWith(' ') &&
    !/^(?:true|false|null|yes|no|on|off|y|n)$/i.test(value)
  ) {
    return value;
  }
  const json: string | undefined = JSON.stringify(value);
  return json ?? null;
}

export function serializeEntry(input: {
  name: string;
  description: string;
  kind: RoleplayKind;
  body: string;
  lore?: LoreMeta;
  character?: CharacterMeta;
  relationship?: RelationshipMeta;
  /** Unknown keys to re-emit after the known ones (see {@link RoleplayEntry.extra}). */
  extra?: Readonly<Record<string, unknown>>;
}): string {
  const body = input.body.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const lines = [
    FENCE,
    `name: ${yamlValue(input.name)}`,
    `description: ${yamlValue(input.description)}`,
    `kind: ${input.kind}`,
  ];
  if (input.kind === 'lore' && input.lore) {
    const m = input.lore;
    if (m.triggers.length > 0) lines.push(`triggers: [${m.triggers.map(yamlListItem).join(', ')}]`);
    if (m.secondaryKeys.length > 0) {
      lines.push(`secondaryKeys: [${m.secondaryKeys.map(yamlListItem).join(', ')}]`);
      lines.push(`secondaryMode: ${m.secondaryMode}`);
    }
    if (m.constant) lines.push('constant: true');
    if (m.order !== 0) lines.push(`order: ${m.order}`);
    if (m.depth !== undefined) lines.push(`depth: ${m.depth}`);
    if (m.recurse) lines.push('recurse: true');
    if (m.probability !== 100) lines.push(`probability: ${m.probability}`);
    if (m.sticky > 0) lines.push(`sticky: ${m.sticky}`);
    if (m.cooldown > 0) lines.push(`cooldown: ${m.cooldown}`);
    if (m.delay > 0) lines.push(`delay: ${m.delay}`);
    if (m.group.length > 0) lines.push(`group: ${yamlValue(m.group)}`);
    if (m.groupWeight !== 100) lines.push(`groupWeight: ${m.groupWeight}`);
    if (!m.enabled) lines.push('enabled: false');
  }
  if (input.kind === 'character' && input.character) {
    const m = input.character;
    if (m.aliases.length > 0) lines.push(`aliases: [${m.aliases.map(yamlListItem).join(', ')}]`);
    if (m.triggers.length > 0) lines.push(`triggers: [${m.triggers.map(yamlListItem).join(', ')}]`);
    if (m.pinned) lines.push('pinned: true');
    if (m.order !== 0) lines.push(`order: ${m.order}`);
    if (m.sticky !== DEFAULT_CHARACTER_STICKY) lines.push(`sticky: ${m.sticky}`);
    if (m.cooldown > 0) lines.push(`cooldown: ${m.cooldown}`);
    if (m.probability !== 100) lines.push(`probability: ${m.probability}`);
    if (m.delay > 0) lines.push(`delay: ${m.delay}`);
  }
  if (input.kind === 'relationship' && input.relationship) {
    const m = input.relationship;
    lines.push(`affinity: ${m.affinity}`);
    if (m.trust.length > 0) lines.push(`trust: ${yamlValue(m.trust)}`);
    if (m.lastInteraction !== undefined) lines.push(`lastInteraction: ${m.lastInteraction}`);
    if (m.openThreads.length > 0) lines.push(`openThreads: [${m.openThreads.map(yamlListItem).join(', ')}]`);
  }
  if (input.extra) {
    const emitted = new Set([...CORE_KEYS, ...KIND_KEYS[input.kind]]);
    for (const [key, value] of Object.entries(input.extra)) {
      if (emitted.has(key)) continue;
      const rendered = yamlExtraValue(value);
      if (rendered !== null) lines.push(`${/^[A-Za-z_][\w-]*$/.test(key) ? key : JSON.stringify(key)}: ${rendered}`);
    }
  }
  lines.push(FENCE, '', body, '');
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Pure index operations
// ──────────────────────────────────────────────────────────────────────

export function findEntry(entries: readonly RoleplayEntry[], id: string): RoleplayEntry | undefined {
  return entries.find((e) => e.id === id);
}

/**
 * Resolve an entry by `id`, optionally disambiguating by `kind` when the
 * same slug exists under more than one kind (e.g. a `character` and a
 * `lore` entry both named `rhodes`). When no `kind` is given and the id
 * is ambiguous, returns an error asking the caller to pass one.
 */
export function resolveEntry(
  state: RoleplayState,
  params: { id?: string; kind?: RoleplayKind },
): RoleplayEntry | { error: string } {
  if (!params.id) return { error: '`id` is required' };
  const matches = state.entries.filter((e) => e.id === params.id);
  const cast = state.cast || '(none)';
  if (matches.length === 0) return { error: `no roleplay entry "${params.id}" in cast "${cast}"` };
  if (params.kind !== undefined) {
    const k = matches.find((e) => e.kind === params.kind);
    if (!k) return { error: `no ${params.kind} entry "${params.id}" in cast "${cast}"` };
    return k;
  }
  if (matches.length > 1) {
    const kinds = matches.map((e) => e.kind).join(', ');
    return { error: `ambiguous id "${params.id}" across kinds (${kinds}); pass \`kind\`` };
  }
  return matches[0];
}
function sortEntries(entries: RoleplayEntry[]): RoleplayEntry[] {
  entries.sort((a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`));
  return entries;
}

/**
 * Insert or replace `entry`, keyed on `kind` + `id` (the same slug may
 * legitimately exist under several kinds).
 */
export function upsertEntry(entries: readonly RoleplayEntry[], entry: RoleplayEntry): RoleplayEntry[] {
  const next = entries.map(cloneEntry);
  const existing = next.findIndex((e) => e.kind === entry.kind && e.id === entry.id);
  if (existing === -1) next.push(cloneEntry(entry));
  else next[existing] = cloneEntry(entry);
  return sortEntries(next);
}

/** Drop the entry keyed on `kind` + `id`; same-id entries of other kinds survive. */
export function removeEntry(entries: readonly RoleplayEntry[], kind: RoleplayKind, id: string): RoleplayEntry[] {
  return entries.map(cloneEntry).filter((e) => !(e.kind === kind && e.id === id));
}

// ──────────────────────────────────────────────────────────────────────
// Renderers
// ──────────────────────────────────────────────────────────────────────

function groupByKind(entries: readonly RoleplayEntry[]): Map<RoleplayKind, RoleplayEntry[]> {
  const out = new Map<RoleplayKind, RoleplayEntry[]>();
  for (const k of ROLEPLAY_KINDS) out.set(k, []);
  for (const e of entries) out.get(e.kind)?.push(e);
  return out;
}

/** Section heading shown per kind in the index + injected block. */
const KIND_HEADING: Record<RoleplayKind, string> = {
  character: 'Characters',
  lore: 'Lore',
  relationship: 'Relationships',
  summary: 'Summaries',
  timeline: 'Timeline',
};

/**
 * Render the `## Lore` section of `INDEX.md`. Base lore (no `bundle`)
 * lists first with `lore/<id>.md` links; each named bundle then gets its
 * own `### Lore bundle: <name>` subsection with `lore/<bundle>/<id>.md`
 * links, so the index makes bundle membership obvious and every link
 * points at the record's real on-disk path.
 */
function renderLoreSection(lines: string[], lore: readonly RoleplayEntry[]): void {
  lines.push(`## ${KIND_HEADING.lore}`);
  const base = lore.filter((e) => !e.bundle);
  for (const e of base) lines.push(`- [${e.name}](lore/${e.id}.md) - ${e.description}`);
  lines.push('');

  const byBundle = new Map<string, RoleplayEntry[]>();
  for (const e of lore) {
    if (!e.bundle) continue;
    const group = byBundle.get(e.bundle) ?? [];
    group.push(e);
    byBundle.set(e.bundle, group);
  }
  for (const name of [...byBundle.keys()].sort()) {
    lines.push(`### Lore bundle: ${name}`);
    for (const e of byBundle.get(name) ?? []) {
      lines.push(`- [${e.name}](lore/${name}/${e.id}.md) - ${e.description}`);
    }
    lines.push('');
  }
}

/** Render the on-disk `INDEX.md` for a cast. Always predictable to skim.
 *
 * The index is a human/agent-facing map only (never read at runtime), so
 * it should be a COMPLETE inventory: callers pass a state whose entries
 * cover base records plus every lore bundle on disk (see
 * `scanCastComplete`). Every entry links to its REAL relative path -
 * bundle-sourced lore (`entry.bundle` set) links to
 * `lore/<bundle>/<id>.md`, base records to `<kind>/<id>.md` - and lore
 * bundles get their own `### Lore bundle: <name>` subsection so it is
 * obvious which records belong to which bundle.
 */
export function renderIndexMd(state: RoleplayState): string {
  const lines: string[] = [`# Roleplay cast: ${state.cast || '(none)'}`, ''];
  const grouped = groupByKind(state.entries);
  for (const kind of ROLEPLAY_KINDS) {
    if (kind === 'lore') {
      renderLoreSection(lines, grouped.get('lore') ?? []);
      continue;
    }
    lines.push(`## ${KIND_HEADING[kind]}`);
    const group = grouped.get(kind) ?? [];
    if (group.length === 0) {
      lines.push('');
      continue;
    }
    for (const e of group) lines.push(`- [${e.name}](${kind}/${e.id}.md) - ${e.description}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Human-readable plaintext dump returned as tool `content`. */
export function formatText(state: RoleplayState): string {
  if (state.entries.length === 0) return `(roleplay cast "${state.cast || '(none)'}" is empty)`;
  const parts: string[] = [`Cast "${state.cast}" (${state.entries.length}):`];
  for (const e of state.entries) parts.push(`  [${e.kind}] ${e.id} - ${e.name}: ${e.description}`);
  return parts.join('\n');
}

export interface FormatOptions {
  /** Soft cap on the injected block in characters. Default 3000. */
  maxChars?: number;
}

/**
 * Build the `## Roleplay` block injected into the system prompt each
 * turn. Returns `null` when the cast is empty so the caller can skip
 * injection. Only the one-line-per-entry index is injected; full bodies
 * are fetched on demand via `roleplay read <id>`.
 *
 * Soft char cap: each rendered entry fits whole; we stop adding entries
 * once the next would blow the budget, then emit a trailer.
 */
export function formatRoleplayBlock(state: RoleplayState, opts: FormatOptions = {}): string | null {
  if (state.entries.length === 0) return null;
  const cap = Math.max(500, opts.maxChars ?? 3000);

  const lines: string[] = [`## Roleplay — cast: ${state.cast || '(none)'}`, ''];
  let used = lines.join('\n').length;
  let skipped = 0;
  let truncated = false;

  const grouped = groupByKind(state.entries);
  for (const kind of ROLEPLAY_KINDS) {
    const group = grouped.get(kind) ?? [];
    if (group.length === 0) continue;
    const heading = `### ${KIND_HEADING[kind]}`;
    if (used + heading.length + 1 > cap && lines.length > 2) {
      truncated = true;
      skipped += group.length;
      continue;
    }
    lines.push(heading);
    used += heading.length + 1;
    for (const e of group) {
      const line = `- ${e.name} (\`${e.id}\`) - ${e.description}`;
      if (used + line.length + 1 > cap && lines.length > 3) {
        truncated = true;
        skipped++;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
    lines.push('');
  }

  if (truncated) {
    lines.push(`(${skipped} more entry(ies) not shown - call \`roleplay\` action \`list\` to see all.)`);
  } else {
    lines.push('Call `roleplay` action `read` + the id in backticks to load a full sheet; `save` to add one.');
  }
  return lines.join('\n').trimEnd();
}
