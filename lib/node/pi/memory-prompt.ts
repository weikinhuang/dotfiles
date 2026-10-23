/**
 * Index renderer for the memory extension's `memory-index` reminder.
 *
 * No pi imports - testable under `vitest`.
 *
 * Renders the one-line-per-memory index (global + project + the current
 * session) under a `## Memory` header so the model can see what's available
 * without a tool call. Full bodies are fetched on demand via `memory read`.
 * The extension emits this full block only when the model has no delivered
 * baseline (see `memory/delivery.ts`); later runs carry a small delta.
 *
 * A soft character cap bounds the block. The budget is spent in *priority*
 * order - behavioural types first (`feedback`, `user`), then `note`,
 * `reference`, `project`; within a type the more specific scope wins
 * (session, project, global) - so corrections are the last thing dropped.
 * Selected entries are then rendered in reader-friendly *display* order
 * (global -> project -> session, types in scope order).
 */

import {
  DEFAULT_STALE_DAYS,
  entryAgeDays,
  isStaleEntry,
  type MemoryEntry,
  type MemoryScope,
  type MemoryState,
  type MemoryType,
  validTypesForScope,
} from './memory-reducer.ts';
import { slugifyAscii } from './slugify.ts';

/** Default soft cap (chars). The full index is emitted rarely, so it can be generous. */
export const DEFAULT_MAX_INDEX_CHARS = 6000;
/** Lowest accepted cap; smaller values are clamped up. */
export const MIN_INDEX_CHARS = 500;

export interface FormatOptions {
  /**
   * Soft cap on the rendered body in characters. The trailer telling the
   * model how to fetch more is appended beyond this cap, so the final block
   * can exceed it slightly. Default {@link DEFAULT_MAX_INDEX_CHARS}.
   */
  maxChars?: number;
  /** Clock for the stale marker. Injected so tests are deterministic. */
  now?: Date;
  /** Age (days) past which a `project` entry gets a `(Nd)` marker. */
  staleDays?: number;
}

/** Budget priority: lower spends first. Behavioural rules survive a tight cap. */
const TYPE_PRIORITY: Record<MemoryType, number> = { feedback: 0, user: 1, note: 2, reference: 3, project: 4 };
const SCOPE_PRIORITY: Record<MemoryScope, number> = { session: 0, project: 1, global: 2 };
const DISPLAY_SCOPES: readonly MemoryScope[] = ['global', 'project', 'session'];

function staleSuffix(entry: MemoryEntry, now: Date, staleDays: number): string {
  if (!isStaleEntry(entry, now, staleDays)) return '';
  const age = entryAgeDays(entry, now);
  return age === undefined ? '' : ` (${age}d)`;
}

/**
 * One index line. The human name is omitted when it is just the slug's
 * source (the id already says it), which saves a large share of the budget.
 */
export function formatIndexLine(entry: MemoryEntry, now: Date, staleDays: number): string {
  const redundantName = slugifyAscii(entry.name, { fallback: 'memory' }) === entry.id;
  const label = redundantName ? `\`${entry.id}\`` : `${entry.name} (\`${entry.id}\`)`;
  return `- ${label} - ${entry.description}${staleSuffix(entry, now, staleDays)}`;
}

function scopeLabel(scope: MemoryScope, state: MemoryState): string {
  if (scope === 'global') return 'Global';
  if (scope === 'project') return state.projectSlug ? `Project (${state.projectSlug})` : 'Project';
  return state.sessionId ? `Session (${state.sessionId})` : 'Session';
}

const typeHeading = (type: MemoryType): string => `**${type}**`;

/**
 * Build the `## Memory` block and report how many entries the cap left out,
 * so delivery can tell a complete index from a truncated one. Returns `null`
 * when every scope is empty so the caller can skip the reminder.
 */
export function renderMemoryIndex(
  state: MemoryState,
  opts: FormatOptions = {},
): { body: string; skipped: number } | null {
  const byScope: Record<MemoryScope, readonly MemoryEntry[]> = {
    global: state.index.global,
    project: state.index.project,
    session: state.index.session,
  };
  const total = byScope.global.length + byScope.project.length + byScope.session.length;
  if (total === 0) return null;
  const cap = Math.max(MIN_INDEX_CHARS, opts.maxChars ?? DEFAULT_MAX_INDEX_CHARS);
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;

  // Priority-ordered candidates with their rendered line.
  const candidates = DISPLAY_SCOPES.flatMap((scope) =>
    byScope[scope].map((entry, order) => ({ entry, order, line: formatIndexLine(entry, now, staleDays) })),
  ).sort(
    (a, b) =>
      TYPE_PRIORITY[a.entry.type] - TYPE_PRIORITY[b.entry.type] ||
      SCOPE_PRIORITY[a.entry.scope] - SCOPE_PRIORITY[b.entry.scope] ||
      a.order - b.order,
  );

  let used = '## Memory\n\n'.length;
  const openScopes = new Set<MemoryScope>();
  const openGroups = new Set<string>();
  const selected = new Set<MemoryEntry>();
  for (const c of candidates) {
    const { scope, type } = c.entry;
    const group = `${scope}/${type}`;
    let cost = c.line.length + 1;
    if (!openScopes.has(scope)) cost += `### ${scopeLabel(scope, state)}`.length + 2;
    if (!openGroups.has(group)) cost += typeHeading(type).length + 1;
    // Always admit the first entry so a tiny cap still shows something.
    if (selected.size > 0 && used + cost > cap) continue;
    used += cost;
    openScopes.add(scope);
    openGroups.add(group);
    selected.add(c.entry);
  }

  const lines: string[] = ['## Memory', ''];
  for (const scope of DISPLAY_SCOPES) {
    const entries = byScope[scope].filter((e) => selected.has(e));
    if (entries.length === 0) continue;
    lines.push(`### ${scopeLabel(scope, state)}`);
    for (const type of validTypesForScope(scope)) {
      const group = entries.filter((e) => e.type === type);
      if (group.length === 0) continue;
      lines.push(typeHeading(type));
      for (const e of group) lines.push(formatIndexLine(e, now, staleDays));
    }
    lines.push('');
  }

  const skipped = total - selected.size;
  if (skipped > 0) {
    lines.push(`(${skipped} more memory entry(ies) not shown - call \`memory\` with action \`list\` to see all.)`);
  } else {
    lines.push(
      'Call `memory` with action `read` + the id in backticks to load full content, `save` to persist new durable notes, `update` / `remove` to keep the index accurate.',
    );
  }
  return { body: lines.join('\n').trimEnd(), skipped };
}

/** The `## Memory` block alone ({@link renderMemoryIndex} without the skip count). */
export function formatMemoryIndex(state: MemoryState, opts: FormatOptions = {}): string | null {
  return renderMemoryIndex(state, opts)?.body ?? null;
}
