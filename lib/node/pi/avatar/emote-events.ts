/**
 * Cross-extension emote contract for the avatar widget: the payload type,
 * the pi event-bus channel it travels on, a validator for the untyped
 * bus payload, and a reader that reconstructs the persisted records.
 *
 * The `avatar` extension strips `[emote:NAME]` markers from the visible
 * reply (see `markers.ts`). Two consumers want those stripped names:
 *
 *   1. **Session history.** The names are persisted as a `custom` session
 *      entry (`AVATAR_EMOTE_ENTRY_TYPE`) by `avatar.ts`, so looking back
 *      at a transcript shows which emotion each assistant message carried
 *      even though the marker is gone from the visible text. Persistence
 *      is pi-coupled (`pi.appendEntry`) and lives in the extension; the
 *      pure {@link collectLoggedEmotes} reader here turns a flat entry
 *      list back into {@link EmoteSignal}s for tests / status readouts.
 *   2. **Other extensions (e.g. the TTS extension).** When the avatar
 *      finalizes an assistant message it emits an {@link EmoteSignal} on
 *      pi's shared event bus under {@link AVATAR_EMOTE_CHANNEL}; any
 *      extension that subscribes (`pi.events.on(AVATAR_EMOTE_CHANNEL, …)`)
 *      is notified with the message's emotes. A TTS extension can then
 *      colour its speech with the emotion when the message itself defined
 *      none inline. Because the bus is fire-and-forget, a late-joining
 *      consumer that wants "the last emote" caches it itself from the
 *      subscription. Payloads arrive untyped (`unknown`), so validate with
 *      {@link isEmoteSignal} before use.
 *
 * pi hands every extension the SAME `EventBus` instance (created once in
 * its extension loader), so the channel is shared across extensions
 * without the `globalThis`/`Symbol.for` singleton dance a hand-rolled bus
 * would need under pi's per-extension jiti isolation.
 *
 * Pure module - no pi imports. Decoupled both ways: if no extension
 * subscribes the avatar just emits into the void; if the avatar is
 * disabled a subscriber simply never hears anything.
 */

/** Session `custom` entry type under which emote records are persisted. */
export const AVATAR_EMOTE_ENTRY_TYPE = 'avatar-emote';

/** pi event-bus channel the avatar emits finalized {@link EmoteSignal}s on. */
export const AVATAR_EMOTE_CHANNEL = 'avatar:emote';

/** A finalized emote record for one assistant message. */
export interface EmoteSignal {
  /**
   * The primary emotion - the last `[emote:NAME]` the message named,
   * matching the overlay the avatar actually showed (it follows the most
   * recent marker). Always present in {@link emotes}.
   */
  readonly emote: string;
  /** Every distinct emotion the message named, in first-seen order. */
  readonly emotes: readonly string[];
  /** Epoch milliseconds when the message was finalized. */
  readonly at: number;
}

/**
 * Narrow an untyped bus payload to an {@link EmoteSignal}. Subscribers
 * receive `unknown` from `pi.events.on`, so guard with this before use;
 * it tolerates foreign / malformed payloads by returning `false`.
 */
export function isEmoteSignal(value: unknown): value is EmoteSignal {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { emote?: unknown; emotes?: unknown; at?: unknown };
  return (
    typeof candidate.emote === 'string' &&
    Array.isArray(candidate.emotes) &&
    candidate.emotes.every((name) => typeof name === 'string') &&
    typeof candidate.at === 'number'
  );
}

/** Minimal shape of a session entry the reader inspects. */
interface LooseEntry {
  readonly type?: string;
  readonly customType?: string;
  readonly data?: unknown;
}

/**
 * Pull every persisted emote record out of a flat session-entry list, in
 * entry order. Tolerates malformed / foreign entries (skips anything that
 * is not a well-formed {@link EmoteSignal} under our custom type).
 */
export function collectLoggedEmotes(entries: readonly LooseEntry[]): EmoteSignal[] {
  const out: EmoteSignal[] = [];
  for (const entry of entries) {
    if (entry?.type !== 'custom' || entry.customType !== AVATAR_EMOTE_ENTRY_TYPE) continue;
    if (isEmoteSignal(entry.data)) {
      out.push({ emote: entry.data.emote, emotes: [...entry.data.emotes], at: entry.data.at });
    }
  }
  return out;
}
