import type { ReminderMessage } from '../context-reminder.ts';
import type { ReminderTrigger } from '../reminder-identity.ts';
import { reminderMessageKeys } from '../reminder-identity.ts';
import { isRecord } from '../shared/guards.ts';
import { castSlug } from './store.ts';

export const CAST_CHANGE_TYPE = 'roleplay-cast-change';
export const CAST_OVERRIDE_TYPE = 'roleplay-cast-override';
export const NEW_SCENE_TYPE = 'roleplay-newscene';

export interface SceneBoundary {
  cast?: string;
  fromEntryId?: string;
  afterEntryId?: string;
  afterKeys?: string[];
  override?: string | null;
}

export function isSceneBoundary(entry: Record<string, unknown>): boolean {
  return entry.type === 'custom' && (entry.customType === CAST_CHANGE_TYPE || entry.customType === NEW_SCENE_TYPE);
}

/** The newest boundary applies to the active scene, including legacy unkeyed newscene markers. */
export function latestSceneBoundary(entries: readonly Record<string, unknown>[]): Record<string, unknown> | undefined {
  return entries.findLast(isSceneBoundary);
}

/** A reset must not inherit a carry-over recreated by another same-cast session after the archive. */
export function canSeedScene(entries: readonly Record<string, unknown>[]): boolean {
  return latestSceneBoundary(entries)?.customType !== NEW_SCENE_TYPE;
}

export function recordedCast(entries: readonly Record<string, unknown>[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type !== 'custom' ||
      typeof entry.customType !== 'string' ||
      !entry.customType.startsWith('roleplay-') ||
      !isRecord(entry.data)
    )
      continue;
    if (typeof entry.data.cast === 'string' && entry.data.cast.length > 0) return entry.data.cast;
  }
  return null;
}

/**
 * The newest persisted `/roleplay cast` override on the branch, or `null`.
 * The stored value is re-slugged with {@link castSlug} (idempotent for the
 * slugs the extension writes) because it becomes a path segment under
 * `casts/`: a crafted or foreign session entry such as `../..` must not
 * escape the cast store. A blank override reads as none.
 */
export function restoreCastOverride(entries: readonly Record<string, unknown>[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type !== 'custom' ||
      (entry.customType !== CAST_CHANGE_TYPE && entry.customType !== CAST_OVERRIDE_TYPE) ||
      !isRecord(entry.data)
    )
      continue;
    if (typeof entry.data.override === 'string') {
      return entry.data.override.trim().length > 0 ? castSlug(entry.data.override) : null;
    }
    if (entry.data.override === null) return null;
  }
  return null;
}

function narrativeEntry(entry: Record<string, unknown>, trigger: ReminderTrigger): boolean {
  if (trigger.messageType === 'user')
    return entry.type === 'message' && isRecord(entry.message) && entry.message.role === 'user';
  return entry.type === 'custom_message' && entry.customType === trigger.customType;
}

/** Commands start after existing messages; a persona switch during before_agent_start includes its initiating input. */
export function createSceneBoundary(
  cast: string,
  entries: readonly Record<string, unknown>[],
  messages: readonly ReminderMessage[],
  trigger?: ReminderTrigger,
  override?: string | null,
): SceneBoundary {
  const boundary: SceneBoundary = { cast, ...(override !== undefined ? { override } : {}) };
  const source = trigger
    ? entries.findLast((entry) => narrativeEntry(entry, trigger))
    : entries.findLast(
        (entry) => entry.type === 'message' || entry.type === 'custom_message' || entry.type === 'compaction',
      );
  if (typeof source?.id === 'string') {
    if (trigger) boundary.fromEntryId = source.id;
    else boundary.afterEntryId = source.id;
  }
  const prior = messages.findLast(
    (message) => message.role === 'user' || (message.role === 'custom' && message.customType === 'scheduled-prompt'),
  );
  if (prior) boundary.afterKeys = reminderMessageKeys(prior);
  return boundary;
}

function sourceId(message: ReminderMessage): string | undefined {
  for (const key of reminderMessageKeys(message)) {
    const match = /^entry:(.+):\d+$/.exec(key);
    if (match) return match[1];
  }
  return undefined;
}

/** Apply the scene boundary before recaps, lore scans and window arithmetic, retaining the system head. */
export function sceneMessages<M extends ReminderMessage>(
  messages: readonly M[],
  entries: readonly Record<string, unknown>[],
): M[] {
  const marker = latestSceneBoundary(entries);
  if (!marker || !isRecord(marker.data)) return [...messages];
  const data = marker.data;
  let cutoff = -1;
  if (typeof data.fromEntryId === 'string')
    cutoff = messages.findIndex((message) => sourceId(message) === data.fromEntryId);
  if (cutoff < 0 && typeof data.afterEntryId === 'string') {
    const last = messages.findLastIndex((message) => sourceId(message) === data.afterEntryId);
    if (last >= 0) cutoff = last + 1;
  }
  if (cutoff < 0 && Array.isArray(data.afterKeys)) {
    const keys = new Set((data.afterKeys as unknown[]).filter((key): key is string => typeof key === 'string'));
    const prior = messages.findLastIndex((message) => reminderMessageKeys(message).some((key) => keys.has(key)));
    if (prior >= 0) {
      const next = messages.findIndex(
        (message, index) =>
          index > prior &&
          (message.role === 'user' || (message.role === 'custom' && message.customType === 'scheduled-prompt')),
      );
      cutoff = next >= 0 ? next : messages.length;
    }
  }
  if (cutoff >= 0) return messages.filter((message, index) => message.role === 'system' || index >= cutoff);
  // A compaction can remove the saved anchor. Persisted provenance still identifies older messages.
  const positions = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    if (typeof entry.id === 'string') positions.set(entry.id, index);
  }
  const anchor = typeof data.fromEntryId === 'string' ? data.fromEntryId : data.afterEntryId;
  const edge = typeof anchor === 'string' ? positions.get(anchor) : undefined;
  const boundaryIndex = edge ?? entries.indexOf(marker);
  return messages.filter((message) => {
    if (message.role === 'system') return true;
    const id = sourceId(message);
    const position = id ? positions.get(id) : undefined;
    return (
      position === undefined ||
      (edge !== undefined && data.fromEntryId ? position >= boundaryIndex : position > boundaryIndex)
    );
  });
}
