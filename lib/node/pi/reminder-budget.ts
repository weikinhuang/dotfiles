import type { ReminderMessage } from './context-reminder.ts';
import { reminderMessageAnchor, reminderMessageKeys } from './reminder-identity.ts';
import { estimateChars } from './roleplay/context-window.ts';

export function reminderRequestChars(messages: readonly ReminderMessage[]): number {
  let chars = estimateChars(messages);
  for (const message of messages) {
    if (Array.isArray(message.tools)) chars += JSON.stringify(message.tools).length;
    if (message.content === undefined && typeof message.summary === 'string') chars += message.summary.length;
    if (message.content === undefined && typeof message.output === 'string') chars += message.output.length;
  }
  return chars;
}

export interface ReminderLimitResult {
  messages: ReminderMessage[];
  floorAnchor?: string;
  fits: boolean;
  projectedChars: number;
}

/** Bound the final projection, not just its raw transcript. Trial windows have no capture side effects. */
export function limitReminderContext(params: {
  messages: readonly ReminderMessage[];
  preview: (messages: readonly ReminderMessage[]) => readonly ReminderMessage[];
  origin?: string;
  floorAnchor?: string;
  windowTokens: number;
  charsPerToken: number;
}): ReminderLimitResult {
  const { messages, preview, origin, floorAnchor, windowTokens } = params;
  const cpt = Number.isFinite(params.charsPerToken) && params.charsPerToken > 0 ? params.charsPerToken : 4;
  const outputMargin = Math.min(1024, Math.max(1, Math.floor(windowTokens / 4)));
  const reserve = Math.min(3072, Math.max(outputMargin, Math.floor(windowTokens * 0.75)));
  const hardLimit = Math.max(1, windowTokens - outputMargin);
  const fitTarget = Math.max(1, windowTokens - reserve);
  const originIndex = origin
    ? messages.findIndex((message) => reminderMessageKeys(message).includes(origin))
    : messages.findLastIndex((message) => message.role === 'user' || message.role === 'custom');
  const cut = (index: number): ReminderMessage[] =>
    messages.filter((message, position) => message.role === 'system' || position >= index);
  const held = floorAnchor ? messages.findIndex((message) => reminderMessageKeys(message).includes(floorAnchor)) : -1;
  const start = held >= 0 && (originIndex < 0 || held <= originIndex) ? held : 0;
  let selected = cut(start);
  let projectedChars = reminderRequestChars(preview(selected));
  if (projectedChars / cpt <= hardLimit)
    return { messages: selected, fits: true, projectedChars, ...(held >= 0 ? { floorAnchor } : {}) };
  // Cut only at whole real user turns, or at the actual custom trigger. Never
  // count replayed instruction messages as new turns or discard startup guides.
  const boundaries = messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message, index }) =>
        index > start && index <= originIndex && (message.role === 'user' || index === originIndex),
    );
  let selectedAnchor: string | undefined;
  for (const { message, index } of boundaries) {
    selected = cut(index);
    selectedAnchor = reminderMessageAnchor(message);
    projectedChars = reminderRequestChars(preview(selected));
    if (projectedChars / cpt <= fitTarget) break;
  }
  return {
    messages: selected,
    fits: projectedChars / cpt <= hardLimit,
    projectedChars,
    ...(selectedAnchor ? { floorAnchor: selectedAnchor } : floorAnchor && held >= 0 ? { floorAnchor } : {}),
  };
}
