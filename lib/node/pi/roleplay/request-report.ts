/** Privacy-safe request diagnostics. Only `metadata` may be persisted; `content` is transient. */
import { isProducerReminderBlock, type ReminderMessage } from '../context-reminder.ts';
import { extractContentText } from '../message-text.ts';
import { reminderRequestChars } from '../reminder-budget.ts';
import { reminderMessageKeys } from '../reminder-identity.ts';
import { truncate } from '../shared.ts';
import { isRecord } from '../shared/guards.ts';
import { promptInputTokens, RECAP_PREFIX, TIMELINE_PREFIX } from './context-window.ts';
import { escapeRoleplayReportText } from './report-text.ts';

const CATEGORIES = [
  'system',
  'tools',
  'conversation',
  'recap',
  'timeline',
  'lore',
  'depth',
  'scene-fold',
  'memory',
  'other-reminder',
] as const;
export type RoleplayRequestCategory = (typeof CATEGORIES)[number];
const SECTIONS = [...CATEGORIES, 'head', 'tail'] as const;
export type RoleplayRequestSectionName = (typeof SECTIONS)[number];
const OUTCOMES = ['projected', 'attempted', 'completed', 'failed', 'aborted'] as const;
const REQUEST_KINDS = ['narrative', 'continuation'] as const;

/** Caller-associated request facts, independent of context-window state. */
export interface RoleplayRequestFacts {
  outcome?: (typeof OUTCOMES)[number];
  requestKind?: (typeof REQUEST_KINDS)[number];
  createdAt?: number;
  estimatedInputTokens?: number;
}
const ROLES = ['system', 'user', 'assistant', 'custom', 'tool', 'toolResult', 'other'] as const;
export type RoleplayRequestRole = (typeof ROLES)[number];
const SNAPSHOTS = ['current', 'historical', 'unknown', 'not-snapshot'] as const;
const CONFIG_KEYS = [
  'windowTokens',
  'charBudget',
  'loreCharBudget',
  'recapStride',
  'recapMaxAdvance',
  'summarizeEnabled',
  'contextWindowEnabled',
  'depthLoreInlineTail',
  'toolsEnabled',
  'promptTokenTarget',
  'pinSceneOpener',
  'pinSceneOpenerReply',
  'keepTurns',
  'recapChunk',
  'capture',
  'timeline',
  'recapAsync',
] as const;
export type RoleplayRequestConfig = Partial<
  Record<Exclude<(typeof CONFIG_KEYS)[number], 'recapAsync'>, number | boolean>
> & { recapAsync?: boolean | null };
const CONFIG_SOURCES = ['default', 'environment', 'user', 'project', 'branch', 'model', 'runtime'] as const;
export type RoleplayRequestConfigSources = Partial<
  Record<(typeof CONFIG_KEYS)[number], (typeof CONFIG_SOURCES)[number]>
>;

export interface RoleplayRequestRow {
  /** One-based ordinal in the final projection, never a message or tool ID. */
  ordinal: number;
  role: RoleplayRequestRole;
  category: RoleplayRequestCategory;
  /** One-based genuine user narrative ordinal; replies/tools/custom inputs share the preceding turn. */
  sceneTurn: number | null;
  /** Visible text characters only, not a token count or serialized payload size. */
  chars: number;
  snapshot: (typeof SNAPSHOTS)[number];
  afterLatestUser: boolean;
  /** Exclusive visible-text component counts, never producer IDs or source text. */
  components?: { category: RoleplayRequestCategory; chars: number }[];
}

export interface RoleplayRequestTextMetadata {
  available: boolean;
  chars: number;
  coveredFrom: number | null;
  coveredTo: number | null;
}

export interface RoleplayRequestMetadata extends RoleplayRequestFacts {
  version: 1;
  turnOrdinal: number;
  requestOrdinal: number;
  /** Character-footprint estimates from reminder-budget, including non-text estimates. Buckets are exclusive. */
  totals: {
    requestChars: number;
    systemChars: number;
    toolsChars: number;
    conversationChars: number;
    reminderChars: number;
  };
  rows: RoleplayRequestRow[];
  omittedRows?: number;
  head: RoleplayRequestRow | null;
  tail: RoleplayRequestRow | null;
  recap: RoleplayRequestTextMetadata;
  timeline: RoleplayRequestTextMetadata;
  config: RoleplayRequestConfig;
  configSources?: RoleplayRequestConfigSources;
  provider?: string;
  model?: string;
  /** Reported by the provider for this exact caller-associated request, not estimated. */
  reportedInputTokens?: number;
  reportedCacheReadTokens?: number;
  reportedCacheWriteTokens?: number;
  reportedOutputTokens?: number;
  generation?: Partial<
    Record<
      | 'temperature'
      | 'top_p'
      | 'top_k'
      | 'min_p'
      | 'repeat_penalty'
      | 'presence_penalty'
      | 'frequency_penalty'
      | 'max_tokens'
      | 'max_output_tokens',
      number
    >
  >;
}

export interface RoleplayRequestSection {
  status: 'available' | 'truncated' | 'unavailable';
  text: string;
  /** Supplemental text was supplied separately and is not an extra request budget charge. */
  source?: 'request' | 'supplemental';
}
export interface RoleplayRequestContent {
  sections: Record<RoleplayRequestSectionName, RoleplayRequestSection>;
}

export interface CaptureRoleplayRequestInput extends RoleplayRequestFacts {
  messages: readonly ReminderMessage[];
  scene: readonly ReminderMessage[];
  systemPrompt?: string;
  turnOrdinal: number;
  requestOrdinal: number;
  /** Stable reminder identity of the initiating turn. Never emitted. */
  origin?: string;
  recap?: { text?: string; coveredFrom?: number; coveredTo?: number };
  timeline?: { text?: string; coveredFrom?: number; coveredTo?: number };
  config?: RoleplayRequestConfig;
  configSources?: RoleplayRequestConfigSources;
  provider?: string;
  model?: string;
  /** Per-section text cap, default 16 Ki characters, hard ceiling 64 Ki. */
  sectionChars?: number;
}

function ordinal(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeConfig(value: unknown): RoleplayRequestConfig {
  const result: RoleplayRequestConfig = {};
  if (!isRecord(value)) return result;
  for (const key of CONFIG_KEYS) {
    const field = value[key];
    if (key === 'recapAsync') {
      if (typeof field === 'boolean' || field === null) result.recapAsync = field;
    } else if (typeof field === 'boolean' || (typeof field === 'number' && Number.isFinite(field) && field >= 0))
      result[key] = field;
  }
  return result;
}

function safeConfigSources(value: unknown): RoleplayRequestConfigSources | undefined {
  if (!isRecord(value)) return undefined;
  const result: RoleplayRequestConfigSources = {};
  for (const key of CONFIG_KEYS)
    if (CONFIG_SOURCES.includes(value[key] as (typeof CONFIG_SOURCES)[number]))
      result[key] = value[key] as (typeof CONFIG_SOURCES)[number];
  return Object.keys(result).length ? result : undefined;
}

function safeIdentifier(value: unknown, kind: 'provider' | 'model'): string | undefined {
  if (typeof value !== 'string') return undefined;
  const pattern =
    kind === 'provider'
      ? /^(?:anthropic|openai|google|google-vertex|amazon-bedrock|azure-openai|mistral|groq|xai|openrouter|ollama|llama-cpp)$/
      : /^(?:claude-|gpt-|chatgpt-|o[134](?:-|$)|gemini-|llama-?|gemma-?|mistral-|qwen-?|deepseek-|grok-)[a-z0-9][a-z0-9._:-]{0,79}$/;
  return pattern.test(value) ? value : undefined;
}

export function roleplayModelIdentity(value: unknown): Pick<RoleplayRequestMetadata, 'provider' | 'model'> {
  if (!isRecord(value)) return {};
  const provider = safeIdentifier(value.provider, 'provider');
  const model = safeIdentifier(value.id, 'model');
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}

function textMetadata(input?: CaptureRoleplayRequestInput['recap']): RoleplayRequestTextMetadata {
  return {
    available: typeof input?.text === 'string',
    chars: input?.text?.length ?? 0,
    coveredFrom: ordinal(input?.coveredFrom),
    coveredTo: ordinal(input?.coveredTo),
  };
}

function safeFacts(value: unknown): RoleplayRequestFacts {
  if (!isRecord(value)) return {};
  return {
    ...(OUTCOMES.includes(value.outcome as NonNullable<RoleplayRequestFacts['outcome']>)
      ? { outcome: value.outcome as RoleplayRequestFacts['outcome'] }
      : {}),
    ...(REQUEST_KINDS.includes(value.requestKind as NonNullable<RoleplayRequestFacts['requestKind']>)
      ? { requestKind: value.requestKind as RoleplayRequestFacts['requestKind'] }
      : {}),
    ...(typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) && value.createdAt >= 0
      ? { createdAt: value.createdAt }
      : {}),
    ...(ordinal(value.estimatedInputTokens) !== null
      ? { estimatedInputTokens: value.estimatedInputTokens as number }
      : {}),
  };
}

/** Fixed numeric request options only; never retain an arbitrary provider payload. */
export function roleplayGenerationOptions(value: unknown): RoleplayRequestMetadata['generation'] {
  if (!isRecord(value)) return undefined;
  const result: NonNullable<RoleplayRequestMetadata['generation']> = {};
  for (const key of [
    'temperature',
    'top_p',
    'top_k',
    'min_p',
    'repeat_penalty',
    'presence_penalty',
    'frequency_penalty',
    'max_tokens',
    'max_output_tokens',
  ] as const) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) result[key] = value[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function genuineUser(message: ReminderMessage): boolean {
  return (
    message.role === 'user' &&
    message.cacheReminderSnapshot !== true &&
    message.customType === undefined &&
    message.startup !== true
  );
}

const PRODUCERS: Record<string, RoleplayRequestCategory> = {
  'roleplay-lore': 'lore',
  'roleplay-depth': 'depth',
  'roleplay-scene-fold': 'scene-fold',
  'memory-index': 'memory',
  'memory-capture': 'memory',
  memory: 'memory',
  'roleplay-recap': 'recap',
  'roleplay-timeline': 'timeline',
};

/** Only call on managed snapshots or explicitly producer-marked blocks, never unmarked user text. */
function managedParts(text: string): { category: RoleplayRequestCategory; text: string }[] {
  const parts: { category: RoleplayRequestCategory; text: string }[] = [];
  let end = 0;
  for (const match of text.matchAll(/<system-reminder id="([a-z0-9-]+)">\n[\s\S]*?\n<\/system-reminder>/g)) {
    if (match.index > end) parts.push({ category: 'other-reminder', text: text.slice(end, match.index) });
    const category = Object.hasOwn(PRODUCERS, match[1]) ? PRODUCERS[match[1]] : 'other-reminder';
    parts.push({ category, text: match[0] });
    end = match.index + match[0].length;
  }
  if (end < text.length || parts.length === 0)
    parts.push({
      category: end === 0 && /^(?:\[Author's note:|\[Lore)/.test(text) ? 'depth' : 'other-reminder',
      text: text.slice(end),
    });
  return parts;
}

function reminderCategory(message: ReminderMessage, text: string): RoleplayRequestCategory {
  if (message.role === 'system') return 'system';
  if (message.role === 'tool' || message.role === 'toolResult') return 'tools';
  if (
    message.role === 'assistant' &&
    !text &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === 'toolCall')
  )
    return 'tools';
  if (message.customType === 'roleplay-recap') return 'recap';
  if (message.customType === 'roleplay-timeline') return 'timeline';
  if (message.cacheReminderSnapshot !== true) return 'conversation';
  const categories = new Set(
    managedParts(text)
      .filter((part) => part.text.trim())
      .map((part) => part.category),
  );
  return categories.size === 1 ? [...categories][0] : 'other-reminder';
}

function withoutTools(message: ReminderMessage): ReminderMessage {
  return { ...message, tools: undefined, toolsAdded: undefined, toolsRemoved: undefined };
}

function visibleText(message: ReminderMessage): string {
  if (message.content !== undefined) return extractContentText(message.content);
  return typeof message.summary === 'string'
    ? message.summary
    : typeof message.output === 'string'
      ? message.output
      : '';
}

/** Header-shaped credentials are never retained, even in opt-in text snapshots. No payload object serialization. */
function redactHeaders(text: string): string {
  return text.replace(
    /\b(?:authorization|proxy-authorization|x-api-key|api-key)\s*["']?\s*[:=][^\r\n]*/gi,
    '[auth header redacted]',
  );
}

function sectionLimit(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(65536, Math.max(0, Math.floor(value))) : 16384;
}

function boundedEdges(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '\n[...]\n';
  if (limit <= marker.length) return truncate(text, limit);
  const room = limit - marker.length;
  const tail = Math.floor(room / 2);
  return text.slice(0, Math.ceil(room / 2)) + marker + (tail ? text.slice(-tail) : '');
}

export function captureRoleplayRequest(input: CaptureRoleplayRequestInput): {
  metadata: RoleplayRequestMetadata;
  content: RoleplayRequestContent;
} {
  const scene = input.scene.filter((message) => message.role !== 'system' && message.cacheReminderSnapshot !== true);
  let turn = 0;
  const sceneTurns = scene.map((message) => {
    if (genuineUser(message)) turn++;
    return turn || null;
  });
  const sceneKeys = scene.map(reminderMessageKeys);
  const resolve = (keys: readonly string[]): number | null => {
    // Stable entry identities precede content fallbacks. Repeated identical text must not erase a unique entry match.
    for (const key of keys) {
      const matches = sceneKeys.flatMap((source, index) => (source.includes(key) ? [sceneTurns[index]] : []));
      if (matches.length === 1) return matches[0];
    }
    return null;
  };
  const originTurn = input.origin ? resolve([input.origin]) : null;
  const boundOrigin = input.origin
    ? input.messages.findIndex((message) => reminderMessageKeys(message).includes(input.origin!))
    : -1;
  const latestUser = boundOrigin >= 0 ? boundOrigin : input.messages.findLastIndex(genuineUser);
  const limit = sectionLimit(input.sectionChars);
  const sections = Object.fromEntries(
    SECTIONS.map((category) => [category, { status: 'unavailable', text: '' }]),
  ) as RoleplayRequestContent['sections'];
  // Append incrementally so retained content is bounded even for a very large transcript.
  const append = (category: RoleplayRequestSectionName, raw: string): void => {
    const section = sections[category];
    const text = redactHeaders(raw);
    if (section.status === 'truncated' || (text.length === 0 && section.status === 'available')) return;
    const joined = section.text.length > 0 ? section.text + '\n\n' + text : text;
    section.text = truncate(joined, limit);
    section.status = joined.length > limit ? 'truncated' : 'available';
    section.source = 'request';
  };
  const boundary = (category: 'head' | 'tail', raw: string): void => {
    const text = redactHeaders(raw);
    sections[category] = {
      status: text.length > limit ? 'truncated' : 'available',
      text: boundedEdges(text, limit),
      source: 'request',
    };
  };
  const firstUser = input.messages.findIndex(
    (message) => (message.role === 'user' || message.role === 'custom') && message.cacheReminderSnapshot !== true,
  );
  let conversationChars = 0;
  let reminderChars = 0;
  const rows = input.messages.map((message, index): RoleplayRequestRow => {
    const text = visibleText(message);
    let category = reminderCategory(message, text);
    let sceneTurn = message.cacheReminderSnapshot === true ? null : resolve(reminderMessageKeys(message));
    let snapshot: RoleplayRequestRow['snapshot'] = 'not-snapshot';
    if (message.cacheReminderSnapshot === true) {
      snapshot = 'unknown';
      // The coordinator's snapshot timestamp is the trigger timestamp. Only trust unique matches.
      const origins = scene.flatMap((source, position) =>
        source.timestamp === message.timestamp &&
        typeof message.timestamp === 'number' &&
        (source.role === 'user' || source.role === 'custom')
          ? [sceneTurns[position]]
          : [],
      );
      if (origins.length === 1) {
        sceneTurn = origins[0];
        if (originTurn !== null && sceneTurn !== null)
          snapshot = sceneTurn === originTurn ? 'current' : sceneTurn < originTurn ? 'historical' : 'unknown';
      }
    }
    let parts = message.cacheReminderSnapshot === true ? managedParts(text) : [{ category, text }];
    if (
      category === 'conversation' &&
      Array.isArray(message.content) &&
      message.content.some(isProducerReminderBlock)
    ) {
      parts = message.content.flatMap((block) =>
        isProducerReminderBlock(block)
          ? managedParts(extractContentText([block]))
          : [{ category, text: extractContentText([block]) }],
      );
    }
    // Split only exact caller-supplied framed prefixes on the first input, never a lookalike elsewhere.
    if (category === 'conversation' && (index === firstUser || message.roleplaySceneMemory === true)) {
      let remaining = parts[0]?.text ?? '';
      const prefixes: typeof parts = [];
      for (let pass = 0; pass < 2; pass++) {
        const found = (['recap', 'timeline'] as const).find((key) => {
          const supplied = input[key]?.text?.trim();
          const prefix = key === 'recap' ? RECAP_PREFIX : TIMELINE_PREFIX;
          const framed = `${prefix}\n${supplied}\n]`;
          return supplied && (remaining === framed || remaining.startsWith(`${framed}\n\n`));
        });
        if (!found) break;
        const prefix = found === 'recap' ? RECAP_PREFIX : TIMELINE_PREFIX;
        const base = `${prefix}\n${input[found]!.text!.trim()}\n]`;
        const framed = remaining.startsWith(`${base}\n\n`) ? `${base}\n\n` : base;
        prefixes.push({ category: found, text: framed });
        remaining = remaining.slice(framed.length);
      }
      if (prefixes.length) parts = [...prefixes, { category, text: remaining }, ...parts.slice(1)];
    }
    if (category === 'conversation' && !parts.some((part) => part.category === 'conversation' && part.text.length > 0))
      category = parts.find((part) => part.category !== 'conversation')?.category ?? category;
    const components = CATEGORIES.flatMap((category) => {
      const selected = parts.filter((part) => part.category === category);
      return selected.length ? [{ category, chars: selected.reduce((sum, part) => sum + part.text.length, 0) }] : [];
    });
    if (category !== 'system' && category !== 'tools') {
      const chars = reminderRequestChars([withoutTools(message)]);
      if (category === 'conversation') {
        const managedChars = Math.min(
          chars,
          components.filter((part) => part.category !== 'conversation').reduce((sum, part) => sum + part.chars, 0),
        );
        conversationChars += chars - managedChars;
        reminderChars += managedChars;
      } else reminderChars += chars;
    }
    if (category !== 'system') for (const part of parts) append(part.category, part.text);
    if (category === 'conversation') {
      const realText = parts
        .filter((part) => part.category === 'conversation')
        .map((part) => part.text)
        .join('\n');
      if (sections.head.status === 'unavailable') boundary('head', realText);
      boundary('tail', realText);
    }
    return {
      ordinal: index + 1,
      role: ROLES.includes(message.role as RoleplayRequestRole) ? (message.role as RoleplayRequestRole) : 'other',
      category,
      sceneTurn,
      chars: text.length,
      snapshot,
      afterLatestUser: latestUser >= 0 && index > latestUser,
      ...(message.cacheReminderSnapshot === true || parts.length > 1 ? { components } : {}),
    };
  });
  const systems = input.messages.filter((message) => message.role === 'system');
  const systemChars = reminderRequestChars(systems.map(withoutTools), input.systemPrompt);
  const requestChars = reminderRequestChars(input.messages, input.systemPrompt);
  // The remainder includes effective tool declarations and tool-result messages, never charged twice.
  const toolsChars = Math.max(0, requestChars - systemChars - conversationChars - reminderChars);
  if (input.systemPrompt !== undefined) append('system', input.systemPrompt);
  else {
    const effectiveSections = new Map<string, string>();
    for (const message of systems) {
      append('system', visibleText(message));
      if (isRecord(message.sections))
        for (const [key, value] of Object.entries(message.sections)) {
          if (typeof value === 'string') effectiveSections.set(key, value);
          else if (value === null || value === undefined) effectiveSections.delete(key);
        }
    }
    for (const text of effectiveSections.values()) append('system', text);
  }
  // These texts are supplemental snapshots, not additional request messages or budget charges.
  for (const key of ['recap', 'timeline'] as const) {
    const supplemental = input[key]?.text;
    if (supplemental !== undefined && sections[key].status === 'unavailable') {
      append(key, supplemental);
      sections[key].source = 'supplemental';
    }
  }
  const conversation = rows.filter((row) => row.category === 'conversation');
  const provider = safeIdentifier(input.provider, 'provider');
  const model = safeIdentifier(input.model, 'model');
  const metadata: RoleplayRequestMetadata = {
    version: 1,
    turnOrdinal: ordinal(input.turnOrdinal) ?? 0,
    requestOrdinal: ordinal(input.requestOrdinal) ?? 0,
    totals: { requestChars, systemChars, toolsChars, conversationChars, reminderChars },
    rows: rows.length > 256 ? [...rows.slice(0, 128), ...rows.slice(-128)] : rows,
    ...(rows.length > 256 ? { omittedRows: rows.length - 256 } : {}),
    head: conversation[0] ? { ...conversation[0] } : null,
    tail: conversation.at(-1) ? { ...conversation.at(-1)! } : null,
    recap: textMetadata(input.recap),
    timeline: textMetadata(input.timeline),
    config: safeConfig(input.config),
    ...(safeConfigSources(input.configSources) ? { configSources: safeConfigSources(input.configSources) } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...safeFacts(input),
  };
  return { metadata, content: { sections } };
}

function readRow(value: unknown): RoleplayRequestRow | null {
  if (
    !isRecord(value) ||
    ordinal(value.ordinal) === null ||
    !ROLES.includes(value.role as RoleplayRequestRole) ||
    !CATEGORIES.includes(value.category as RoleplayRequestCategory) ||
    (value.sceneTurn !== null && ordinal(value.sceneTurn) === null) ||
    ordinal(value.chars) === null ||
    !SNAPSHOTS.includes(value.snapshot as RoleplayRequestRow['snapshot']) ||
    typeof value.afterLatestUser !== 'boolean'
  )
    return null;
  let components: RoleplayRequestRow['components'];
  if (value.components !== undefined) {
    if (!Array.isArray(value.components)) return null;
    components = [];
    for (const part of value.components as unknown[]) {
      if (
        !isRecord(part) ||
        !CATEGORIES.includes(part.category as RoleplayRequestCategory) ||
        ordinal(part.chars) === null
      )
        return null;
      components.push({ category: part.category as RoleplayRequestCategory, chars: part.chars as number });
    }
  }
  return {
    ordinal: value.ordinal as number,
    role: value.role as RoleplayRequestRole,
    category: value.category as RoleplayRequestCategory,
    sceneTurn: value.sceneTurn as number | null,
    chars: value.chars as number,
    snapshot: value.snapshot as RoleplayRequestRow['snapshot'],
    afterLatestUser: value.afterLatestUser,
    ...(components ? { components } : {}),
  };
}

function readTextMetadata(value: unknown): RoleplayRequestTextMetadata | null {
  if (
    !isRecord(value) ||
    typeof value.available !== 'boolean' ||
    ordinal(value.chars) === null ||
    (value.coveredFrom !== null && ordinal(value.coveredFrom) === null) ||
    (value.coveredTo !== null && ordinal(value.coveredTo) === null)
  )
    return null;
  return {
    available: value.available,
    chars: value.chars as number,
    coveredFrom: value.coveredFrom as number | null,
    coveredTo: value.coveredTo as number | null,
  };
}

/** Rebuild the allowlist rather than trusting persisted objects. Unknown properties are discarded at every level. */
export function readRoleplayRequestMetadata(value: unknown): RoleplayRequestMetadata | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    ordinal(value.turnOrdinal) === null ||
    ordinal(value.requestOrdinal) === null ||
    !Array.isArray(value.rows) ||
    !isRecord(value.totals)
  )
    return null;
  const rows = (value.rows as unknown[]).map(readRow);
  if (rows.some((row) => row === null)) return null;
  const totals = value.totals;
  const totalKeys = ['requestChars', 'systemChars', 'toolsChars', 'conversationChars', 'reminderChars'] as const;
  if (totalKeys.some((key) => ordinal(totals[key]) === null)) return null;
  const recap = readTextMetadata(value.recap);
  const timeline = readTextMetadata(value.timeline);
  if (!recap || !timeline) return null;
  const conversation = (rows as RoleplayRequestRow[]).filter((row) => row.category === 'conversation');
  const provider = safeIdentifier(value.provider, 'provider');
  const model = safeIdentifier(value.model, 'model');
  return {
    version: 1,
    turnOrdinal: value.turnOrdinal as number,
    requestOrdinal: value.requestOrdinal as number,
    totals: {
      requestChars: totals.requestChars as number,
      systemChars: totals.systemChars as number,
      toolsChars: totals.toolsChars as number,
      conversationChars: totals.conversationChars as number,
      reminderChars: totals.reminderChars as number,
    },
    rows: rows as RoleplayRequestRow[],
    head:
      readRow(value.head)?.category === 'conversation'
        ? readRow(value.head)
        : conversation[0]
          ? { ...conversation[0] }
          : null,
    tail:
      readRow(value.tail)?.category === 'conversation'
        ? readRow(value.tail)
        : conversation.at(-1)
          ? { ...conversation.at(-1)! }
          : null,
    ...(ordinal(value.omittedRows) !== null ? { omittedRows: value.omittedRows as number } : {}),
    recap,
    timeline,
    config: safeConfig(value.config),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...safeFacts(value),
    ...(safeConfigSources(value.configSources) ? { configSources: safeConfigSources(value.configSources) } : {}),
    ...(ordinal(value.reportedInputTokens) !== null
      ? { reportedInputTokens: value.reportedInputTokens as number }
      : {}),
    ...(ordinal(value.reportedCacheReadTokens) !== null
      ? { reportedCacheReadTokens: value.reportedCacheReadTokens as number }
      : {}),
    ...(ordinal(value.reportedCacheWriteTokens) !== null
      ? { reportedCacheWriteTokens: value.reportedCacheWriteTokens as number }
      : {}),
    ...(ordinal(value.reportedOutputTokens) !== null
      ? { reportedOutputTokens: value.reportedOutputTokens as number }
      : {}),
    ...(roleplayGenerationOptions(value.generation) ? { generation: roleplayGenerationOptions(value.generation) } : {}),
  };
}

export interface FormatRoleplayRequestOptions {
  json?: boolean;
  snippets?: boolean;
  section?: RoleplayRequestSectionName;
  /** Section text requires this explicit flag. JSON is always metadata-only. */
  content?: boolean;
  snippetChars?: number;
}

export function formatRoleplayRequest(
  metadata: unknown,
  content?: RoleplayRequestContent,
  options: FormatRoleplayRequestOptions = {},
): string {
  const safe = readRoleplayRequestMetadata(metadata);
  if (!safe) return 'Roleplay request metadata unavailable.';
  if (options.json) return JSON.stringify(safe, null, 2);
  const totals = safe.totals;
  const lines = [
    `Roleplay request: turn ${safe.turnOrdinal}, request ${safe.requestOrdinal}`,
    `Estimated character footprint: ${totals.requestChars} (not exact tokens)`,
    `system=${totals.systemChars} tools=${totals.toolsChars} conversation=${totals.conversationChars} reminders=${totals.reminderChars}`,
    `Conversation head: ${safe.head ? `#${safe.head.ordinal} scene turn ${safe.head.sceneTurn ?? 'unavailable'}` : 'unavailable'}`,
    `Conversation tail: ${safe.tail ? `#${safe.tail.ordinal} scene turn ${safe.tail.sceneTurn ?? 'unavailable'}` : 'unavailable'}`,
    `Recap: ${safe.recap.available ? `${safe.recap.chars} chars` : 'unavailable'}; timeline: ${safe.timeline.available ? `${safe.timeline.chars} chars` : 'unavailable'}`,
    ...(safe.provider || safe.model
      ? [`Model: ${safe.provider ?? 'unavailable'} / ${safe.model ?? 'unavailable'}`]
      : []),
    ...(safe.outcome || safe.requestKind
      ? [`Request: ${safe.requestKind ?? 'unavailable'}; outcome=${safe.outcome ?? 'unavailable'}`]
      : []),
    ...(safe.createdAt !== undefined ? [`Created at: ${safe.createdAt}`] : []),
    ...(safe.estimatedInputTokens !== undefined
      ? [`Estimated input tokens: ${safe.estimatedInputTokens} (caller estimate)`]
      : []),
    ...(safe.reportedInputTokens !== undefined
      ? [`Reported input tokens: ${safe.reportedInputTokens} (associated with this request)`]
      : []),
    ...(safe.reportedCacheReadTokens !== undefined
      ? [`Reported cache: read=${safe.reportedCacheReadTokens}, write=${safe.reportedCacheWriteTokens ?? 'unknown'}`]
      : []),
    ...(safe.generation ? [`Observed numeric generation options: ${JSON.stringify(safe.generation)}`] : []),
    ...(Object.keys(safe.config).length ? [`Config: ${JSON.stringify(safe.config)}`] : []),
    ...(safe.configSources ? [`Config sources: ${JSON.stringify(safe.configSources)}`] : []),
    ...safe.rows
      .filter(
        (row) =>
          !options.section ||
          row.category === options.section ||
          row.components?.some((part) => part.category === options.section) === true ||
          (options.section === 'head' && row.ordinal === safe.head?.ordinal) ||
          (options.section === 'tail' && row.ordinal === safe.tail?.ordinal),
      )
      .map(
        (row) =>
          `#${row.ordinal} ${row.role} ${row.category} scene=${row.sceneTurn ?? 'unavailable'} textChars=${row.chars} snapshot=${row.snapshot}${row.afterLatestUser ? ' after-latest-user' : ''}${row.components ? ` components=${row.components.map((part) => `${part.category}:${part.chars}`).join(',')}` : ''}`,
      ),
  ];
  if (options.snippets || (options.section && options.content)) {
    const categories = options.section ? SECTIONS.filter((category) => category === options.section) : SECTIONS;
    for (const category of categories) {
      const section = isRecord(content) && isRecord(content.sections) ? content.sections[category] : undefined;
      if (
        !isRecord(section) ||
        !['available', 'truncated'].includes(String(section.status)) ||
        typeof section.text !== 'string'
      ) {
        lines.push(`[${category}: unavailable]`);
        continue;
      }
      const limit = options.snippets ? Math.min(512, sectionLimit(options.snippetChars ?? 160)) : 65536;
      const raw = redactHeaders(section.text);
      const text = category === 'head' || category === 'tail' ? boundedEdges(raw, limit) : truncate(raw, limit);
      lines.push(
        `[${category}${section.status === 'truncated' || text.length < section.text.length ? ': truncated' : ''}]`,
        ...(section.source === 'supplemental'
          ? ['(supplemental snapshot; not an additional request budget charge)']
          : []),
        text,
      );
    }
  }
  return escapeRoleplayReportText(lines.join('\n'));
}

/** Ignore late usage from another turn/request. Only provider input/cache counts cross the allowlist. */
export function associateRoleplayRequestUsage(
  metadata: RoleplayRequestMetadata,
  association: { turnOrdinal: number; requestOrdinal: number; usage: unknown },
): RoleplayRequestMetadata {
  if (metadata.turnOrdinal !== association.turnOrdinal || metadata.requestOrdinal !== association.requestOrdinal)
    return metadata;
  const tokens = promptInputTokens(association.usage);
  if (tokens === null) return metadata;
  const usage = isRecord(association.usage) ? association.usage : {};
  return {
    ...metadata,
    reportedInputTokens: tokens,
    ...(ordinal(usage.cacheRead) !== null ? { reportedCacheReadTokens: usage.cacheRead as number } : {}),
    ...(ordinal(usage.cacheWrite) !== null ? { reportedCacheWriteTokens: usage.cacheWrite as number } : {}),
    ...(ordinal(usage.output) !== null ? { reportedOutputTokens: usage.output as number } : {}),
  };
}
