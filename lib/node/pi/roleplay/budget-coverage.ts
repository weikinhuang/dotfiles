import type { ReminderMessage } from '../context-reminder.ts';
import { reminderMessageKeys } from '../reminder-identity.ts';

/** Resolve only against the scene transcript, never replayed snapshot instruction messages. */
export function transcriptIndex(message: ReminderMessage, transcript: readonly ReminderMessage[]): number {
  const keys = new Set(reminderMessageKeys(message));
  return transcript.findIndex((candidate) => reminderMessageKeys(candidate).some((key) => keys.has(key)));
}

/** First transcript item a candidate retained; system declarations and startup guides do not set coverage. */
export function retainedTranscriptStart(
  candidate: readonly ReminderMessage[],
  transcript: readonly ReminderMessage[],
): number {
  for (const message of candidate) {
    if (message.role === 'system') continue;
    const index = transcriptIndex(message, transcript);
    if (index >= 0) return index;
  }
  return -1;
}

/** Remove only transcript items covered by a committed recap; preserve declarations and non-transcript guides. */
export function dropCoveredMessages(
  messages: readonly ReminderMessage[],
  transcript: readonly ReminderMessage[],
  coveredTo: number,
): ReminderMessage[] {
  const positions = new Map<string, number>();
  for (const [index, message] of transcript.entries()) {
    for (const key of reminderMessageKeys(message)) if (!positions.has(key)) positions.set(key, index);
  }
  return messages.filter((message) => {
    if (message.role === 'system') return true;
    const index = reminderMessageKeys(message)
      .map((key) => positions.get(key))
      .find((value) => value !== undefined);
    return index === undefined || index >= coveredTo;
  });
}

/** A current request may stop waiting without cancelling the normal background recap's useful work. */
export async function waitForRecap(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error('Recap wait aborted');
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Recap wait aborted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([promise, cancelled]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}
