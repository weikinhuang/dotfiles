/**
 * Pure helpers for rendering the scratchpad as a system-prompt block.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * The extension injects the rendered block into every turn's system prompt
 * via `before_agent_start`, under a `## Working Notes` header. When there
 * are no notes we return `null` so the extension can skip injection entirely
 * and keep casual single-turn chats uncluttered.
 *
 * Notes are grouped by heading (in first-seen order) and rendered as
 * bulleted lists. Notes without a heading are rendered first, under an
 * implicit "Notes" header, so the model always sees them even in a mixed
 * notebook.
 *
 * A soft character cap protects the system prompt from runaway notebooks:
 * once the cap is reached we emit a trailer pointing the model at the
 * `scratchpad` tool with action `list` to see the rest. The cap is a
 * budget, not a hard limit - each rendered note fits whole; we stop
 * adding notes once the next one would blow the budget.
 */

import { type ScratchNote, type ScratchpadState } from './scratchpad-reducer.ts';

export interface FormatOptions {
  /**
   * Soft cap on the rendered body in characters. The trailer telling the
   * model how to see the rest is appended beyond this cap, so the final
   * block can exceed it slightly. Default 2000.
   */
  maxChars?: number;
}

/**
 * Group notes by their heading in the order the heading first appears.
 * Notes without a heading are lumped under a synthetic `''` key that
 * renders as the default "Notes" section.
 */
function groupByHeading(notes: readonly ScratchNote[]): [string, ScratchNote[]][] {
  const seen = new Map<string, ScratchNote[]>();
  for (const n of notes) {
    const key = n.heading ?? '';
    let group = seen.get(key);
    if (!group) {
      group = [];
      seen.set(key, group);
    }
    group.push(n);
  }
  return Array.from(seen.entries());
}

/**
 * Build the "## Working Notes" block injected into the system prompt
 * every turn. Returns `null` when the scratchpad is empty so the caller
 * can skip injection - no point reserving tokens for nothing.
 */
export function formatWorkingNotes(state: ScratchpadState, opts: FormatOptions = {}): string | null {
  if (state.notes.length === 0) return null;
  const cap = Math.max(200, opts.maxChars ?? 2000);

  const lines: string[] = ['## Working Notes', ''];
  const groups = groupByHeading(state.notes);

  let used = lines.join('\n').length;
  let truncated = false;
  let rendered = 0;
  let skipped = 0;

  for (const [heading, notes] of groups) {
    const headingLine = heading ? `**${heading}**` : '**Notes**';
    // Reserve budget for the heading + blank trailing line before bailing.
    if (used + headingLine.length + 2 > cap && rendered > 0) {
      truncated = true;
      skipped += notes.length;
      continue;
    }
    lines.push(headingLine);
    used += headingLine.length + 1;

    for (const n of notes) {
      const line = `  - #${n.id} ${n.body}`;
      // Keep the trailer tiny and stop adding notes once the next one
      // would overflow. We always render at least one note total so a
      // very tight cap still produces a meaningful block.
      if (used + line.length + 1 > cap && rendered > 0) {
        truncated = true;
        skipped++;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
      rendered++;
    }
    lines.push('');
    used += 1;
  }

  if (truncated) {
    lines.push(`(${skipped} more note(s) not shown - call \`scratchpad\` with action \`list\` to see all.)`);
  } else {
    lines.push(
      'Keep these notes accurate with the `scratchpad` tool (`append`, `update`, `remove`, `clear`). Use it for decisions, file paths, test commands, and any other state that should survive compaction.',
    );
  }

  return lines.join('\n');
}
