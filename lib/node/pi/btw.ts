/**
 * Pure helpers for config/pi/extensions/btw.ts.
 *
 * `/btw` is a Claude Code–style "side question" command. The user types
 * `/btw <question>` and gets an answer synthesized from whatever the
 * current session already has in scope, without the Q&A being saved to
 * session history and without the side-question call using any tools.
 *
 * This module intentionally has zero dependencies on
 * `@mariozechner/pi-coding-agent` or `@mariozechner/pi-ai` so it can be
 * unit-tested under `vitest` without the pi runtime. The extension file
 * wires these helpers to the live API.
 */

import { trimOrUndefined } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// User-message framing
// ──────────────────────────────────────────────────────────────────────

/**
 * Text prepended to the user's side question before it's sent to the
 * model. Kept short and directive: weaker models behave better when told
 * exactly what mode they're in and what they can't do.
 *
 * Ordering matters — the directive goes at the top of the user message
 * so the model reads it before the question itself. We deliberately do
 * NOT modify the system prompt: changing the prompt's prefix would break
 * prompt-cache hits for this call, which is the main cost lever.
 */
export const SIDE_QUESTION_DIRECTIVE =
  '[Side question — answer concisely using only the context already loaded in this conversation. ' +
  'Do not propose or call tools. This Q&A will not be saved to the session history.]';

/**
 * Build the `content` string for the synthetic user message appended to
 * the end of the branch when answering a side question. The directive
 * goes first, then a blank line, then the user's question. Returns
 * `undefined` when the question is empty after trim — callers should
 * surface a usage message instead of calling the model.
 */
export function buildSideQuestionUserContent(question: string): string | undefined {
  const q = trimOrUndefined(question);
  if (!q) return undefined;
  return `${SIDE_QUESTION_DIRECTIVE}\n\n${q}`;
}

// ──────────────────────────────────────────────────────────────────────
// Model override parsing
// ──────────────────────────────────────────────────────────────────────

export interface ParsedModelSpec {
  provider: string;
  modelId: string;
}

/**
 * Parse a `PI_BTW_MODEL` value of the form `provider/modelId` into its
 * two parts. Returns `undefined` for empty input, missing slash, or an
 * empty provider / modelId. Trims each component so `"anthropic / foo"`
 * still parses.
 *
 * pi's own `--model` flag accepts a richer grammar (globs, fuzzy match,
 * optional `:thinking` suffix); this helper is deliberately strict
 * because PI_BTW_MODEL is for unattended use and ambiguity on a
 * cost-bearing model switch is worse than a clear parse failure.
 */
export function parseModelSpec(spec: string | undefined): ParsedModelSpec | undefined {
  const raw = trimOrUndefined(spec);
  if (!raw) return undefined;
  const slash = raw.indexOf('/');
  if (slash <= 0) return undefined;
  const provider = raw.slice(0, slash).trim();
  const modelId = raw.slice(slash + 1).trim();
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}

// ──────────────────────────────────────────────────────────────────────
// Assistant-message rendering
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal shape of the objects inside an `AssistantMessage.content`
 * array that {@link extractAnswerText} knows how to handle. Declared
 * locally so this module has no dependency on `@mariozechner/pi-ai`.
 * Runtime shape compatibility is what counts — callers can pass the
 * real pi-ai types freely.
 */
export interface AssistantContentPart {
  type: string;
  text?: string;
}

/**
 * Extract the user-visible answer text from an assistant message's
 * content array. Keeps `text` parts, drops `thinking` parts (side
 * questions are answered in one shot; the user only cares about the
 * final answer) and `toolCall` parts (we pass `tools: []` so these
 * shouldn't appear, but if the model emits one anyway we don't want to
 * surface raw JSON).
 *
 * Consecutive text parts are joined with no separator so a model that
 * streams text in several chunks still reads naturally.
 */
export function extractAnswerText(content: readonly AssistantContentPart[] | undefined): string {
  if (!content || content.length === 0) return '';
  const out: string[] = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      out.push(part.text);
    }
  }
  return out.join('').trim();
}

// ──────────────────────────────────────────────────────────────────────
// Footer formatting
// ──────────────────────────────────────────────────────────────────────

export interface BtwFooterStats {
  /** Display name of the model that answered. */
  model: string;
  /** Total tokens consumed by the side-question call. */
  totalTokens?: number;
  /** Cache-read tokens — helps confirm prompt caching engaged. */
  cacheReadTokens?: number;
  /** Output tokens emitted by the model. */
  outputTokens?: number;
  /** Total USD cost for this call. */
  costUsd?: number;
  /** Wall-clock duration of the call, in milliseconds. */
  durationMs?: number;
}

/**
 * Format a token count the way the statusline does: `1.2k`, `45k`,
 * `1.23M`. Small values render as bare integers. Kept here (rather than
 * imported from the statusline extension) so this module stays pi-free
 * for unit testing.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Format a millisecond duration as `450ms`, `1.2s`, or `34s`. Kept in
 * the same compact style as `formatTokens` so the footer reads like a
 * single coherent line.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * One-line footer rendered under the side-question answer. Shows just
 * enough for the user to verify (a) which model actually answered, (b)
 * whether prompt caching engaged, (c) how much this little question
 * cost them. Missing fields are silently omitted so the line stays
 * compact.
 */
export function formatFooter(stats: BtwFooterStats): string {
  const parts: string[] = [`model: ${stats.model}`];
  if (typeof stats.totalTokens === 'number' && Number.isFinite(stats.totalTokens)) {
    parts.push(`${formatTokens(stats.totalTokens)} tokens`);
  }
  if (
    typeof stats.cacheReadTokens === 'number' &&
    Number.isFinite(stats.cacheReadTokens) &&
    stats.cacheReadTokens > 0
  ) {
    parts.push(`${formatTokens(stats.cacheReadTokens)} cached`);
  }
  if (typeof stats.outputTokens === 'number' && Number.isFinite(stats.outputTokens)) {
    parts.push(`${formatTokens(stats.outputTokens)} out`);
  }
  if (typeof stats.costUsd === 'number' && Number.isFinite(stats.costUsd) && stats.costUsd > 0) {
    parts.push(`$${stats.costUsd.toFixed(4)}`);
  }
  if (typeof stats.durationMs === 'number' && Number.isFinite(stats.durationMs) && stats.durationMs >= 0) {
    parts.push(formatDuration(stats.durationMs));
  }
  parts.push('ephemeral');
  return `[${parts.join(' · ')}]`;
}

// ──────────────────────────────────────────────────────────────────────
// Usage / help text
// ──────────────────────────────────────────────────────────────────────

/**
 * Help text shown when the user runs `/btw` with no arguments. Kept
 * here so the extension and any future reuse (e.g. a docs-generation
 * script) share the same wording.
 */
export const BTW_USAGE = [
  'Usage: /btw <question>',
  '',
  "Ask a side question about this session's context without saving the Q&A to history",
  'and without letting the model call tools. Inherits the current model, system prompt,',
  'and conversation — so prompt caching from the main turn reuses.',
  '',
  'Example:',
  '  /btw what file did we edit three turns ago?',
  '  /btw summarize the plan so far in two bullets',
].join('\n');
