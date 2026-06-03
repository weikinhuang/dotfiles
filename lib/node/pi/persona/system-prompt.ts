/**
 * Pure system-prompt composer for the persona extension's
 * `before_agent_start` hook.
 *
 * A persona contributes to the turn's system prompt in two ways:
 *
 *   - `addendum` - the persona body plus any `appendSystemPrompt`,
 *     already joined by the resolver. This is *appended* to whatever
 *     base prompt is in play (parity with `preset.ts`).
 *   - `override` - an escape hatch that *replaces* pi's base prompt
 *     entirely (dropping the default coding-agent scaffolding), for
 *     non-coding personas (chat, journal, roleplay). The addendum is
 *     still appended after the override.
 *
 * Pulled out of the shell so the branch logic is unit-tested directly
 * under vitest instead of through pi's runtime.
 */

export interface ComposeSystemPromptInput {
  /** The incoming base prompt from the `before_agent_start` event. */
  readonly incoming: string;
  /** Persona body + `appendSystemPrompt`, already joined. Empty string when none. */
  readonly addendum: string;
  /** When set, replaces `incoming` as the base. `undefined` keeps the incoming base. */
  readonly override: string | undefined;
}

/**
 * Compose the system prompt for an active persona. Returns the composed
 * string, or `null` when the persona contributes nothing (no override
 * and an empty addendum) so the caller can return `undefined` and leave
 * the prompt untouched.
 *
 * Trailing whitespace on the base is stripped before joining; the two
 * sides are separated by a blank line only when both are non-empty so a
 * persona that overrides to an empty base and supplies only an addendum
 * doesn't get a leading blank line.
 */
export function composeSystemPrompt(input: ComposeSystemPromptInput): string | null {
  const { incoming, addendum, override } = input;
  if (override === undefined && addendum.length === 0) return null;

  const base = (override ?? incoming).replace(/\s+$/, '');
  if (addendum.length === 0) return base;
  const sep = base.length > 0 ? '\n\n' : '';
  return `${base}${sep}${addendum}`;
}
