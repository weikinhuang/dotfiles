/**
 * System-prompt renderer for the memory extension.
 *
 * No pi imports - testable under `vitest`.
 *
 * Every turn the extension injects the `MEMORY.md` indices (global +
 * project + the current session) under a `## Memory` header so the model
 * can see what's available without a tool call. Full memory bodies are
 * fetched on demand via `memory read <id>`; we only inject the
 * one-line-per-memory index here.
 *
 * A soft character cap protects the system prompt - once the cap is
 * reached we emit a trailer pointing at the tool. The cap is a budget,
 * not a hard limit: each rendered entry fits whole; we stop adding
 * entries once the next one would blow the budget.
 */

import {
  DEFAULT_STALE_DAYS,
  entryAgeDays,
  groupByType,
  isStaleEntry,
  type MemoryEntry,
  type MemoryState,
  type MemoryType,
} from './memory-reducer.ts';

export interface FormatOptions {
  /**
   * Soft cap on the rendered body in characters. The trailer telling
   * the model how to fetch more is appended beyond this cap, so the
   * final block can exceed it slightly. Default 3000.
   */
  maxChars?: number;
  /**
   * Clock used to compute entry age for the stale marker. Injected so
   * tests are deterministic; the extension passes the real `new Date()`.
   * Defaults to now.
   */
  now?: Date;
  /**
   * Age (days) past which a `project` entry gets a tiny `(Nd)` age
   * marker. Defaults to {@link DEFAULT_STALE_DAYS}.
   */
  staleDays?: number;
}

/**
 * Tiny age suffix for a stale `project` entry, e.g. ` (45d)`. Empty
 * string for fresh / non-project / undated entries so it costs nothing.
 */
function staleSuffix(entry: MemoryEntry, now: Date, staleDays: number): string {
  if (!isStaleEntry(entry, now, staleDays)) return '';
  const age = entryAgeDays(entry, now);
  return age === undefined ? '' : ` (${age}d)`;
}

function renderScope(
  label: string,
  entries: readonly MemoryEntry[],
  validTypes: readonly MemoryType[],
  budget: number,
  now: Date,
  staleDays: number,
): { lines: string[]; used: number; skipped: number; truncated: boolean } {
  const lines: string[] = [`### ${label}`];
  let used = lines[0].length + 1;
  let skipped = 0;
  let truncated = false;

  const grouped = groupByType(entries);
  for (const type of validTypes) {
    const group = grouped.get(type) ?? [];
    if (group.length === 0) continue;
    const heading = `**${type}**`;
    // Reserve budget for heading + one entry before bailing.
    if (used + heading.length + 2 > budget && lines.length > 1) {
      truncated = true;
      skipped += group.length;
      continue;
    }
    lines.push(heading);
    used += heading.length + 1;
    for (const e of group) {
      const line = `- ${e.name} (\`${e.id}\`) - ${e.description}${staleSuffix(e, now, staleDays)}`;
      if (used + line.length + 1 > budget && lines.length > 2) {
        truncated = true;
        skipped++;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
  }
  if (lines.length === 1) {
    // No content at all - drop the header.
    return { lines: [], used: 0, skipped, truncated };
  }
  lines.push('');
  return { lines, used, skipped, truncated };
}

/**
 * Build the `## Memory` block injected into the system prompt each turn.
 * Returns `null` when both scopes are empty so the caller can skip
 * injection - no point reserving tokens for nothing.
 *
 * Budget vs display order are decoupled. The `maxChars` budget is
 * consumed in *priority* order - session -> project -> global - so when
 * the cap is tight the scopes most relevant to the current turn survive
 * and stable cross-project global entries are the first to be truncated.
 * The rendered sections are then re-assembled into reader-friendly
 * *display* order (global -> project -> session) for the final block.
 */
export function formatMemoryIndex(state: MemoryState, opts: FormatOptions = {}): string | null {
  const globalEntries = state.index.global;
  const projectEntries = state.index.project;
  const sessionEntries = state.index.session;
  if (globalEntries.length === 0 && projectEntries.length === 0 && sessionEntries.length === 0) return null;
  const cap = Math.max(500, opts.maxChars ?? 3000);
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;

  const header: string[] = ['## Memory', ''];
  let used = header.join('\n').length;
  let totalSkipped = 0;
  let truncated = false;

  // Hold each scope's rendered lines so we can render in priority order
  // (for budget consumption) but emit in display order below.
  let globalLines: string[] = [];
  let projectLines: string[] = [];
  let sessionLines: string[] = [];

  const renderInto = (entries: readonly MemoryEntry[], label: string, validTypes: readonly MemoryType[]): string[] => {
    if (entries.length === 0) return [];
    const r = renderScope(label, entries, validTypes, cap - used, now, staleDays);
    if (r.lines.length > 0) used += r.used;
    totalSkipped += r.skipped;
    truncated = truncated || r.truncated;
    return r.lines;
  };

  // Budget-consumption order: session -> project -> global.
  if (sessionEntries.length > 0) {
    const label = state.sessionId ? `Session (${state.sessionId})` : 'Session';
    sessionLines = renderInto(sessionEntries, label, ['note']);
  }
  if (projectEntries.length > 0) {
    const label = state.projectSlug ? `Project (${state.projectSlug})` : 'Project';
    projectLines = renderInto(projectEntries, label, ['user', 'feedback', 'project', 'reference']);
  }
  globalLines = renderInto(globalEntries, 'Global', ['user', 'feedback']);

  // Display order: global -> project -> session.
  const lines: string[] = [...header, ...globalLines, ...projectLines, ...sessionLines];

  if (truncated) {
    lines.push(`(${totalSkipped} more memory entry(ies) not shown - call \`memory\` with action \`list\` to see all.)`);
  } else {
    lines.push(
      'Call `memory` with action `read` + the id in backticks to load full content, `save` to persist new durable notes, `update` / `remove` to keep the index accurate.',
    );
  }

  return lines.join('\n').trimEnd();
}
