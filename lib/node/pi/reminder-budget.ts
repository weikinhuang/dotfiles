import type { ReminderMessage } from './context-reminder.ts';
import { reminderMessageAnchor, reminderMessageKeys } from './reminder-identity.ts';
import { estimateChars } from './roleplay/context-window.ts';
import { isRecord } from './shared/guards.ts';

/** Count the effective head, including SDK section/tool declarations; a forced prompt replaces section text. */
export function reminderRequestChars(messages: readonly ReminderMessage[], systemPrompt?: string): number {
  let chars = typeof systemPrompt === 'string' ? systemPrompt.length : 0;
  const sections = new Map<string, string>();
  const tools = new Map<string, unknown>();
  let declaresTools = false;
  for (const message of messages) {
    if (message.role === 'system') {
      if (systemPrompt === undefined) chars += estimateChars([message]);
      if (isRecord(message.sections)) {
        for (const [key, value] of Object.entries(message.sections)) {
          if (typeof value === 'string') sections.set(key, value);
          else if (value === null || value === undefined) sections.delete(key);
        }
      }
      if (Array.isArray(message.tools)) {
        tools.clear();
        declaresTools = true;
      }
      const added = Array.isArray(message.tools) ? message.tools : message.toolsAdded;
      if (Array.isArray(added)) {
        declaresTools = true;
        for (const [index, tool] of added.entries()) {
          const name = isRecord(tool) && typeof tool.name === 'string' ? tool.name : String(index);
          tools.set(name, tool);
        }
      }
      if (Array.isArray(message.toolsRemoved)) {
        declaresTools = true;
        for (const name of message.toolsRemoved) if (typeof name === 'string') tools.delete(name);
      }
    } else {
      chars += estimateChars([message]);
      if (Array.isArray(message.tools)) chars += JSON.stringify(message.tools).length;
    }
    if (message.content === undefined && typeof message.summary === 'string') chars += message.summary.length;
    if (message.content === undefined && typeof message.output === 'string') chars += message.output.length;
  }
  if (systemPrompt === undefined) for (const text of sections.values()) chars += text.length;
  if (declaresTools) chars += JSON.stringify([...tools.values()]).length;
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
  /** Provider-visible head overrides can be applied after the context hooks. */
  requestChars?: (messages: readonly ReminderMessage[]) => number;
}): ReminderLimitResult {
  const { messages, preview, origin, floorAnchor, windowTokens } = params;
  const requestChars = params.requestChars ?? reminderRequestChars;
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
  let projectedChars = requestChars(preview(selected));
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
  let hardFit: ReminderLimitResult | undefined;
  for (const { message, index } of boundaries) {
    selected = cut(index);
    selectedAnchor = reminderMessageAnchor(message);
    projectedChars = requestChars(preview(selected));
    if (projectedChars / cpt <= fitTarget) {
      hardFit = undefined;
      break;
    }
    if (!hardFit && projectedChars / cpt <= hardLimit)
      hardFit = {
        messages: selected,
        fits: true,
        projectedChars,
        ...(selectedAnchor ? { floorAnchor: selectedAnchor } : {}),
      };
  }
  // A large mandatory head may make the preferred reserve impossible. Do not
  // erase every earlier scene turn when a larger suffix already fits safely.
  if (hardFit) return hardFit;
  return {
    messages: selected,
    fits: projectedChars / cpt <= hardLimit,
    projectedChars,
    ...(selectedAnchor ? { floorAnchor: selectedAnchor } : floorAnchor && held >= 0 ? { floorAnchor } : {}),
  };
}
