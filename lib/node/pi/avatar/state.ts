/**
 * Pure state-machine helpers for the `avatar` extension.
 *
 * The timer-driven `Animator` lives in the extension shell
 * (`config/pi/extensions/avatar.ts`) because it needs `setTimeout` /
 * the renderer; only the pure decision bits live here so they can be
 * unit-tested.
 */

import type { ActivityState } from './types.ts';

/**
 * Map a tool name to the activity sprite state it should drive. `read`
 * shows the reading state; the write-family tools (`write` / `edit` /
 * `apply_patch`) show the writing state; everything else is the generic
 * `tool` state.
 */
export function toolNameToState(toolName: string): ActivityState {
  switch (toolName) {
    case 'read':
      return 'read';
    case 'write':
    case 'edit':
    case 'apply_patch':
      return 'write';
    default:
      return 'tool';
  }
}

/**
 * Target talk-animation duration (ms) for `wordCount` words at
 * `readingSpeed` words/sec. Returns `0` when `readingSpeed` is
 * non-positive so the caller falls straight through to idle.
 */
export function talkDurationMs(wordCount: number, readingSpeed: number): number {
  if (!Number.isFinite(readingSpeed) || readingSpeed <= 0) return 0;
  return (wordCount / readingSpeed) * 1000;
}

/** Count whitespace-delimited words in `text` (used to pace talk). */
export function countWords(text: string): number {
  let count = 0;
  for (const part of text.split(/\s+/)) {
    if (part.length > 0) count++;
  }
  return count;
}

/**
 * Render a per-session tool-call tally as `name(count)` tokens for the
 * avatar info panel, e.g. `bash(3) read(2) edit(1)`. Sorted by descending
 * count, then name ascending. Zero / negative counts are dropped; an empty
 * tally renders as `no tool calls`.
 */
export function formatToolTally(counts: ReadonlyMap<string, number>): string {
  const entries = [...counts.entries()].filter(([, count]) => count > 0);
  if (entries.length === 0) return 'no tool calls';
  entries.sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0])));
  return entries.map(([name, count]) => `${name}(${count})`).join(' ');
}
