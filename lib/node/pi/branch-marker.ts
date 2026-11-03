/**
 * Session-branch marker detection for idempotent extension nudges.
 * No pi imports - testable under `vitest`.
 */

/**
 * Minimal shape of a session branch entry. We only touch the fields we
 * need so tests can fabricate fakes.
 *
 * State-mirror customs (`*-state`) are not user-equivalent boundaries;
 * other custom entries represent synthesized nudges.
 */
export interface BranchEntry {
  readonly type?: string;
  readonly customType?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
  };
}

/** Is this entry a synthesized user-equivalent nudge rather than state? */
function isNudgeCustomEntry(entry: BranchEntry): boolean {
  if (entry.type !== 'custom') return false;
  const ct = entry.customType;
  if (typeof ct !== 'string' || ct.length === 0) return false;
  return !ct.endsWith('-state');
}

/**
 * Did the most recent user-equivalent entry on `branch` come from US
 * (this nudge)? Used as an idempotency guard so the extension doesn't
 * steer twice in a row on the same turn.
 *
 * Walks newest-to-oldest; the first user-equivalent boundary it finds
 * decides:
 *
 *   - Real `user` message: returns whether `marker` appears in the
 *     content text. (Legacy path - covers user replays of our marker
 *     and any nudge that has not yet migrated to `pi.sendMessage`.)
 *   - Synthesized custom-nudge entry (`type: 'custom'`, non-`*-state`
 *     customType): returns true iff `ownCustomType` is provided AND
 *     equals the entry's customType. Any other extension's custom
 *     nudge is still a boundary, but it is "not ours" so the answer
 *     is false - we have NOT already steered this turn.
 *   - Anything else (assistant, toolResult, state-mirror customs):
 *     skipped.
 *
 * Pass `ownCustomType` whenever the caller's nudge is delivered via
 * `pi.sendMessage({ customType: ... })`. Callers still on
 * `sendUserMessage` can omit it - the legacy text-marker path on real
 * user messages stays correct.
 */
export function lastUserMessageHasMarker(
  branch: readonly BranchEntry[],
  marker: string,
  ownCustomType?: string,
): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (isNudgeCustomEntry(entry)) {
      return ownCustomType !== undefined && entry.customType === ownCustomType;
    }
    const msg = entry.message;
    if (msg?.role !== 'user') continue;
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
          text += (c as { text?: string }).text ?? '';
        }
      }
    }
    return text.includes(marker);
  }
  return false;
}
