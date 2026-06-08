/**
 * Cross-extension emote signal for the avatar widget: a persisted record
 * of the `[emote:NAME]` markers the model emitted, plus a live event bus
 * other extensions can subscribe to.
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
 *   2. **Other extensions (e.g. a TTS extension).** When the avatar
 *      finalizes an assistant message it calls {@link emitEmote}; any
 *      extension that called {@link subscribeEmote} is notified with the
 *      message's emotes. A TTS extension can then colour its speech with
 *      the emotion when the message itself defined none inline, reading
 *      {@link getLastEmote} as a fallback.
 *
 * The bus is anchored on `globalThis` behind a `Symbol.for()` key (the
 * `cross-extension-singleton-pattern`, the same one `input.ts` uses): pi
 * gives each extension its own jiti instance with `moduleCache: false`,
 * so a plain module-level registry would NOT be shared across the avatar
 * and a subscriber extension.
 *
 * Pure module - no pi imports. Decoupled both ways: if no extension
 * subscribes the avatar just emits into the void; if the avatar is
 * disabled a subscriber simply never hears anything.
 */

import { createGlobalSlot } from '../global-slot.ts';

/** Session `custom` entry type under which emote records are persisted. */
export const AVATAR_EMOTE_ENTRY_TYPE = 'avatar-emote';

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

type EmoteListener = (signal: EmoteSignal) => void;

interface EmoteBus {
  readonly listeners: Set<EmoteListener>;
  last: EmoteSignal | undefined;
}

const getBus = createGlobalSlot<EmoteBus>('@dotfiles/pi/avatar/emote-events', () => ({
  listeners: new Set(),
  last: undefined,
}));

/**
 * Subscribe to finalized emote signals. Returns an unsubscribe function;
 * call it from the subscriber's `session_shutdown` handler so a `/reload`
 * does not leave a stale listener (and a doubled callback) behind.
 */
export function subscribeEmote(listener: EmoteListener): () => void {
  const bus = getBus();
  bus.listeners.add(listener);
  return () => {
    bus.listeners.delete(listener);
  };
}

/**
 * Publish a finalized emote signal: record it as {@link getLastEmote} and
 * notify every subscriber. Each listener is isolated in its own try/catch
 * so one throwing subscriber cannot break the avatar or the others.
 */
export function emitEmote(signal: EmoteSignal): void {
  const bus = getBus();
  bus.last = signal;
  for (const listener of bus.listeners) {
    try {
      listener(signal);
    } catch {
      /* a subscriber's failure must not break the emitter */
    }
  }
}

/**
 * The most recently emitted signal this process, or `undefined` if none.
 * A fallback for a consumer that joins late (e.g. a TTS extension reading
 * "what emotion was the last message?" when its own message carried none).
 */
export function getLastEmote(): EmoteSignal | undefined {
  return getBus().last;
}

/** Drop all listeners and the last-emote cache. Test isolation only. */
export function resetEmoteBus(): void {
  const bus = getBus();
  bus.listeners.clear();
  bus.last = undefined;
}

/** Minimal shape of a session entry the reader inspects. */
interface LooseEntry {
  readonly type?: string;
  readonly customType?: string;
  readonly data?: unknown;
}

function isEmoteSignal(value: unknown): value is EmoteSignal {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { emote?: unknown; emotes?: unknown; at?: unknown };
  return (
    typeof candidate.emote === 'string' &&
    Array.isArray(candidate.emotes) &&
    candidate.emotes.every((name) => typeof name === 'string') &&
    typeof candidate.at === 'number'
  );
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
