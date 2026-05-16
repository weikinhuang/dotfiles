/**
 * Pure helpers used by the todo extension's weak-model guardrails.
 *
 *   - `formatActivePlan`: renders the currently-active + pending + blocked
 *     todos as a compact Markdown block for injection into the system
 *     prompt via `before_agent_start`. Returns `null` when there's nothing
 *     worth saying so the extension can skip injection entirely and keep
 *     casual single-turn chats uncluttered.
 *
 *   - `looksLikeCompletionClaim`: best-effort heuristic for "the assistant
 *     just signed off as done". Used by `agent_end` to decide whether to
 *     fire the follow-up steer when `in_progress` / `pending` todos are
 *     still open. Intentionally loose - false positives merely produce a
 *     nudge, false negatives silently skip the guardrail.
 *
 * Both are covered by unit tests.
 */

import { type Todo, type TodoState } from './todo-reducer.ts';

export interface FormatOptions {
  /** Cap on the number of `pending` items rendered. Default 10. */
  maxItems?: number;
}

/**
 * Build the "# Active plan" block injected into the system prompt every
 * turn. Order is:
 *   1. in_progress (focus)
 *   2. pending (queue)
 *   3. blocked (surface unresolved obstacles)
 *
 * Returns `null` when state contains nothing but `completed` items (or is
 * empty) so the caller can skip the injection - no point nagging the
 * model about a finished plan.
 */
export function formatActivePlan(state: TodoState, opts: FormatOptions = {}): string | null {
  const max = Math.max(1, opts.maxItems ?? 10);
  const inProgress = state.todos.filter((t) => t.status === 'in_progress');
  const review = state.todos.filter((t) => t.status === 'review');
  const pending = state.todos.filter((t) => t.status === 'pending');
  const blocked = state.todos.filter((t) => t.status === 'blocked');

  if (inProgress.length === 0 && review.length === 0 && pending.length === 0 && blocked.length === 0) {
    return null;
  }

  const render = (t: Todo): string => {
    const note = t.note ? `  (${t.note})` : '';
    return `#${t.id} ${t.text}${note}`;
  };

  const lines: string[] = ['# Active plan', ''];

  if (inProgress.length > 0) {
    lines.push('In progress:');
    for (const t of inProgress) lines.push(`  → ${render(t)}`);
    lines.push('');
  }

  if (review.length > 0) {
    lines.push('In review (verify before marking complete):');
    for (const t of review) lines.push(`  ⋯ ${render(t)}`);
    lines.push('');
  }

  if (pending.length > 0) {
    lines.push('Pending:');
    const shown = pending.slice(0, max);
    for (const t of shown) lines.push(`  • ${render(t)}`);
    if (pending.length > shown.length) lines.push(`  … and ${pending.length - shown.length} more`);
    lines.push('');
  }

  if (blocked.length > 0) {
    lines.push('Blocked (unresolved - surface to the user):');
    for (const t of blocked) lines.push(`  ⛔ ${render(t)}`);
    lines.push('');
  }

  lines.push('Keep this plan accurate with the `todo` tool:');
  lines.push('- One item `in_progress` at a time (action `start`).');
  lines.push('- When work on an item is done but not yet verified, move it to `review` (action `review`).');
  lines.push(
    '- Mark `complete` after verification. From `in_progress` directly, include a `note` describing what verified it. From `review`, the note is optional - the review step already parked it for verification.',
  );
  lines.push('- If stuck, `block` with a `note` - never silently abandon an item.');
  lines.push('- `add` new items when additional work surfaces mid-task.');

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Completion-claim heuristic
// ──────────────────────────────────────────────────────────────────────

// Phrases typical of a final "I'm done" sign-off. Anchored to the TAIL of
// the message - the phrase must be the last meaningful content, with only
// punctuation / markdown fences / closing quotes after it. A short list of
// conversational trailers ("here", "now", "for you") is tolerated so that
// things like "I'm all done here." still match.
//
// Intentionally loose at the START (plain `\b`) - false positives would
// match mid-body mentions like "I finished the first pass" without an
// anchor, so we rely on the `$` anchor plus the short-trailer allowlist to
// keep the phrase at the end. NEGATIVE_HINT_RE rejects conditionals /
// questions separately.
const COMPLETION_TAIL_RE =
  /\b(?:all\s+(?:done|set|finished|good|ready)|(?:task|work|everything|this|it)\s+(?:is\s+)?(?:complete(?:d)?|done|finished)|done(?:\s+and\s+dusted)?|finished|complete(?:d)?|ready\s+to\s+(?:go|ship|merge|commit)|good\s+to\s+go|ship(?:ped|ping)?\s+it)(?:\s+(?:here|now|then|for\s+(?:you|now)))?\s*[.!)"'*_`~\s]*$/i;

// Negative hint: questions or explicit future-conditional references that
// contain completion words but aren't actually a sign-off.
const NEGATIVE_HINT_RE =
  /\?\s*[)"'*_`~\s]*$|\b(?:when|once|after|if|whether|until)\b[^.!?\n]*\b(?:done|finished|complete(?:d)?)\b/i;

/**
 * Heuristic: does the tail of `text` read like a final "done" sign-off?
 *
 * Only the last ~300 chars are inspected - the sign-off always lives near
 * the end, and looking at the full body multiplies false positives (any
 * past-tense mention of "finished" or "complete" would trip).
 */
export function looksLikeCompletionClaim(text: string): boolean {
  if (!text) return false;
  const tail = text.slice(-300).trim();
  if (!tail) return false;
  if (NEGATIVE_HINT_RE.test(tail)) return false;
  return COMPLETION_TAIL_RE.test(tail);
}
