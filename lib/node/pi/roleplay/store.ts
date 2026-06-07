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
 *     `depth` / `recurse` via a small inline-list parser.
 *   - Pure index CRUD (callers pair these with disk writes in the shell).
 *   - `INDEX.md` renderer + the injected `## Roleplay` block.
 *
 * Phase 1 shipped the `character` kind; Phase 2 adds `lore` (keyword-
 * triggered World Info injection). Phase 3+ extends `ROLEPLAY_KINDS`
 * further with `relationship` / `timeline` / `summary`.
 */

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export const ROLEPLAY_KINDS = ['character', 'lore'] as const;
export type RoleplayKind = (typeof ROLEPLAY_KINDS)[number];

/** Selective-key combination logic for a lore entry's secondary keys. */
export type SecondaryMode = 'AND' | 'OR' | 'NOT';

/**
 * World-Info / lorebook metadata, present only on `lore` entries
 * (`RoleplayEntry.lore`). Drives keyword-triggered injection:
 *   - `triggers`: primary keys, OR'd. Any hit fires the entry.
 *   - `secondaryKeys` + `secondaryMode`: optional AND/OR/NOT gate applied
 *     against the same scan text after a primary hit.
 *   - `constant`: always fire (budget permitting), ignoring triggers.
 *   - `order`: higher wins when the char budget forces eviction.
 *   - `depth`: context-event insertion depth (parsed now, injected at
 *     depth only once Phase 4 wires the `context` handler).
 *   - `recurse`: opt-in; this entry's body is re-scanned to fire further
 *     entries, bounded by `maxRecursion`.
 */
export interface LoreMeta {
  triggers: string[];
  secondaryKeys: string[];
  secondaryMode: SecondaryMode;
  constant: boolean;
  order: number;
  depth?: number;
  recurse: boolean;
}

export function emptyLoreMeta(): LoreMeta {
  return { triggers: [], secondaryKeys: [], secondaryMode: 'AND', constant: false, order: 0, recurse: false };
}

function cloneLoreMeta(m: LoreMeta): LoreMeta {
  return { ...m, triggers: [...m.triggers], secondaryKeys: [...m.secondaryKeys] };
}

export interface RoleplayEntry {
  /** Filename slug (sans `.md`). Stable identifier used by read/update/remove. */
  id: string;
  kind: RoleplayKind;
  name: string;
  description: string;
  /** Lorebook metadata; present iff `kind === 'lore'`. */
  lore?: LoreMeta;
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
  return e.lore ? { ...e, lore: cloneLoreMeta(e.lore) } : { ...e };
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
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : fallback;
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
}

function stripQuotes(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\([\\"])/g, '$1');
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split an inline `[a, b, c]` (or bare `a, b, c`) list value into trimmed items. */
function parseInlineList(raw: string): string[] {
  const t = raw.trim();
  const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
  return inner
    .split(',')
    .map((s) => stripQuotes(s))
    .filter((s) => s.length > 0);
}

function parseBool(raw: string, fallback: boolean): boolean {
  const t = raw.trim().toLowerCase();
  if (t === 'true' || t === 'yes' || t === '1') return true;
  if (t === 'false' || t === 'no' || t === '0') return false;
  return fallback;
}

function parseIntOr(raw: string, fallback: number): number {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Build lore metadata from the raw frontmatter key->value map. All fields optional. */
function parseLoreMeta(fields: Readonly<Record<string, string>>): LoreMeta {
  const meta = emptyLoreMeta();
  if (fields.triggers !== undefined) meta.triggers = parseInlineList(fields.triggers);
  if (fields.secondaryKeys !== undefined) meta.secondaryKeys = parseInlineList(fields.secondaryKeys);
  if (fields.secondaryMode !== undefined) {
    const mode = stripQuotes(fields.secondaryMode).toUpperCase();
    if (mode === 'OR' || mode === 'NOT' || mode === 'AND') meta.secondaryMode = mode;
  }
  if (fields.constant !== undefined) meta.constant = parseBool(fields.constant, false);
  if (fields.order !== undefined) meta.order = parseIntOr(fields.order, 0);
  if (fields.recurse !== undefined) meta.recurse = parseBool(fields.recurse, false);
  if (fields.depth !== undefined) {
    const d = Number.parseInt(fields.depth.trim(), 10);
    if (Number.isFinite(d) && d >= 0) meta.depth = d;
  }
  return meta;
}

export interface ParsedRoleplayFile {
  frontmatter: Frontmatter;
  body: string;
}

const FENCE = '---';

/**
 * Parse a roleplay markdown file. Returns `null` if the frontmatter fence
 * is missing/incomplete or the three required keys aren't all present and
 * valid. Unknown keys are ignored (forward-compat for Phase 2 fields).
 */
export function parseFrontmatter(raw: string): ParsedRoleplayFile | null {
  const src = raw.replace(/\r\n/g, '\n');
  if (!src.startsWith(`${FENCE}\n`) && !src.startsWith(`${FENCE}\r\n`)) return null;

  const afterOpen = FENCE.length + 1;
  const closeIdx = src.indexOf(`\n${FENCE}\n`, afterOpen - 1);
  const closeIdxEof = src.endsWith(`\n${FENCE}`) ? src.length - FENCE.length - 1 : -1;
  const end = closeIdx !== -1 ? closeIdx : closeIdxEof;
  if (end === -1) return null;

  const header = src.slice(afterOpen, end);
  const bodyStart = end + FENCE.length + 2;
  const body = bodyStart <= src.length ? src.slice(bodyStart) : '';

  const fields: Record<string, string> = {};
  for (const rawLine of header.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.length === 0) continue;
    const sep = line.indexOf(':');
    if (sep === -1) return null;
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1);
  }

  const name = fields.name !== undefined ? stripQuotes(fields.name) : undefined;
  const description = fields.description !== undefined ? stripQuotes(fields.description) : undefined;
  const kindRaw = fields.kind !== undefined ? stripQuotes(fields.kind) : undefined;

  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof description !== 'string') return null;
  if (kindRaw === undefined || !(ROLEPLAY_KINDS as readonly string[]).includes(kindRaw)) return null;
  const kind = kindRaw as RoleplayKind;

  const frontmatter: Frontmatter = { name, description, kind };
  if (kind === 'lore') frontmatter.lore = parseLoreMeta(fields);

  return { frontmatter, body: body.replace(/^\n+/, '') };
}

function yamlValue(raw: string): string {
  const s = raw.replace(/\r?\n/g, ' ').trim();
  if (s.length === 0) return '""';
  if (/^[^"':#\\][^:#\n\\]*$/.test(s) && !s.endsWith(' ')) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function serializeEntry(input: {
  name: string;
  description: string;
  kind: RoleplayKind;
  body: string;
  lore?: LoreMeta;
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
    if (m.triggers.length > 0) lines.push(`triggers: [${m.triggers.join(', ')}]`);
    if (m.secondaryKeys.length > 0) {
      lines.push(`secondaryKeys: [${m.secondaryKeys.join(', ')}]`);
      lines.push(`secondaryMode: ${m.secondaryMode}`);
    }
    if (m.constant) lines.push('constant: true');
    if (m.order !== 0) lines.push(`order: ${m.order}`);
    if (m.depth !== undefined) lines.push(`depth: ${m.depth}`);
    if (m.recurse) lines.push('recurse: true');
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

export function upsertEntry(entries: readonly RoleplayEntry[], entry: RoleplayEntry): RoleplayEntry[] {
  const next = entries.map(cloneEntry);
  const existing = next.findIndex((e) => e.id === entry.id);
  if (existing === -1) next.push(cloneEntry(entry));
  else next[existing] = cloneEntry(entry);
  return sortEntries(next);
}

export function removeEntry(entries: readonly RoleplayEntry[], id: string): RoleplayEntry[] {
  return entries.map(cloneEntry).filter((e) => e.id !== id);
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
};

/** Render the on-disk `INDEX.md` for a cast. Always predictable to skim. */
export function renderIndexMd(state: RoleplayState): string {
  const lines: string[] = [`# Roleplay cast: ${state.cast || '(none)'}`, ''];
  const grouped = groupByKind(state.entries);
  for (const kind of ROLEPLAY_KINDS) {
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
