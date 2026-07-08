/**
 * Pure resolver for the session's live thinking level: walk a session
 * branch backwards and return the most recent `thinking_level_change`
 * level, normalized to a {@link Level}.
 *
 * The shell owns the pi call (`ctx.sessionManager.getBranch()`) and its
 * try/catch; this module works on plain branch entries so it stays pi-free
 * and unit-testable.
 */

import { LEVELS, type Level } from './types.ts';

/** The subset of a session branch entry this resolver reads. */
export interface ThinkingBranchEntry {
  type?: string;
  thinkingLevel?: string;
}

/**
 * Return the live thinking level from `branch` - the last
 * `thinking_level_change` entry - or `undefined` when there is none or its
 * level is not a recognized {@link Level}. `xhigh` is clamped to `high`,
 * mirroring pi-ai's own pre-request clamp.
 */
export function resolveThinkingLevel(branch: readonly ThinkingBranchEntry[]): Level | undefined {
  // Walk the active branch backwards; the last `thinking_level_change` entry
  // is the live level. If there's none, pi hasn't recorded one yet for this
  // session, so we bail out (caller will skip injection).
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === 'thinking_level_change') {
      const lvl = entry.thinkingLevel;
      if (typeof lvl !== 'string') return undefined;
      // pi-ai clamps "xhigh" to "high" before request build, so mirror that here.
      const normalized = lvl === 'xhigh' ? 'high' : lvl;
      return (LEVELS as readonly string[]).includes(normalized) ? (normalized as Level) : undefined;
    }
  }
  return undefined;
}
