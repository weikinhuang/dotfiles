/** Stable request-item projection for run-scoped reminders, persisted as branch-local custom data. */
import { createHash } from 'node:crypto';

import { frameReminder, type ReminderMessage, type ReminderSpec } from './context-reminder.ts';
import { isRecord, isTextPart } from './shared/guards.ts';

export const REMINDER_SNAPSHOT_TYPE = 'cache-reminder-snapshot';
const SNAPSHOT_MARKER = 'cacheReminderSnapshot';

export interface ReminderSnapshot {
  anchor: string;
  timestamp: number;
  specs: { id: string; body: string }[];
}

/** Only complete standalone blocks emitted by applyContextReminder are extracted. User prose is untouched. */
function splitReminders(messages: readonly ReminderMessage[]): { clean: ReminderMessage[]; specs: ReminderSpec[] } {
  const specs: ReminderSpec[] = [];
  const clean = messages
    .filter((m) => m[SNAPSHOT_MARKER] !== true)
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

function anchorFor(message: ReminderMessage): string {
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
  return createHash('sha256')
    .update(JSON.stringify({ ...message, content }))
    .digest('hex');
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
    if (isRecord(entry) && entry.type === 'compaction') {
      snapshots.length = 0;
      continue;
    }
    if (!isRecord(entry) || entry.type !== 'custom' || entry.customType !== REMINDER_SNAPSHOT_TYPE) continue;
    const data = entry.data;
    if (
      !isRecord(data) ||
      typeof data.anchor !== 'string' ||
      typeof data.timestamp !== 'number' ||
      !Array.isArray(data.specs)
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
      });
  }
  return snapshots;
}

export interface ReminderLifecycle {
  refresh: () => void;
  restore: (snapshots: readonly ReminderSnapshot[]) => void;
  project: (messages: readonly ReminderMessage[]) => { messages: ReminderMessage[]; captured?: ReminderSnapshot };
}

/** Capture only at a run/recovery boundary. Later tool-result state changes never replace an earlier snapshot. */
export function createReminderLifecycle(): ReminderLifecycle {
  let pending = true;
  let snapshots: ReminderSnapshot[] = [];
  return {
    refresh: () => {
      pending = true;
    },
    restore: (stored) => {
      snapshots = structuredClone([...stored]);
      pending = true;
    },
    project: (messages) => {
      const { clean, specs } = splitReminders(messages);
      let captured: ReminderSnapshot | undefined;
      if (pending) {
        pending = false;
        const tail = clean.at(-1);
        const composed = composeReminderSpecs(specs);
        if (tail && composed.length > 0) {
          const anchor = anchorFor(tail);
          // Resume/retry on the same tail must not replace its already-cached snapshot.
          if (!snapshots.some((snapshot) => snapshot.anchor === anchor)) {
            captured = { anchor, timestamp: typeof tail.timestamp === 'number' ? tail.timestamp : 0, specs: composed };
            snapshots.push(captured);
          }
        }
      }
      const byAnchor = new Map(snapshots.map((snapshot) => [snapshot.anchor, snapshot]));
      const projected: ReminderMessage[] = [];
      for (const message of clean) {
        projected.push(message);
        const snapshot = byAnchor.get(anchorFor(message));
        if (!snapshot) continue;
        projected.push({
          role: 'user',
          timestamp: snapshot.timestamp,
          [SNAPSHOT_MARKER]: true,
          content: snapshot.specs.map((spec) => ({ type: 'text', text: frameReminder(spec.id, spec.body) })),
        });
      }
      return { messages: projected, ...(captured ? { captured } : {}) };
    },
  };
}
