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
  /**
   * Render the `cancelled` bucket. Default `true`. The tail/`context` arm
   * passes `false`: cancelled items are out-of-scope context, not a
   * next-action, and are uncapped - re-sending them on the full-rate tail
   * every turn is waste. They stay visible in the `/todos` overlay and
   * `renderResult`.
   */
  includeCancelled?: boolean;
  /**
   * Trailing "how to use the todo tool" block. `'full'` (default) appends the
   * six-bullet reminder; `'none'` omits it. The tail/`context` arm passes
   * `'none'`: that guidance duplicates the tool's `promptGuidelines` (already
   * in a cached prompt location), so repeating it on the full-rate tail every
   * turn is redundant.
   */
  footer?: 'full' | 'none';
}

/**
 * Build the "# Active plan" block surfaced every turn (appended to the
 * system prompt by the `before_agent_start` arm, or spliced into the tail
 * as an ephemeral `<system-reminder>` by the `context` arm). Section order:
 *   1. in_progress (focus)
 *   2. review (awaiting verification)
 *   3. pending (queue, capped at `maxItems`)
 *   4. blocked (surface unresolved obstacles)
 *   5. cancelled (out-of-scope context; omitted when `includeCancelled` is false)
 * followed by the how-to footer (omitted when `footer` is `'none'`).
 *
 * Returns `null` when there is nothing worth showing (empty, or only
 * `completed` items, or - in lean mode - only `cancelled` items) so the
 * caller can skip the injection. `completed` items are never rendered.
 */
export function formatActivePlan(state: TodoState, opts: FormatOptions = {}): string | null {
  const max = Math.max(1, opts.maxItems ?? 10);
  const includeCancelled = opts.includeCancelled ?? true;
  const withFooter = (opts.footer ?? 'full') === 'full';
  const inProgress = state.todos.filter((t) => t.status === 'in_progress');
  const review = state.todos.filter((t) => t.status === 'review');
  const pending = state.todos.filter((t) => t.status === 'pending');
  const blocked = state.todos.filter((t) => t.status === 'blocked');
  const cancelled = includeCancelled ? state.todos.filter((t) => t.status === 'cancelled') : [];

  if (
    inProgress.length === 0 &&
    review.length === 0 &&
    pending.length === 0 &&
    blocked.length === 0 &&
    cancelled.length === 0
  ) {
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

  if (cancelled.length > 0) {
    lines.push(`Cancelled (${cancelled.length}) - out of scope, kept for context:`);
    for (const t of cancelled) lines.push(`  ⊘ ${render(t)}`);
    lines.push('');
  }

  if (withFooter) {
    lines.push('Keep this plan accurate with the `todo` tool:');
    lines.push('- One item `in_progress` at a time (action `start`).');
    lines.push('- When work on an item is done but not yet verified, move it to `review` (action `review`).');
    lines.push(
      '- Mark `complete` after verification. From `in_progress` directly, include a `note` describing what verified it. From `review`, the note is optional - the review step already parked it for verification.',
    );
    lines.push(
      '- Use `block` when work is still needed but parked on an external dependency (waiting on review, broken upstream, missing data); the note explains what is being waited on.',
    );
    lines.push(
      '- Use `cancel` when the item is no longer in scope (superseded, duplicate, pivoted, no longer relevant); the note explains why. Never silently abandon an item.',
    );
    lines.push('- `add` new items when additional work surfaces mid-task.');
  }

  return lines.join('\n').trimEnd();
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
