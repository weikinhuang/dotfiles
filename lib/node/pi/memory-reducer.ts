/**
 * Pure state types + frontmatter / index helpers for the memory extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * Memory lives on disk (source of truth). This module handles:
 *   - `MemoryEntry` / `MemoryIndex` / `MemoryState` types.
 *   - Strict three-key frontmatter parse + serialize (no external YAML dep -
 *     the frontmatter surface is intentionally tiny: `name`, `description`,
 *     `type`).
 *   - Pure index CRUD (callers pair these with disk writes in the extension).
 *   - `MEMORY.md` renderer grouped by memory type.
 *   - Shape validator for branch-mirrored snapshots.
 */

import {
  type ActionError,
  type ActionResult as GenericActionResult,
  type ActionSuccess as GenericActionSuccess,
  type BranchEntry as GenericBranchEntry,
  findLatestStateInBranch,
  stateFromEntryGeneric,
} from './branch-state.ts';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'note'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SCOPES = ['global', 'project', 'session'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface MemoryEntry {
  /** Filename slug (sans `.md`). Stable identifier used by read/update/remove. */
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  name: string;
  description: string;
  /**
   * ISO-8601 UTC datetime the memory was first written (e.g.
   * `2026-06-30T14:22:01Z`). `undefined` for legacy files saved before
   * timestamps existed.
   */
  created?: string;
  /** ISO-8601 UTC datetime of the most recent write. `undefined` for legacy files. */
  updated?: string;
}

export interface MemoryIndex {
  global: MemoryEntry[];
  project: MemoryEntry[];
  /**
   * Session-scoped entries, keyed on disk by the current session id. Only
   * ever populated for the session that owns them - other sessions never
   * scan this bucket.
   */
  session: MemoryEntry[];
}

export interface MemoryState {
  index: MemoryIndex;
  /**
   * The cwd-slug used for the current project scope (mirrors pi's
   * session-dir name). `null` when the workspace doesn't have a
   * resolved cwd yet - e.g. before `session_start`.
   */
  projectSlug: string | null;
  /**
   * The session id used for the current session scope (mirrors pi's
   * `<sid>.jsonl` transcript name). `null` when there is no resolved
   * session - e.g. before `session_start` or under `--no-session`.
   */
  sessionId: string | null;
}

export const MEMORY_TOOL_NAME = 'memory';
export const MEMORY_CUSTOM_TYPE = 'memory-state';

/** Re-exported so callers have a single import path. */
export type BranchEntry = GenericBranchEntry;

export function emptyIndex(): MemoryIndex {
  return { global: [], project: [], session: [] };
}

export function emptyState(): MemoryState {
  return { index: emptyIndex(), projectSlug: null, sessionId: null };
}

export function cloneEntry(e: MemoryEntry): MemoryEntry {
  return { ...e };
}

export function cloneIndex(idx: MemoryIndex): MemoryIndex {
  return {
    global: idx.global.map(cloneEntry),
    project: idx.project.map(cloneEntry),
    session: idx.session.map(cloneEntry),
  };
}

export function cloneState(s: MemoryState): MemoryState {
  return { index: cloneIndex(s.index), projectSlug: s.projectSlug, sessionId: s.sessionId };
}

export function defaultMemoryScope(type: MemoryType): MemoryScope {
  if (type === 'note') return 'session';
  return type === 'project' || type === 'reference' ? 'project' : 'global';
}

/**
 * The default (and, for `session`, only) memory type for a scope. Lets
 * `save` with an explicit `scope: 'session'` omit `type` since `note` is
 * the only type valid there. Returns `undefined` for scopes that don't
 * have a single obvious default - the caller must require `type`.
 */
export function defaultMemoryTypeForScope(scope: MemoryScope): MemoryType | undefined {
  return scope === 'session' ? 'note' : undefined;
}

export function isMemoryTypeAllowedInScope(type: MemoryType, scope: MemoryScope): boolean {
  if (scope === 'session') return type === 'note';
  // `note` is exclusive to the session scope.
  if (type === 'note') return false;
  if (scope === 'global') return type === 'user' || type === 'feedback';
  return true;
}

/** Types meaningful within a scope, in render order. Single source of
 *  truth for the index renderer, the disk scanner, and the prompt block. */
export function validTypesForScope(scope: MemoryScope): MemoryType[] {
  if (scope === 'global') return ['user', 'feedback'];
  if (scope === 'session') return ['note'];
  return ['user', 'feedback', 'project', 'reference'];
}

// ──────────────────────────────────────────────────────────────────────
// Shape validation (for branch-mirrored snapshots)
// ──────────────────────────────────────────────────────────────────────

function isMemoryEntryShape(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (!(MEMORY_SCOPES as readonly string[]).includes(v.scope as MemoryScope)) return false;
  if (!MEMORY_TYPES.includes(v.type as MemoryType)) return false;
  if (typeof v.name !== 'string') return false;
  if (typeof v.description !== 'string') return false;
  // Timestamps are optional; when present they must be strings.
  if (v.created !== undefined && typeof v.created !== 'string') return false;
  if (v.updated !== undefined && typeof v.updated !== 'string') return false;
  return true;
}

function isMemoryIndexShape(value: unknown): value is MemoryIndex {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.global) || !Array.isArray(v.project) || !Array.isArray(v.session)) return false;
  return (
    v.global.every(isMemoryEntryShape) && v.project.every(isMemoryEntryShape) && v.session.every(isMemoryEntryShape)
  );
}

export function isMemoryStateShape(value: unknown): value is MemoryState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.projectSlug !== null && typeof v.projectSlug !== 'string') return false;
  if (v.sessionId !== null && typeof v.sessionId !== 'string') return false;
  return isMemoryIndexShape(v.index);
}

export function stateFromEntry(entry: BranchEntry): MemoryState | null {
  return stateFromEntryGeneric(entry, MEMORY_TOOL_NAME, MEMORY_CUSTOM_TYPE, isMemoryStateShape, cloneState);
}

export function reduceBranch(branch: readonly BranchEntry[]): MemoryState | null {
  return findLatestStateInBranch(branch, MEMORY_TOOL_NAME, MEMORY_CUSTOM_TYPE, isMemoryStateShape, cloneState);
}

// ──────────────────────────────────────────────────────────────────────
// Frontmatter (strict five-key YAML subset)
// ──────────────────────────────────────────────────────────────────────

export interface Frontmatter {
  name: string;
  description: string;
  type: MemoryType;
  /**
   * ISO-8601 UTC datetime of first write. Optional so files written
   * before timestamps existed (the original three-key form) still parse;
   * an absent or unparseable value lands here as `undefined`.
   */
  created?: string;
  /** ISO-8601 UTC datetime of the most recent write. Optional, same as `created`. */
  updated?: string;
}

export interface ParsedMemoryFile {
  frontmatter: Frontmatter;
  body: string;
}

const FENCE = '---';

/**
 * Undo `yamlValue`'s quoting for a frontmatter value. Double-quoted
 * values have their `\\` / `\"` escapes reversed so a roundtrip of a
 * backslash- or quote-bearing value is stable. Single-quoted values
 * are treated as literal - they only appear if a human hand-edits the
 * file, and we never emit them.
 */
function stripQuotes(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    // Reverse the escapes applied by `yamlValue`. Order matters:
    // unescape `\\` first so a `\"` next to a `\\` isn't double-counted.
    return t.slice(1, -1).replace(/\\([\\"])/g, '$1');
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Coerce a raw frontmatter timestamp into a normalised ISO-8601 UTC
 * string, or `undefined` when the value is missing or unparseable.
 * Parsing is deliberately loose: a bad timestamp is treated as absent,
 * never a reason to reject the whole file.
 */
function parseTimestamp(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t.length === 0) return undefined;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Parse a memory markdown file. Returns `null` if the frontmatter fence
 * is missing, incomplete, or the three required keys aren't all present.
 *
 * The body starts immediately after the closing fence's newline, so a
 * body can itself contain `---` rules without confusing the parser.
 */
export function parseFrontmatter(raw: string): ParsedMemoryFile | null {
  // Normalise CRLF so the matching stays simple.
  const src = raw.replace(/\r\n/g, '\n');
  if (!src.startsWith(`${FENCE}\n`) && !src.startsWith(`${FENCE}\r\n`)) return null;

  const afterOpen = FENCE.length + 1; // skip the opening `---\n`
  const closeIdx = src.indexOf(`\n${FENCE}\n`, afterOpen - 1);
  // Tolerate a file ending exactly with `\n---` (no trailing newline).
  const closeIdxEof = src.endsWith(`\n${FENCE}`) ? src.length - FENCE.length - 1 : -1;
  const end = closeIdx !== -1 ? closeIdx : closeIdxEof;
  if (end === -1) return null;

  const header = src.slice(afterOpen, end);
  // Step over the closing `\n---` + trailing newline. When the match came
  // from `closeIdxEof` (no final newline), bodyStart may equal src.length,
  // and the slice below yields an empty body - fine.
  const bodyStart = end + FENCE.length + 2;
  const body = bodyStart <= src.length ? src.slice(bodyStart) : '';

  const partial: Partial<Frontmatter> = {};
  let createdRaw: string | undefined;
  let updatedRaw: string | undefined;
  for (const rawLine of header.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.length === 0) continue;
    const sep = line.indexOf(':');
    if (sep === -1) return null;
    const key = line.slice(0, sep).trim();
    const value = stripQuotes(line.slice(sep + 1));
    if (key === 'name') partial.name = value;
    else if (key === 'description') partial.description = value;
    else if (key === 'type') {
      if (!(MEMORY_TYPES as readonly string[]).includes(value)) return null;
      partial.type = value as MemoryType;
    } else if (key === 'created') createdRaw = value;
    else if (key === 'updated') updatedRaw = value;
    // Unknown keys are ignored - allows for forward compatibility.
  }

  if (typeof partial.name !== 'string' || partial.name.length === 0) return null;
  if (typeof partial.description !== 'string') return null;
  if (partial.type === undefined) return null;

  // Timestamps are loose: an absent or unparseable value is `undefined`,
  // never a reason to reject the file (old three-key files have neither).
  const created = parseTimestamp(createdRaw);
  const updated = parseTimestamp(updatedRaw);

  return {
    frontmatter: {
      name: partial.name,
      description: partial.description,
      type: partial.type,
      ...(created !== undefined ? { created } : {}),
      ...(updated !== undefined ? { updated } : {}),
    },
    body: body.replace(/^\n+/, ''),
  };
}

/** Escape a value for our strict YAML subset - wrap in double quotes if
 *  it contains anything that would confuse either our parser or a
 *  standards-compliant YAML reader (e.g. `#` starts a comment, `:` splits
 *  key/value, surrounding quotes alter parsing). */
function yamlValue(raw: string): string {
  const s = raw.replace(/\r?\n/g, ' ').trim();
  if (s.length === 0) return '""';
  // Unquoted form is only safe when none of `"` / `'` / `:` / `#` / `\`
  // appear and the value has no leading/trailing whitespace. `stripQuotes`
  // is asymmetric (it only un-escapes when quoted), so a value containing
  // `\` MUST go through the quoted path.
  if (/^[^"':#\\][^:#\n\\]*$/.test(s) && !s.endsWith(' ')) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function serializeMemory(input: {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  /** ISO-8601 UTC datetime; the extension passes `now.toISOString()`. Omitted when absent. */
  created?: string;
  updated?: string;
}): string {
  const body = input.body.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const lines = [
    FENCE,
    `name: ${yamlValue(input.name)}`,
    `description: ${yamlValue(input.description)}`,
    `type: ${input.type}`,
  ];
  // Timestamps come after `type`; an ISO string carries a `:` so it goes
  // through `yamlValue`'s quoted path. Omitted entirely when absent so a
  // re-serialised legacy file stays in its original three-key form.
  if (input.created !== undefined) lines.push(`created: ${yamlValue(input.created)}`);
  if (input.updated !== undefined) lines.push(`updated: ${yamlValue(input.updated)}`);
  lines.push(FENCE, '', body, '');
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Pure index operations
// ──────────────────────────────────────────────────────────────────────

function entriesFor(index: MemoryIndex, scope: MemoryScope): MemoryEntry[] {
  if (scope === 'global') return index.global;
  if (scope === 'session') return index.session;
  return index.project;
}

export function findEntry(index: MemoryIndex, scope: MemoryScope, id: string): MemoryEntry | undefined {
  return entriesFor(index, scope).find((e) => e.id === id);
}

export function resolveMemoryEntry(
  state: MemoryState,
  params: { id?: string; type?: MemoryType; scope?: MemoryScope },
): MemoryEntry | { error: string } {
  if (!params.id) return { error: '`id` is required' };
  const scopes: MemoryScope[] = params.scope ? [params.scope] : ['session', 'project', 'global'];
  for (const scope of scopes) {
    const e = findEntry(state.index, scope, params.id);
    if (!e) continue;
    if (params.type && e.type !== params.type) continue;
    return e;
  }
  return { error: `no memory "${params.id}" found${params.scope ? ` in scope "${params.scope}"` : ''}` };
}

/**
 * Return the set of entry slugs currently in a given scope - useful when
 * the disk layer needs to pick a non-colliding slug before a save.
 */
export function takenSlugs(index: MemoryIndex, scope: MemoryScope): Set<string> {
  return new Set(entriesFor(index, scope).map((e) => e.id));
}

export function upsertEntry(index: MemoryIndex, entry: MemoryEntry): MemoryIndex {
  const next = cloneIndex(index);
  const target = entriesFor(next, entry.scope);
  const existing = target.findIndex((e) => e.id === entry.id);
  if (existing === -1) target.push(cloneEntry(entry));
  else target[existing] = cloneEntry(entry);
  target.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.id.localeCompare(b.id);
  });
  return next;
}

export function removeEntry(index: MemoryIndex, scope: MemoryScope, id: string): MemoryIndex {
  const next = cloneIndex(index);
  const target = entriesFor(next, scope);
  const idx = target.findIndex((e) => e.id === id);
  if (idx !== -1) target.splice(idx, 1);
  return next;
}

// ──────────────────────────────────────────────────────────────────────
// Renderers
// ──────────────────────────────────────────────────────────────────────

function groupByType(entries: readonly MemoryEntry[]): Map<MemoryType, MemoryEntry[]> {
  const out = new Map<MemoryType, MemoryEntry[]>();
  for (const t of MEMORY_TYPES) out.set(t, []);
  for (const e of entries) out.get(e.type)?.push(e);
  return out;
}

/**
 * Render the on-disk `MEMORY.md` index for a given scope. Files without
 * any entries still get a `# Memory Index` header and the type sections,
 * so the file is always predictable for the model to skim.
 *
 * `scope === 'global'` only lists `user` and `feedback` (the two types
 * meaningful at the cross-project level).
 */
export function renderMemoryMd(entries: readonly MemoryEntry[], scope: MemoryScope): string {
  const lines: string[] = ['# Memory Index', ''];
  const validTypes: MemoryType[] = validTypesForScope(scope);
  const grouped = groupByType(entries);
  for (const type of validTypes) {
    lines.push(`## ${type}`);
    const group = grouped.get(type) ?? [];
    if (group.length === 0) {
      lines.push('');
      continue;
    }
    for (const e of group) {
      lines.push(`- [${e.name}](${type}/${e.id}.md) - ${e.description}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Human-readable plaintext dump of the full index. Used as the `content`
 * text returned by tool actions so the LLM sees post-action state even
 * without the renderer.
 */
export function formatText(state: MemoryState): string {
  const { global, project, session } = state.index;
  if (global.length === 0 && project.length === 0 && session.length === 0) return '(no memories saved)';
  const parts: string[] = [];
  if (global.length > 0) {
    parts.push(`Global (${global.length}):`);
    for (const e of global) parts.push(`  [${e.type}] ${e.id} - ${e.name}: ${e.description}`);
  }
  if (project.length > 0) {
    parts.push(`Project${state.projectSlug ? ` ${state.projectSlug}` : ''} (${project.length}):`);
    for (const e of project) parts.push(`  [${e.type}] ${e.id} - ${e.name}: ${e.description}`);
  }
  if (session.length > 0) {
    parts.push(`Session${state.sessionId ? ` ${state.sessionId}` : ''} (${session.length}):`);
    for (const e of session) parts.push(`  [${e.type}] ${e.id} - ${e.name}: ${e.description}`);
  }
  return parts.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Staleness (project-memory age surfacing)
// ──────────────────────────────────────────────────────────────────────

/** Default age (days) past which a `project` memory is flagged stale. */
export const DEFAULT_STALE_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/**
 * Whole-day age of an entry against `now`, derived from its `updated`
 * timestamp (falling back to `created`). Returns `undefined` when the
 * entry carries no usable timestamp or the timestamp is in the future
 * (so a clock skew never reports a negative age). Truncates to days.
 */
export function entryAgeDays(entry: MemoryEntry, now: Date): number | undefined {
  const stamp = entry.updated ?? entry.created;
  if (stamp === undefined) return undefined;
  const ms = Date.parse(stamp);
  if (!Number.isFinite(ms)) return undefined;
  const diff = now.getTime() - ms;
  if (diff < 0) return undefined;
  return Math.floor(diff / MS_PER_DAY);
}

/**
 * Whether an entry should be surfaced as stale: `project`-type only (the
 * fast-decaying type), with a known age at or past `staleDays`. Never
 * marks `user` / `feedback` / `reference` / `note`.
 */
export function isStaleEntry(entry: MemoryEntry, now: Date, staleDays: number): boolean {
  if (entry.type !== 'project') return false;
  const age = entryAgeDays(entry, now);
  return age !== undefined && age >= staleDays;
}

// ──────────────────────────────────────────────────────────────────────
// ActionResult re-exports (parity with scratchpad/todo reducer style)
// ──────────────────────────────────────────────────────────────────────

export type ActionSuccess = GenericActionSuccess<MemoryState>;
export type { ActionError };
export type ActionResult = GenericActionResult<MemoryState>;
