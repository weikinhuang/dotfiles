/** Stable, branch-local reminder projection. Preview never persists or acknowledges a capture. */
import { frameReminder, type ReminderMessage, type ReminderSpec } from './context-reminder.ts';
import {
  reminderMessageAnchor,
  reminderMessageKeys,
  reminderOriginIndex,
  type ReminderTrigger,
} from './reminder-identity.ts';
import { isRecord, isTextPart } from './shared/guards.ts';

export { reminderMessageAnchor } from './reminder-identity.ts';
export const REMINDER_SNAPSHOT_TYPE = 'cache-reminder-snapshot';
const SNAPSHOT_MARKER = 'cacheReminderSnapshot';
export const REMINDER_COORDINATOR = 'cache-reminders:coordinator';
export const REMINDER_CAPABILITIES = 'cache-reminders:capabilities';
export const REMINDER_SANITIZE = 'cache-reminders:sanitize';
export const REMINDER_LIMIT = 'cache-reminders:limit';
export const REMINDER_PROJECTED = 'cache-reminders:projected';

export interface ReminderCapabilities {
  context: unknown;
  sanitizerRequired: boolean;
  limiterRequired: boolean;
}
export interface ReminderSanitizeRequest {
  messages: ReminderMessage[];
  context: unknown;
  handled: boolean;
}
export interface ReminderLimitRequest {
  messages: readonly ReminderMessage[];
  context: unknown;
  origin?: string;
  preview: (messages: readonly ReminderMessage[]) => ReminderMessage[];
  result?: { messages: ReminderMessage[]; fits: boolean };
}
export interface ReminderProjectedRequest {
  messages: ReminderMessage[];
  context: unknown;
}

export interface ReminderPlacement {
  anchor: string;
  before: boolean;
  text: string;
}

export interface ReminderInsertion {
  depth: number;
  text: string;
}

export interface ReminderSnapshot {
  anchor: string;
  timestamp: number;
  specs: { id: string; body: string }[];
  placements?: ReminderPlacement[];
}

export interface PreparedReminder extends ReminderSnapshot {
  insertions?: ReminderInsertion[];
}

function isPlacementArray(value: unknown): value is ReminderPlacement[] {
  return (
    Array.isArray(value) &&
    value.every(
      (placement: unknown) =>
        isRecord(placement) &&
        typeof placement.anchor === 'string' &&
        typeof placement.before === 'boolean' &&
        typeof placement.text === 'string',
    )
  );
}

function isInsertionArray(value: unknown): value is ReminderInsertion[] {
  return (
    Array.isArray(value) &&
    value.every(
      (insertion: unknown) =>
        isRecord(insertion) &&
        typeof insertion.depth === 'number' &&
        Number.isFinite(insertion.depth) &&
        typeof insertion.text === 'string',
    )
  );
}

function splitReminders(messages: readonly ReminderMessage[]): { clean: ReminderMessage[]; specs: ReminderSpec[] } {
  const specs: ReminderSpec[] = [];
  const clean = messages
    .filter((message) => message[SNAPSHOT_MARKER] !== true)
    .map((message) => {
      if (!Array.isArray(message.content)) return message;
      const content = message.content.filter((block) => {
        if (!isTextPart(block)) return true;
        const match = /^<system-reminder id="([a-z0-9-]+)">\n([\s\S]*)\n<\/system-reminder>$/.exec(block.text);
        if (!match) return true;
        specs.push({ id: match[1], body: match[2] });
        return false;
      });
      return content.length === message.content.length ? message : Object.assign({}, message, { content });
    });
  return { clean, specs };
}

export function composeReminderSpecs(specs: readonly ReminderSpec[]): ReminderSnapshot['specs'] {
  const byId = new Map<string, string>();
  for (const spec of specs) {
    const body = spec.body?.trim();
    if (body) byId.set(spec.id, body);
  }
  return [...byId]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([id, body]) => ({ id, body }));
}

export function readReminderSnapshots(entries: readonly unknown[]): ReminderSnapshot[] {
  const snapshots: ReminderSnapshot[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== 'custom' || entry.customType !== REMINDER_SNAPSHOT_TYPE) continue;
    const data = entry.data;
    if (
      !isRecord(data) ||
      typeof data.anchor !== 'string' ||
      typeof data.timestamp !== 'number' ||
      !Number.isFinite(data.timestamp) ||
      !Array.isArray(data.specs) ||
      ('placements' in data && !isPlacementArray(data.placements))
    )
      continue;
    const valid = (data.specs as unknown[]).every(
      (spec) => isRecord(spec) && typeof spec.id === 'string' && typeof spec.body === 'string',
    );
    if (valid)
      snapshots.push({
        anchor: data.anchor,
        timestamp: data.timestamp,
        specs: structuredClone(data.specs) as ReminderSnapshot['specs'],
        ...(isPlacementArray(data.placements) ? { placements: structuredClone(data.placements) } : {}),
      });
  }
  return snapshots;
}

/** Resolve only within the conversation ending at the actual trigger, not appended startup notices. */
export function resolveReminderInsertions(
  messages: readonly ReminderMessage[],
  insertions: readonly ReminderInsertion[],
  origin: number,
): ReminderPlacement[] {
  const history = messages
    .slice(0, origin + 1)
    .filter((message) => message.role !== 'system' && message[SNAPSHOT_MARKER] !== true);
  if (history.length === 0) return [];
  return insertions.flatMap((insertion) => {
    if (!insertion.text.trim()) return [];
    let index = Math.max(0, history.length - Math.max(0, Math.floor(insertion.depth)));
    while (index > 0 && history[index]?.role === 'toolResult') index -= 1;
    const before = index < history.length;
    const target = history[before ? index : history.length - 1];
    return reminderMessageKeys(target).length === 0
      ? []
      : [{ anchor: reminderMessageAnchor(target), before, text: insertion.text }];
  });
}

function materialize(plan: PreparedReminder, messages: readonly ReminderMessage[]): ReminderSnapshot | undefined {
  const origin = messages.findIndex((message) => reminderMessageKeys(message).includes(plan.anchor));
  if (origin < 0) return undefined;
  const placements = [
    ...(plan.placements ?? []),
    ...resolveReminderInsertions(messages, plan.insertions ?? [], origin),
  ];
  return {
    anchor: plan.anchor,
    timestamp: plan.timestamp,
    specs: structuredClone(plan.specs),
    ...(placements.length > 0 ? { placements: structuredClone(placements) } : {}),
  };
}

function projectSnapshots(
  messages: readonly ReminderMessage[],
  snapshots: readonly ReminderSnapshot[],
): ReminderMessage[] {
  const keys = messages.map(reminderMessageKeys);
  const present = new Set(keys.flat());
  const before = new Map<string, ReminderMessage[]>();
  const after = new Map<string, ReminderMessage[]>();
  const append = (
    map: Map<string, ReminderMessage[]>,
    anchor: string,
    timestamp: number,
    content: ReminderMessage['content'],
  ): void => {
    const items = map.get(anchor) ?? [];
    items.push({ role: 'user', timestamp, [SNAPSHOT_MARKER]: true, content });
    map.set(anchor, items);
  };
  for (const snapshot of snapshots) {
    if (!present.has(snapshot.anchor)) continue;
    if (snapshot.specs.length > 0)
      append(
        after,
        snapshot.anchor,
        snapshot.timestamp,
        snapshot.specs.map((spec) => ({ type: 'text', text: frameReminder(spec.id, spec.body) })),
      );
    for (const placement of snapshot.placements ?? []) {
      if (present.has(placement.anchor) && placement.text.trim())
        append(placement.before ? before : after, placement.anchor, snapshot.timestamp, placement.text);
    }
  }
  return messages.flatMap((message, index) => [
    ...keys[index].flatMap((key) => before.get(key) ?? []),
    message,
    ...keys[index].flatMap((key) => after.get(key) ?? []),
  ]);
}

export interface ReminderLifecycle {
  refresh: (trigger?: ReminderTrigger) => void;
  restore: (snapshots: readonly ReminderSnapshot[]) => void;
  bindOrigin: (anchor: string | undefined) => void;
  origin: (messages: readonly ReminderMessage[]) => string | undefined;
  stagePlacements: (value: unknown) => void;
  stageInsertions: (value: unknown) => void;
  prepare: (messages: readonly ReminderMessage[]) => PreparedReminder | undefined;
  preview: (messages: readonly ReminderMessage[], prepared?: PreparedReminder) => ReminderMessage[];
  project: (
    messages: readonly ReminderMessage[],
    prepared?: PreparedReminder,
    persist?: (snapshot: ReminderSnapshot) => void,
  ) => { messages: ReminderMessage[]; captured?: ReminderSnapshot };
}

export function createReminderLifecycle(): ReminderLifecycle {
  let pending = true;
  let trigger: ReminderTrigger | undefined;
  let boundOrigin: string | undefined;
  let snapshots: ReminderSnapshot[] = [];
  let placements: ReminderPlacement[] = [];
  let insertions: ReminderInsertion[] = [];
  let frozen: PreparedReminder | null | undefined;
  const origin = (messages: readonly ReminderMessage[]): number => reminderOriginIndex(messages, trigger, boundOrigin);
  const proposal = (messages: readonly ReminderMessage[]): PreparedReminder | undefined => {
    if (!pending) return undefined;
    if (frozen !== undefined) return frozen ?? undefined;
    const { clean, specs } = splitReminders(messages);
    const index = origin(clean);
    if (index < 0) return undefined;
    const input = clean[index];
    const keys = reminderMessageKeys(input);
    if (snapshots.some((snapshot) => keys.includes(snapshot.anchor))) return undefined;
    const composed = composeReminderSpecs(specs);
    if (composed.length === 0 && placements.length === 0 && insertions.length === 0) return undefined;
    return {
      anchor: reminderMessageAnchor(input),
      timestamp: typeof input.timestamp === 'number' ? input.timestamp : 0,
      specs: composed,
      ...(placements.length > 0 ? { placements: structuredClone(placements) } : {}),
      ...(insertions.length > 0 ? { insertions: structuredClone(insertions) } : {}),
    };
  };
  const preview = (messages: readonly ReminderMessage[], prepared?: PreparedReminder): ReminderMessage[] => {
    const { clean } = splitReminders(messages);
    const candidate = prepared ?? proposal(messages);
    const snapshot = candidate ? materialize(candidate, clean) : undefined;
    return projectSnapshots(clean, snapshot ? [...snapshots, snapshot] : snapshots);
  };
  return {
    refresh: (nextTrigger) => {
      pending = true;
      trigger = nextTrigger;
      boundOrigin = undefined;
      placements = [];
      insertions = [];
      frozen = undefined;
    },
    restore: (stored) => {
      snapshots = structuredClone([...stored]);
      pending = false;
      trigger = undefined;
      boundOrigin = undefined;
      placements = [];
      insertions = [];
      frozen = undefined;
    },
    bindOrigin: (anchor) => {
      boundOrigin = anchor;
    },
    origin: (messages) => {
      const { clean } = splitReminders(messages);
      let index = origin(clean);
      if (!trigger && !boundOrigin) {
        const restored = clean.findLastIndex((message) =>
          snapshots.some((snapshot) => reminderMessageKeys(message).includes(snapshot.anchor)),
        );
        const latestUser = clean.findLastIndex((message) => message.role === 'user');
        index = Math.max(restored, latestUser);
      }
      return index < 0 ? undefined : reminderMessageAnchor(clean[index]);
    },
    stagePlacements: (value) => {
      if (pending && frozen === undefined && isPlacementArray(value)) placements = structuredClone(value);
    },
    stageInsertions: (value) => {
      if (pending && frozen === undefined && isInsertionArray(value)) insertions = structuredClone(value);
    },
    prepare: (messages) => {
      if (frozen === undefined) frozen = proposal(messages) ?? null;
      return frozen ?? undefined;
    },
    preview,
    project: (messages, prepared, persist) => {
      const { clean } = splitReminders(messages);
      const candidate = prepared ?? proposal(messages);
      const captured = pending && candidate ? materialize(candidate, clean) : undefined;
      if (captured) persist?.(structuredClone(captured));
      pending = false;
      placements = [];
      insertions = [];
      frozen = null;
      if (captured) snapshots.push(structuredClone(captured));
      return { messages: projectSnapshots(clean, snapshots), ...(captured ? { captured } : {}) };
    },
  };
}
