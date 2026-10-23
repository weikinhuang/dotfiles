/**
 * Cache-safe, token-lean delivery of the memory index.
 *
 * The cache-reminders coordinator persists one snapshot per run and replays
 * every earlier snapshot byte-for-byte. Re-emitting the full index each run
 * is cache-safe but stacks an identical copy per user turn. This module lets
 * the producer emit the full index once (fresh session, resume past a
 * compaction, after compaction) and afterwards only a small delta, or
 * nothing when the index is unchanged.
 *
 * The producer tracks a *delivered baseline*: a fingerprint of the index the
 * model has already seen. It is advanced only when the coordinator confirms
 * a capture (so an aborted request never desyncs it) and when the model
 * mutates memory itself (the tool result already told it). The baseline is
 * persisted as a tiny `memory-delivery` branch entry so resume and `/tree`
 * reconstruct it; a compaction later on the branch invalidates it, and so
 * does a request whose projected context no longer carries a full index
 * (e.g. a rolling context window cut the turn that held it).
 *
 * A baseline built from a *truncated* full index (the cap hid entries) is
 * marked so any later change resends the full index: a delta could not
 * re-balance the cap, so hidden entries would otherwise stay hidden.
 *
 * No pi imports.
 */

import { createHash } from 'node:crypto';

import type { MemoryEntry, MemoryIndex } from '../memory-reducer.ts';

/** Branch custom-entry type holding a delivered baseline. */
export const MEMORY_DELIVERY_TYPE = 'memory-delivery';

/** Stable reminder id shared by full and delta bodies. */
export const MEMORY_REMINDER_ID = 'memory-index';

/** Above this many changed entries a full index is cheaper to reason about. */
export const MAX_DELTA_CHANGES = 12;

/** `scope/type/id` -> short content hash of name + description. */
export type MemoryFingerprint = Record<string, string>;

/** What the model has already been shown. */
export interface MemoryBaseline {
  fingerprint: MemoryFingerprint;
  /** The full index it came from was capped (some entries not shown). */
  truncated: boolean;
}

/** Persisted form of a {@link MemoryBaseline} (`truncated` omitted when false). */
export interface MemoryDeliveryRecord {
  fingerprint: MemoryFingerprint;
  truncated?: boolean;
}

/** A rendered full index and whether the cap left entries out. */
export interface RenderedFullIndex {
  body: string;
  truncated: boolean;
}

export function entryKey(entry: Pick<MemoryEntry, 'scope' | 'type' | 'id'>): string {
  return `${entry.scope}/${entry.type}/${entry.id}`;
}

function entryHash(entry: Pick<MemoryEntry, 'name' | 'description'>): string {
  return createHash('sha256').update(`${entry.name}\u0000${entry.description}`).digest('hex').slice(0, 12);
}

function allEntries(index: MemoryIndex): MemoryEntry[] {
  return [...index.global, ...index.project, ...index.session];
}

export function fingerprintIndex(index: MemoryIndex): MemoryFingerprint {
  const out: MemoryFingerprint = {};
  for (const e of allEntries(index)) out[entryKey(e)] = entryHash(e);
  return out;
}

/** Record a locally-made upsert in a delivered baseline (returns a copy). */
export function withEntry(fingerprint: MemoryFingerprint, entry: MemoryEntry): MemoryFingerprint {
  return { ...fingerprint, [entryKey(entry)]: entryHash(entry) };
}

/** Record a locally-made removal in a delivered baseline (returns a copy). */
export function withoutEntry(
  fingerprint: MemoryFingerprint,
  entry: Pick<MemoryEntry, 'scope' | 'type' | 'id'>,
): MemoryFingerprint {
  const next = { ...fingerprint };
  delete next[entryKey(entry)];
  return next;
}

export interface MemoryIndexDiff {
  added: MemoryEntry[];
  changed: MemoryEntry[];
  /** Keys (`scope/type/id`) no longer present. */
  removed: string[];
}

export function diffIndex(baseline: MemoryFingerprint, index: MemoryIndex): MemoryIndexDiff {
  const added: MemoryEntry[] = [];
  const changed: MemoryEntry[] = [];
  const seen = new Set<string>();
  for (const e of allEntries(index)) {
    const key = entryKey(e);
    seen.add(key);
    const prior = baseline[key];
    if (prior === undefined) added.push(e);
    else if (prior !== entryHash(e)) changed.push(e);
  }
  const removed = Object.keys(baseline)
    .filter((key) => !seen.has(key))
    .sort();
  return { added, changed, removed };
}

export function diffSize(diff: MemoryIndexDiff): number {
  return diff.added.length + diff.changed.length + diff.removed.length;
}

function deltaLine(marker: string, e: MemoryEntry): string {
  return `${marker} [${e.scope}/${e.type}] \`${e.id}\` - ${e.description}`;
}

/** Render a non-empty diff as a small `## Memory changes` block; `null` when empty. */
export function formatMemoryDelta(diff: MemoryIndexDiff): string | null {
  if (diffSize(diff) === 0) return null;
  const lines = ['## Memory changes', '', 'Since the last memory index:'];
  for (const e of diff.added) lines.push(deltaLine('+', e));
  for (const e of diff.changed) lines.push(deltaLine('~', e));
  for (const key of diff.removed) {
    const [scope, type, ...rest] = key.split('/');
    lines.push(`- [${scope}/${type}] \`${rest.join('/')}\` (removed)`);
  }
  return lines.join('\n');
}

export interface PlannedMemoryReminder {
  kind: 'full' | 'delta';
  body: string;
  /** Baseline to adopt once the coordinator confirms this body was captured. */
  baseline: MemoryBaseline;
}

/**
 * Decide what the producer should emit this request:
 *   - no baseline -> the full index (or nothing for an empty index);
 *   - baseline matches -> nothing;
 *   - small diff on a complete baseline -> a delta block;
 *   - large diff, or any diff on a truncated baseline -> the full index.
 * `renderFull` is injected so this stays independent of the index layout.
 */
export function planMemoryReminder(
  baseline: MemoryBaseline | null,
  index: MemoryIndex,
  renderFull: () => RenderedFullIndex | null,
  maxDeltaChanges: number = MAX_DELTA_CHANGES,
): PlannedMemoryReminder | null {
  const fingerprint = fingerprintIndex(index);
  if (baseline !== null) {
    const diff = diffIndex(baseline.fingerprint, index);
    const size = diffSize(diff);
    if (size === 0) return null;
    if (size <= maxDeltaChanges && !baseline.truncated) {
      const body = formatMemoryDelta(diff);
      if (body) return { kind: 'delta', body, baseline: { fingerprint, truncated: false } };
    }
  }
  const full = renderFull();
  if (!full) {
    // An empty index needs no reminder, but a baseline that still lists
    // entries must learn they were removed.
    if (baseline !== null && Object.keys(baseline.fingerprint).length > 0) {
      const delta = formatMemoryDelta(diffIndex(baseline.fingerprint, index));
      if (delta) return { kind: 'delta', body: delta, baseline: { fingerprint, truncated: false } };
    }
    return null;
  }
  return { kind: 'full', body: full.body, baseline: { fingerprint, truncated: full.truncated } };
}

/** Framed prefix of a *full* index block (a delta starts `## Memory changes`). */
const FULL_INDEX_PREFIX = `<system-reminder id="${MEMORY_REMINDER_ID}">\n## Memory\n`;

/**
 * Whether a projected request still carries a full memory index block. Used
 * to notice that context trimming (not just compaction) removed the snapshot
 * the delivered baseline relies on.
 */
export function containsFullIndex(messages: readonly unknown[]): boolean {
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content;
    if (typeof content === 'string') {
      if (content.includes(FULL_INDEX_PREFIX)) return true;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = (part as { text?: unknown } | null)?.text;
      if (typeof text === 'string' && text.includes(FULL_INDEX_PREFIX)) return true;
    }
  }
  return false;
}

function isFingerprint(value: unknown): value is MemoryFingerprint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

export function isDeliveryRecord(value: unknown): value is MemoryDeliveryRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as { fingerprint?: unknown; truncated?: unknown };
  return isFingerprint(v.fingerprint) && (v.truncated === undefined || typeof v.truncated === 'boolean');
}

/** Persisted form of a baseline. */
export function deliveryRecord(baseline: MemoryBaseline): MemoryDeliveryRecord {
  return baseline.truncated
    ? { fingerprint: baseline.fingerprint, truncated: true }
    : { fingerprint: baseline.fingerprint };
}

/**
 * Reconstruct the delivered baseline from the selected branch: the latest
 * `memory-delivery` record, unless a compaction follows it (compaction may
 * evict the snapshot that carried the full index, so start over).
 */
export function deliveryFromBranch(
  entries: readonly { type?: string; customType?: string; data?: unknown }[],
): MemoryBaseline | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === 'compaction') return null;
    if (e?.type === 'custom' && e.customType === MEMORY_DELIVERY_TYPE && isDeliveryRecord(e.data)) {
      return { fingerprint: { ...e.data.fingerprint }, truncated: e.data.truncated === true };
    }
  }
  return null;
}
