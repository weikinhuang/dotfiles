/**
 * User-message framing helpers for `/btw` (Claude-Code-style "side
 * question") - the directive prepended to the question, the help text
 * shown when `/btw` is invoked with no arguments, and the builder that
 * stitches the directive + question into the synthetic user message
 * pi appends to the branch.
 *
 * Pure module - no `@earendil-works/*` imports - so it stays
 * unit-testable under vitest. The extension shell wires this to the
 * live API.
 */

import { trimOrUndefined } from '../shared.ts';

/**
 * Text prepended to the user's side question before it's sent to the
 * model. Kept short and directive: weaker models behave better when told
 * exactly what mode they're in and what they can't do.
 *
 * Ordering matters - the directive goes at the top of the user message
 * so the model reads it before the question itself. We deliberately do
 * NOT modify the system prompt: changing the prompt's prefix would break
 * prompt-cache hits for this call, which is the main cost lever.
 */
export const SIDE_QUESTION_DIRECTIVE =
  '[Side question - answer concisely using only the context already loaded in this conversation. ' +
  'Do not propose or call tools. This Q&A will not be saved to the session history.]';

/**
 * Build the `content` string for the synthetic user message appended to
 * the end of the branch when answering a side question. The directive
 * goes first, then a blank line, then the user's question. Returns
 * `undefined` when the question is empty after trim - callers should
 * surface a usage message instead of calling the model.
 */
export function buildSideQuestionUserContent(question: string): string | undefined {
  const q = trimOrUndefined(question);
  if (!q) return undefined;
  return `${SIDE_QUESTION_DIRECTIVE}\n\n${q}`;
}

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
  'and conversation - so prompt caching from the main turn reuses.',
  '',
  'Example:',
  '  /btw what file did we edit three turns ago?',
  '  /btw summarize the plan so far in two bullets',
].join('\n');
