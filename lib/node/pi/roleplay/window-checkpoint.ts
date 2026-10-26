import type { ReminderMessage } from '../context-reminder.ts';
import { reminderMessageAnchor, reminderMessageKeys } from '../reminder-identity.ts';
import { isRecord } from '../shared/guards.ts';
import type { WindowState } from './window-state.ts';

export const WINDOW_CHECKPOINT_TYPE = 'roleplay-context-window-state';

export interface WindowCheckpointKey {
  cast: string;
  provider: string;
  model: string;
}

export interface WindowCheckpoint extends WindowCheckpointKey {
  version: 1;
  charsPerToken: number;
  floorAnchor?: string;
  projectedFloorAnchor?: string;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCheckpoint(value: unknown): value is WindowCheckpoint {
  return (
    isRecord(value) &&
    value.version === 1 &&
    nonemptyString(value.cast) &&
    nonemptyString(value.provider) &&
    nonemptyString(value.model) &&
    typeof value.charsPerToken === 'number' &&
    Number.isFinite(value.charsPerToken) &&
    value.charsPerToken >= 1 &&
    value.charsPerToken <= 20 &&
    (value.floorAnchor === undefined || nonemptyString(value.floorAnchor)) &&
    (value.projectedFloorAnchor === undefined || nonemptyString(value.projectedFloorAnchor))
  );
}

/** Persist stable boundaries and calibration, never array indexes or an unpaired request sample. */
export function createWindowCheckpoint(
  win: WindowState,
  messages: readonly ReminderMessage[],
  key: WindowCheckpointKey,
): WindowCheckpoint {
  const checkpoint: WindowCheckpoint = { ...key, version: 1, charsPerToken: win.charsPerToken };
  const cutoff = win.frozenFloorCutoff;
  const boundary = Number.isInteger(cutoff) && cutoff > 0 ? messages[cutoff] : undefined;
  if (boundary?.role === 'user') checkpoint.floorAnchor = reminderMessageAnchor(boundary);
  if (win.projectedFloorAnchor) checkpoint.projectedFloorAnchor = win.projectedFloorAnchor;
  return checkpoint;
}

/** Scan only the supplied active root-to-leaf branch; a newer valid key shadows older keys. */
export function restoreWindowCheckpoint(
  entries: readonly Record<string, unknown>[],
  win: WindowState,
  messages: readonly ReminderMessage[],
  key: WindowCheckpointKey,
): boolean {
  let compactedAfter = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'compaction') {
      compactedAfter = true;
      continue;
    }
    if (entry.type !== 'custom') continue;
    if (entry.customType === 'roleplay-newscene') return false;
    if (entry.customType !== WINDOW_CHECKPOINT_TYPE || !isCheckpoint(entry.data)) continue;
    const checkpoint = entry.data;
    if (checkpoint.cast !== key.cast || checkpoint.provider !== key.provider || checkpoint.model !== key.model)
      return false;
    const floor = compactedAfter
      ? -1
      : messages.findIndex((message) => reminderMessageKeys(message).includes(checkpoint.floorAnchor ?? ''));
    win.frozenFloorCutoff = floor > 0 && messages[floor].role === 'user' ? floor : 0;
    win.projectedFloorAnchor =
      !compactedAfter &&
      checkpoint.projectedFloorAnchor &&
      messages.some((message) => reminderMessageKeys(message).includes(checkpoint.projectedFloorAnchor ?? ''))
        ? checkpoint.projectedFloorAnchor
        : undefined;
    win.charsPerToken = checkpoint.charsPerToken;
    // A persisted projection may have failed before producing matching usage.
    win.lastSentEstChars = 0;
    return true;
  }
  return false;
}
