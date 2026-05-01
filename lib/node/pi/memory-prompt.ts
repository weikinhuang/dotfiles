/**
 * System-prompt renderer for the memory extension.
 *
 * No pi imports — testable under `vitest`.
 *
 * Every turn the extension injects the `MEMORY.md` indices (global +
 * project) under a `## Memory` header so the model can see what's
 * durable-state-available without a tool call. Full memory bodies are
 * fetched on demand via `memory read <id>`; we only inject the
 * one-line-per-memory index here.
 *
 * A soft character cap protects the system prompt — once the cap is
 * reached we emit a trailer pointing at the tool. The cap is a budget,
 * not a hard limit: each rendered entry fits whole; we stop adding
 * entries once the next one would blow the budget.
 */

import { type MemoryEntry, type MemoryState, MEMORY_TYPES, type MemoryType } from './memory-reducer.ts';

export interface FormatOptions {
  /**
   * Soft cap on the rendered body in characters. The trailer telling
   * the model how to fetch more is appended beyond this cap, so the
   * final block can exceed it slightly. Default 3000.
   */
  maxChars?: number;
}

function groupByType(entries: readonly MemoryEntry[]): Map<MemoryType, MemoryEntry[]> {
  const out = new Map<MemoryType, MemoryEntry[]>();
  for (const t of MEMORY_TYPES) out.set(t, []);
  for (const e of entries) out.get(e.type)?.push(e);
  return out;
}

function renderScope(
  label: string,
  entries: readonly MemoryEntry[],
  validTypes: readonly MemoryType[],
  budget: number,
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
      const line = `- ${e.name} (\`${e.id}\`) — ${e.description}`;
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
    // No content at all — drop the header.
    return { lines: [], used: 0, skipped, truncated };
  }
  lines.push('');
  return { lines, used, skipped, truncated };
}

/**
 * Build the `## Memory` block injected into the system prompt each turn.
 * Returns `null` when both scopes are empty so the caller can skip
 * injection — no point reserving tokens for nothing.
 */
export function formatMemoryIndex(state: MemoryState, opts: FormatOptions = {}): string | null {
  const globalEntries = state.index.global;
  const projectEntries = state.index.project;
  if (globalEntries.length === 0 && projectEntries.length === 0) return null;
  const cap = Math.max(500, opts.maxChars ?? 3000);

  const lines: string[] = ['## Memory', ''];
  let used = lines.join('\n').length;
  let totalSkipped = 0;
  let truncated = false;

  if (globalEntries.length > 0) {
    const r = renderScope('Global', globalEntries, ['user', 'feedback'], cap - used);
    if (r.lines.length > 0) {
      lines.push(...r.lines);
      used += r.used;
    }
    totalSkipped += r.skipped;
    truncated = truncated || r.truncated;
  }

  if (projectEntries.length > 0) {
    const label = state.projectSlug ? `Project (${state.projectSlug})` : 'Project';
    const r = renderScope(label, projectEntries, ['user', 'feedback', 'project', 'reference'], cap - used);
    if (r.lines.length > 0) {
      lines.push(...r.lines);
      used += r.used;
    }
    totalSkipped += r.skipped;
    truncated = truncated || r.truncated;
  }

  if (truncated) {
    lines.push(`(${totalSkipped} more memory entry(ies) not shown — call \`memory\` with action \`list\` to see all.)`);
  } else {
    lines.push(
      'Call `memory` with action `read` + the id in backticks to load full content, `save` to persist new durable notes, `update` / `remove` to keep the index accurate.',
    );
  }

  return lines.join('\n').trimEnd();
}
