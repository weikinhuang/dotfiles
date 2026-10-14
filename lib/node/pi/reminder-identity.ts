import { createHash } from 'node:crypto';

import type { ReminderMessage } from './context-reminder.ts';
import { isRecord, isTextPart } from './shared/guards.ts';

export const REMINDER_ENTRY_ID = 'cacheReminderEntryId';
const UNBOUND = 'cacheReminderIdentityUnavailable';

export interface ReminderTrigger {
  messageType: 'user' | 'custom';
  customType?: string;
  timestamp?: number;
}

interface Contribution {
  id: string;
  message: ReminderMessage;
}

function contentKey(message: ReminderMessage): string {
  const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
  return (
    JSON.stringify(
      Array.isArray(parts)
        ? parts.filter((part: unknown) => {
            if (!isRecord(part)) return true;
            if (part.type === 'thinking') return false;
            return (
              !isTextPart(part) || !/^<system-reminder id="[a-z0-9-]+">\n[\s\S]*\n<\/system-reminder>$/.test(part.text)
            );
          })
        : parts,
    ) ?? 'null'
  );
}

/** Content-based identity remains useful for synthetic messages and untagged callers. */
export function reminderContentAnchor(message: ReminderMessage): string {
  const plain: Record<string, unknown> = { ...message };
  delete plain[REMINDER_ENTRY_ID];
  delete plain[UNBOUND];
  plain.content = JSON.parse(contentKey(message)) as unknown;
  return createHash('sha256').update(JSON.stringify(plain)).digest('hex');
}

export function reminderMessageAnchor(message: ReminderMessage): string {
  const id = message[REMINDER_ENTRY_ID];
  return typeof id === 'string' ? id : reminderContentAnchor(message);
}

export function reminderMessageKeys(message: ReminderMessage): string[] {
  if (message[UNBOUND] === true) return [];
  return [...new Set([reminderMessageAnchor(message), reminderContentAnchor(message)])];
}

function contributions(projection: unknown): Contribution[] {
  if (!isRecord(projection) || !Array.isArray(projection.entries)) return [];
  const result: Contribution[] = [];
  for (const entry of projection.entries as unknown[]) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.sourceEntry) ||
      typeof entry.sourceEntry.id !== 'string' ||
      !Array.isArray(entry.messages)
    )
      continue;
    let ordinal = 0;
    for (const message of entry.messages as unknown[]) {
      if (!isRecord(message) || typeof message.role !== 'string' || message.role === 'system') continue;
      result.push({ id: `entry:${entry.sourceEntry.id}:${ordinal++}`, message: message as ReminderMessage });
    }
  }
  return result;
}

function sameEnvelope(left: ReminderMessage, right: ReminderMessage): boolean {
  if (left.role !== right.role) return false;
  if (left.role === 'custom') return left.customType === right.customType && contentKey(left) === contentKey(right);
  return left.timestamp === right.timestamp && left.toolCallId === right.toolCallId;
}

function taggedMessage(
  message: ReminderMessage,
  values: Record<string, unknown>,
  preserveReferences: boolean,
): ReminderMessage {
  return preserveReferences ? Object.assign(message, values) : { ...message, ...values };
}

/** Stamp provenance before overlays. SDK copies may preserve object references to avoid a spurious system-prefix rebuild. */
export function ensureReminderIdentities(
  messages: readonly ReminderMessage[],
  projection?: unknown,
  preserveReferences = false,
): ReminderMessage[] {
  const sources = contributions(projection);
  const visible = messages.filter((message) => message.role !== 'system' && message.cacheReminderSnapshot !== true);
  const pristine =
    sources.length === visible.length &&
    visible.every((message, index) => sameEnvelope(message, sources[index].message));
  const used = new Set<string>(
    messages.map((message) => message[REMINDER_ENTRY_ID]).filter((id): id is string => typeof id === 'string'),
  );
  const occurrences = new Map<string, number>();
  let position = 0;
  return messages.map((message) => {
    if (message.role === 'system' || message.cacheReminderSnapshot === true) return message;
    const source = pristine ? sources[position] : undefined;
    position += 1;
    const envelope = JSON.stringify([message.role, message.timestamp, message.customType, message.toolCallId]);
    const ordinal = occurrences.get(envelope) ?? 0;
    occurrences.set(envelope, ordinal + 1);
    if (typeof message[REMINDER_ENTRY_ID] === 'string') return message;
    const candidates = source
      ? [source]
      : sources.filter((candidate) => !used.has(candidate.id) && sameEnvelope(message, candidate.message));
    if (candidates.length === 1) {
      used.add(candidates[0].id);
      return taggedMessage(message, { [REMINDER_ENTRY_ID]: candidates[0].id }, preserveReferences);
    }
    if (candidates.length > 1) return taggedMessage(message, { [UNBOUND]: true }, preserveReferences);
    // Request-only recap/timeline messages have no persisted entry. Their envelope
    // stays stable through content overlays; ordinal disambiguates same-tick items.
    const id =
      typeof message.timestamp === 'number'
        ? `transient:${createHash('sha256').update(envelope).digest('hex')}:${ordinal}`
        : reminderContentAnchor(message);
    return taggedMessage(message, { [REMINDER_ENTRY_ID]: id }, preserveReferences);
  });
}

/** Select the trigger, never operational messages appended after it. */
export function reminderOriginIndex(
  messages: readonly ReminderMessage[],
  trigger?: ReminderTrigger,
  boundOrigin?: string,
): number {
  if (boundOrigin) return messages.findIndex((message) => reminderMessageKeys(message).includes(boundOrigin));
  if (trigger?.messageType === 'user')
    return messages.findLastIndex(
      (message) => message.role === 'user' && message.cacheReminderSnapshot !== true && message[UNBOUND] !== true,
    );
  if (trigger?.messageType === 'custom') {
    const matches = messages
      .map((message, index) => ({ message, index }))
      .filter(
        ({ message }) =>
          message.role === 'custom' &&
          message.customType === trigger.customType &&
          (trigger.timestamp === undefined || message.timestamp === trigger.timestamp),
      );
    return matches.length === 1 ? matches[0].index : -1;
  }
  const tail = messages.at(-1);
  return tail && (tail.role === 'user' || tail.role === 'custom') && tail[UNBOUND] !== true ? messages.length - 1 : -1;
}

/** The first newly persisted matching input precedes queued nextTurn/handler messages. */
export function persistedReminderOrigin(
  projection: unknown,
  frontier: ReadonlySet<string>,
  trigger: ReminderTrigger,
): string | undefined {
  return contributions(projection).find(
    ({ id, message }) =>
      !frontier.has(id) &&
      (trigger.messageType === 'user'
        ? message.role === 'user'
        : message.role === 'custom' && message.customType === trigger.customType),
  )?.id;
}

export function reminderProjectionIds(projection: unknown): Set<string> {
  return new Set(contributions(projection).map((source) => source.id));
}
