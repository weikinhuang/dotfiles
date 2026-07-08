/**
 * Pure front-end of the sandbox `tool_result` pipeline.
 *
 * The `tool_result` hook in `config/pi/extensions/sandbox.ts` starts
 * by recovering two plain values off pi's bash tool-result event: the
 * command that ran (preferring the pre-wrap original stashed on
 * `event.input`, falling back to the rewritten `command`) and the
 * stderr text (from the structured `result.stderr`, falling back to
 * the first text content block). Both are pure lookups over the event
 * shape, so they live here and feed the already-extracted annotators
 * (`result-annotate.ts`, `fs-failures.ts`, `loopback-hint.ts`).
 *
 * Pure module - no pi imports. Reuses {@link readOriginalStash} for
 * the symbol-keyed original-command stash.
 */

import { readOriginalStash } from './markers.ts';

/** Structural slice of pi's bash `tool_result` event this module reads. */
export interface BashResultEventShape {
  content?: { type: string; text?: string }[];
  result?: { stderr?: unknown; output?: unknown };
}

/**
 * Resolve the command a bash `tool_result` corresponds to. Prefers the
 * pre-wrap original stashed on `event.input` (so audit rows and the
 * fs-ask dialog show what the user actually typed rather than the
 * `srt -- …` rewrite); falls back to the rewritten `command` string;
 * returns `''` when neither is present.
 */
export function resolveSandboxedCommand(input: unknown): string {
  const original = readOriginalStash(input);
  if (original !== undefined) return original;
  if (input !== null && typeof input === 'object') {
    const command = (input as { command?: unknown }).command;
    if (typeof command === 'string') return command;
  }
  return '';
}

/**
 * Extract the stderr text from a bash `tool_result` event. Prefers the
 * structured `result.stderr` string; falls back to the first text
 * content block; returns `''` when neither is a string. pi's bash tool
 * returns content as `[{ type: 'text', text: ... }]` with stdout +
 * stderr + a trailing tail marker, so the text block is the only
 * stderr signal on platforms that don't populate `result.stderr`.
 */
export function extractBashStderr(evt: BashResultEventShape): string {
  if (typeof evt.result?.stderr === 'string') return evt.result.stderr;
  const firstText = evt.content?.find((c) => c.type === 'text');
  if (typeof firstText?.text === 'string') return firstText.text;
  return '';
}
