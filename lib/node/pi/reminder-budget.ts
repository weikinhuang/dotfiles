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

/**
 * pi-ai clamps each request's `max_tokens` to `contextWindow - estimate - 4096`
 * (`clampMaxTokensToContext`). When it cannot pair the prompt with the last
 * reply's usage it estimates at 3.5 chars/token, which on prose runs well above
 * the real count. A limiter that ignores that clamp can accept a prompt that
 * fits the window yet leaves the reply 1 token. Mirror both constants here.
 */
export const PI_CONTEXT_SAFETY_TOKENS = 4096;
const PI_CHARS_PER_TOKEN = 3.5;
const PI_IMAGE_CHARS = 4800;
/** Below this window pi's fixed margin cannot be met at all; do not apply it. */
export const PI_SAFETY_MIN_WINDOW = 4 * PI_CONTEXT_SAFETY_TOKENS;

function piContentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content as unknown[]) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') chars += part.text.length;
    else if (part.type === 'thinking' && typeof part.thinking === 'string') chars += part.thinking.length;
    else if (part.type === 'toolCall')
      chars += (typeof part.name === 'string' ? part.name.length : 0) + JSON.stringify(part.arguments ?? {}).length;
    else if (part.type === 'image') chars += PI_IMAGE_CHARS;
  }
  return chars;
}

/**
 * pi's character-fallback estimate of the provider request: 3.5 chars/token per
 * message (rounded up per message, as pi does), the effective system head, and
 * the declared tools. Content-less pi kinds count the text pi converts them to.
 */
export function piFallbackTokens(messages: readonly ReminderMessage[], systemPrompt?: string): number {
  const ceil = (chars: number): number => Math.ceil(chars / PI_CHARS_PER_TOKEN);
  let tokens = typeof systemPrompt === 'string' ? ceil(systemPrompt.length) : 0;
  const tools = new Map<string, unknown>();
  let declaresTools = false;
  for (const message of messages) {
    if (message.role === 'system') {
      if (systemPrompt === undefined) {
        let chars = piContentChars(message.content);
        if (isRecord(message.sections))
          for (const value of Object.values(message.sections)) if (typeof value === 'string') chars += value.length;
        tokens += ceil(chars);
      }
      if (Array.isArray(message.tools)) tools.clear();
      const added = Array.isArray(message.tools) ? message.tools : message.toolsAdded;
      if (Array.isArray(added)) {
        declaresTools = true;
        for (const [index, tool] of added.entries())
          tools.set(isRecord(tool) && typeof tool.name === 'string' ? tool.name : String(index), tool);
      }
      if (Array.isArray(message.toolsRemoved)) {
        declaresTools = true;
        for (const name of message.toolsRemoved) if (typeof name === 'string') tools.delete(name);
      }
      continue;
    }
    let chars = piContentChars(message.content);
    // compaction / branch summaries and `!command` runs reach the model as user text
    // with a short framing prefix; count the payload plus that framing.
    if (message.content === undefined && typeof message.summary === 'string') chars += message.summary.length + 120;
    if (message.content === undefined && typeof message.command === 'string') chars += message.command.length + 40;
    if (message.content === undefined && typeof message.output === 'string') chars += message.output.length;
    tokens += ceil(chars);
  }
  if (declaresTools) tokens += ceil(JSON.stringify([...tools.values()]).length);
  return tokens;
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
  /** Soft full-input target; physical fit and preservation still take precedence. */
  promptTokenTarget?: number;
  /** A disjoint historical head may survive every tail cut. */
  protectedKeys?: ReadonlySet<string>;
  /** Provider-visible head overrides can be applied after the context hooks. */
  requestChars?: (messages: readonly ReminderMessage[]) => number;
  /**
   * Token footprint of a previewed candidate. Defaults to `requestChars / charsPerToken`;
   * a caller can add margins the provider SDK reserves (pi's `max_tokens` clamp).
   */
  requestTokens?: (messages: readonly ReminderMessage[], chars: number) => number;
}): ReminderLimitResult {
  const { messages, preview, origin, floorAnchor, windowTokens } = params;
  const requestChars = params.requestChars ?? reminderRequestChars;
  const cpt = Number.isFinite(params.charsPerToken) && params.charsPerToken > 0 ? params.charsPerToken : 4;
  const tokensOf = (candidate: readonly ReminderMessage[]): { chars: number; tokens: number } => {
    const chars = requestChars(candidate);
    return { chars, tokens: params.requestTokens ? params.requestTokens(candidate, chars) : chars / cpt };
  };
  const outputMargin = Math.min(1024, Math.max(1, Math.floor(windowTokens / 4)));
  const reserve = Math.min(3072, Math.max(outputMargin, Math.floor(windowTokens * 0.75)));
  const hardLimit = Math.max(1, windowTokens - outputMargin);
  const fitTarget = Math.max(1, windowTokens - reserve);
  const softTarget = params.promptTokenTarget && params.promptTokenTarget > 0 ? params.promptTokenTarget : Infinity;
  const softFitTarget = Number.isFinite(softTarget) ? Math.max(1, Math.floor(softTarget * 0.9)) : Infinity;
  const protectedKeys = params.protectedKeys ?? new Set<string>();
  const protectedMessage = (message: ReminderMessage): boolean =>
    reminderMessageKeys(message).some((key) => protectedKeys.has(key));
  const originIndex = origin
    ? messages.findIndex((message) => reminderMessageKeys(message).includes(origin))
    : messages.findLastIndex((message) => message.role === 'user' || message.role === 'custom');
  const cut = (index: number): ReminderMessage[] =>
    messages.filter((message, position) => message.role === 'system' || protectedMessage(message) || position >= index);
  const held = floorAnchor ? messages.findIndex((message) => reminderMessageKeys(message).includes(floorAnchor)) : -1;
  const start = held >= 0 && (originIndex < 0 || held <= originIndex) ? held : 0;
  let selected = cut(start);
  let measured = tokensOf(preview(selected));
  let projectedChars = measured.chars;
  if (measured.tokens <= hardLimit && measured.chars / cpt <= softTarget)
    return { messages: selected, fits: true, projectedChars, ...(held >= 0 ? { floorAnchor } : {}) };
  // Cut only at whole real user turns, or at the actual custom trigger. Never
  // count replayed instruction messages as new turns or discard startup guides.
  const boundaries = messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message, index }) =>
        index > start &&
        index <= originIndex &&
        !protectedMessage(message) &&
        (message.role === 'user' || index === originIndex),
    );
  let selectedAnchor: string | undefined;
  let hardFit: ReminderLimitResult | undefined =
    measured.tokens <= hardLimit
      ? { messages: selected, fits: true, projectedChars, ...(held >= 0 ? { floorAnchor } : {}) }
      : undefined;
  for (const { message, index } of boundaries) {
    selected = cut(index);
    selectedAnchor = reminderMessageAnchor(message);
    measured = tokensOf(preview(selected));
    projectedChars = measured.chars;
    if (measured.tokens <= fitTarget && measured.chars / cpt <= softFitTarget) {
      hardFit = undefined;
      break;
    }
    if (
      measured.tokens <= hardLimit &&
      (!hardFit || (Number.isFinite(softTarget) && measured.chars / cpt <= softTarget))
    )
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
    fits: measured.tokens <= hardLimit,
    projectedChars,
    ...(selectedAnchor ? { floorAnchor: selectedAnchor } : floorAnchor && held >= 0 ? { floorAnchor } : {}),
  };
}
