/**
 * Prompt template variables for the scheduled-prompts extension.
 *
 * At fire time a schedule's chosen prompt is run through `renderPrompt`,
 * which substitutes `${...}` tokens so a nudge can reference how long it
 * has been quiet or the current time. Supported tokens:
 *
 *   ${t}  elapsed time since the anchor, formatted like `15s` / `2m` /
 *         `1h30m`. The anchor is the previous run for recurring/once
 *         schedules, or the last interactive user message for `after`.
 *   ${d}  current local date and time.
 *
 * Unknown tokens are left untouched, so a prompt that legitimately
 * contains `${foo}` passes through unchanged. Pure module - no pi
 * imports - so it is directly unit-testable.
 */

import { formatDuration } from './duration.ts';

export interface PromptContext {
  /** Current time (epoch ms), used for `${d}`. */
  now: number;
  /** Elapsed span (ms) to render for `${t}`; undefined renders `0s`. */
  elapsedMs?: number;
}

const TOKEN_RE = /\$\{(\w+)\}/g;

/** Substitute `${t}` / `${d}` in `text`; leave unknown tokens as-is. */
export function renderPrompt(text: string, ctx: PromptContext): string {
  return text.replace(TOKEN_RE, (whole: string, key: string): string => {
    switch (key) {
      case 't':
        return ctx.elapsedMs === undefined ? '0s' : formatDuration(ctx.elapsedMs);
      case 'd':
        return new Date(ctx.now).toLocaleString();
      default:
        return whole;
    }
  });
}
