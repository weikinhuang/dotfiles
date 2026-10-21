/**
 * Result extraction for the subagent extension.
 *
 * Pure module - no pi imports - so it can be unit-tested under `vitest`.
 * Mirrors the "content-part shape" approach in `btw.ts`: declares a
 * minimal local interface for `AssistantMessage.content[]` parts so this
 * module has no runtime dependency on `@earendil-works/pi-ai`.
 *
 * The final assistant text is what the parent LLM actually sees. Every
 * tool call, every thinking block, every intermediate user/tool result
 * is stripped out - that context stays in the child session file for
 * later auditing but never pollutes the parent.
 */

import { extractAssistantMessageText } from '../message-extract.ts';
import { trimOrUndefined } from '../shared/strings.ts';

export type StopReason = 'completed' | 'max_turns' | 'aborted' | 'error';

export interface AssistantContentPart {
  type: string;
  /** Text parts carry the user-visible answer. */
  text?: string;
}

export interface AssistantMessageLike {
  role: 'assistant';
  content?: readonly AssistantContentPart[];
}

export interface AgentMessageLike {
  /** May be `user`, `assistant`, `toolResult`, `custom`, … - we only inspect `assistant`. */
  role: string;
  content?: readonly AssistantContentPart[];
}

/**
 * Scan `messages` from the back to find the last assistant message with
 * at least one `text` content part, and return the concatenated text.
 * Returns an empty string when the child never emitted a final answer
 * (tool-call-only termination, aborted before first message, etc.).
 *
 * Consecutive text parts are joined with no separator so models that
 * stream text in chunks still read naturally (same as `btw.ts`).
 */
export function extractFinalAssistantText(messages: readonly AgentMessageLike[] | undefined): string {
  if (!messages || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.content) continue;
    const text = extractAssistantMessageText(m, { joiner: '', trim: true });
    if (text.length > 0) return text;
  }
  return '';
}

export interface ClassifyStopReasonInput {
  /** The child's turn counter exceeded `maxTurns`. */
  reachedMaxTurns?: boolean;
  /** The parent's abort signal fired, or the per-call timeout tripped. */
  aborted?: boolean;
  /** Child threw or returned an error. */
  error?: boolean;
}

/**
 * Pick the most specific stop reason, with precedence:
 *   max_turns > aborted > error > completed
 *
 * `max_turns` outranks `aborted` because we synthesize the abort signal
 * on purpose when we hit the cap, and users want to see that
 * distinction in the tool result details.
 */
export function classifyStopReason(input: ClassifyStopReasonInput): StopReason {
  if (input.reachedMaxTurns) return 'max_turns';
  if (input.aborted) return 'aborted';
  if (input.error) return 'error';
  return 'completed';
}

export interface ResolveFinalTextInput {
  stopReason: StopReason;
  /** The extracted final assistant text (may be empty). */
  finalText: string;
  /** Agent name, for the synthesized fallback messages. */
  agent: string;
  /** Turn cap, surfaced in the `max_turns` fallback line. */
  maxTurns: number;
  /** Error aggregated from the child's `message_end` errorMessage events. */
  errorFromChild?: string;
  /** Message from a thrown child error (drive()'s catch), if any. */
  childErrorMessage?: string;
}

/**
 * Resolve the parent-visible answer text for a finished child run. When
 * the child produced a non-empty final assistant answer we return it
 * verbatim; otherwise we synthesize a terminal-state fallback so the
 * parent always gets a readable line for an `error` / `max_turns` /
 * `aborted` run that never emitted a final answer. A `completed` run with
 * empty text stays empty - the caller decides what to show.
 */
export function resolveFinalText(input: ResolveFinalTextInput): string {
  const { stopReason, finalText, agent, maxTurns, errorFromChild, childErrorMessage } = input;
  if (finalText.length > 0) return finalText;
  if (stopReason === 'error') {
    return `subagent ${agent}: ${errorFromChild ?? childErrorMessage ?? 'child session errored'}`;
  }
  if (stopReason === 'max_turns') {
    return `subagent ${agent} exhausted its ${maxTurns}-turn budget without producing a final answer.`;
  }
  if (stopReason === 'aborted') {
    return `subagent ${agent} was aborted.`;
  }
  return finalText;
}

export interface StopSummaryInput {
  agent: string;
  stopReason: StopReason;
  /** The wall-clock timer (not the parent) stopped the child. */
  timedOut?: boolean;
  /** Effective wall-clock cap, used in the timeout headline. */
  timeoutMs?: number;
  durationMs: number;
  turns: number;
  maxTurns: number;
  /** Files the child tried to write (see `touched-files.ts`). */
  touchedFiles: readonly string[];
  /** Child error text for `error` stops. */
  errorMessage?: string;
}

function fmtSeconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function fmtTurns(turns: number): string {
  return `${turns} turn${turns === 1 ? '' : 's'}`;
}

/**
 * Headline + touched-file list for a run that did NOT complete normally.
 * Returns `undefined` for `completed`. The first line always states why
 * the child stopped, so the parent never mistakes the child's last
 * (mid-task) assistant message for an answer or an error string.
 */
export function formatStopSummary(input: StopSummaryInput): string | undefined {
  const { agent, stopReason, timedOut, timeoutMs, durationMs, turns, maxTurns, touchedFiles, errorMessage } = input;
  if (stopReason === 'completed') return undefined;
  const name = `subagent "${agent}"`;
  let headline: string;
  if (stopReason === 'aborted' && timedOut) {
    headline = `${name} timed out after ${fmtSeconds(timeoutMs ?? durationMs)} (${fmtTurns(turns)})`;
  } else if (stopReason === 'max_turns') {
    headline = `${name} hit its ${maxTurns}-turn limit after ${fmtSeconds(durationMs)} (${fmtTurns(turns)})`;
  } else if (stopReason === 'aborted') {
    headline = `${name} was aborted after ${fmtSeconds(durationMs)} (${fmtTurns(turns)})`;
  } else {
    const why = trimOrUndefined(errorMessage) ?? 'child session errored';
    headline = `${name} failed after ${fmtSeconds(durationMs)} (${fmtTurns(turns)}): ${why}`;
  }
  if (touchedFiles.length === 0) {
    return `${headline}; no write/edit/apply_patch calls were recorded (bash commands may still have changed files).`;
  }
  return [`${headline}; partial changes may be on disk:`, ...touchedFiles.map((p) => `- ${p}`)].join('\n');
}

/**
 * Parent-visible text for a finished child run. A `completed` run returns
 * the child's final answer verbatim. Any other stop leads with
 * {@link formatStopSummary} and keeps the child's last assistant text as a
 * trailing `Last message:` section instead of the headline.
 */
export function formatRunResultText(input: StopSummaryInput & { finalText: string }): string {
  const summary = formatStopSummary(input);
  if (summary === undefined) return input.finalText;
  const last = input.finalText.trim();
  return last.length > 0 ? `${summary}\n\nLast message:\n${last}` : summary;
}
