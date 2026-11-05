import type { ReminderMessage } from '../context-reminder.ts';
import { reminderMessageKeys } from '../reminder-identity.ts';
import { injectRecap, injectTimeline } from './context-window.ts';
import { preserveSceneOpener } from './retention-policy.ts';

export function pinnedKeys(messages: readonly ReminderMessage[]): ReadonlySet<string> {
  return new Set(messages.flatMap((message) => reminderMessageKeys(message)));
}

export function isPinned(message: ReminderMessage, keys: ReadonlySet<string>): boolean {
  return reminderMessageKeys(message).some((key) => keys.has(key));
}

/** Retain the original opener, never a condensed copy or a freshly emitted reminder. */
export function restorePinnedHead(
  candidate: readonly ReminderMessage[],
  opener: readonly ReminderMessage[],
): ReminderMessage[] {
  return [...preserveSceneOpener(opener, candidate, true)];
}

/** Memory follows the historical pinned head and precedes the retained continuation. */
export function projectSceneMemory(
  messages: readonly ReminderMessage[],
  recap: string,
  timeline: string | null,
  opener: readonly ReminderMessage[] = [],
): ReminderMessage[] {
  const restored = restorePinnedHead(messages, opener);
  const keys = pinnedKeys(opener);
  const lastPinned = restored.findLastIndex((message) => isPinned(message, keys));
  const prefix = restored.slice(0, lastPinned + 1);
  let tail = restored.slice(lastPinned + 1) as readonly Record<string, unknown>[];
  if (timeline) tail = injectTimeline(tail, timeline);
  if (recap.trim()) tail = injectRecap(tail, recap);
  if (timeline || recap.trim()) {
    const anchor = tail.findIndex((message) => message.role === 'user' || message.role === 'custom');
    tail = tail.map((message, index) => (index === anchor ? { ...message, roleplaySceneMemory: true } : message));
  }
  return [...prefix, ...(tail as ReminderMessage[])];
}
