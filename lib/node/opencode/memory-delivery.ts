/**
 * Cache-safe delivery of the memory index into an opencode session through
 * session instruction entries (`ctx.session.instructions.entry`).
 *
 * opencode freezes a session's instruction values into an epoch baseline
 * rendered in the system prompt, and announces later puts / removals as
 * durable chronological updates at the next step boundary; a compaction
 * folds the current values into a new baseline. That is the same contract
 * pi's reminder snapshots provide, so this mirrors pi's
 * lib/node/pi/memory/delivery.ts policy with two keys:
 *
 *   - `memory-index` holds a full `## Memory` block (the baseline);
 *   - `memory-changes` holds the cumulative `## Memory changes` delta since
 *     that baseline (a put supersedes the previous delta).
 *
 * A put whose value is unchanged is a no-op in opencode, and an unchanged
 * index puts nothing. The model's own writes advance `seen` directly (the
 * tool result already told it), so deltas surface only changes made
 * elsewhere: another session, pi, or a hand edit.
 *
 * Pure module - no opencode imports.
 */

import {
  diffIndex,
  diffSize,
  fingerprintIndex,
  formatMemoryDelta,
  MAX_DELTA_CHANGES,
  type MemoryBaseline,
  type MemoryFingerprint,
  type RenderedFullIndex,
  withEntry,
  withoutEntry,
} from '../pi/memory/delivery.ts';
import { type MemoryChange } from '../pi/memory/actions.ts';
import { type MemoryIndex } from '../pi/memory-reducer.ts';

export const MEMORY_INDEX_KEY = 'memory-index';
export const MEMORY_CHANGES_KEY = 'memory-changes';

/** Per-session delivery bookkeeping (persisted in the plugin's storage). */
export interface MemoryDeliveryState {
  /** Fingerprint of the full index held in `memory-index`. */
  base: MemoryBaseline;
  /** What the model knows: base + announced delta + its own writes. */
  seen: MemoryFingerprint;
  /** `memory-index` currently holds a value. */
  indexed: boolean;
  /** `memory-changes` currently holds a value. */
  changes: boolean;
}

export type InstructionOp = { op: 'put'; key: string; value: string } | { op: 'remove'; key: string };

export interface DeliveryPlan {
  kind: 'full' | 'delta' | 'clear' | 'none';
  ops: InstructionOp[];
  next: MemoryDeliveryState;
}

export interface PlanOptions {
  /** Re-put the full index (after a compaction folded the baseline). */
  refresh?: boolean;
  maxDeltaChanges?: number;
}

export function sameFingerprint(a: MemoryFingerprint, b: MemoryFingerprint): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

const EMPTY: MemoryDeliveryState = {
  base: { fingerprint: {}, truncated: false },
  seen: {},
  indexed: false,
  changes: false,
};

/**
 * Decide which instruction-entry puts / removals bring the session up to
 * date with `index`:
 *   - nothing delivered yet, a refresh, a large diff, or any diff on a
 *     capped baseline -> put the full index (and drop a stale delta);
 *   - the model already knows this index -> nothing;
 *   - otherwise -> put the cumulative delta against the baseline.
 * `renderFull` is injected so the cap and clock stay with the caller.
 */
export function planInstructionDelivery(
  prev: MemoryDeliveryState | null,
  index: MemoryIndex,
  renderFull: () => RenderedFullIndex | null,
  opts: PlanOptions = {},
): DeliveryPlan {
  const fingerprint = fingerprintIndex(index);
  const max = opts.maxDeltaChanges ?? MAX_DELTA_CHANGES;
  if (prev?.indexed && !opts.refresh) {
    if (sameFingerprint(prev.seen, fingerprint)) return { kind: 'none', ops: [], next: prev };
    const diff = diffIndex(prev.base.fingerprint, index);
    const size = diffSize(diff);
    if (size === 0) {
      const next = { ...prev, seen: fingerprint, changes: false };
      return prev.changes
        ? { kind: 'delta', ops: [{ op: 'remove', key: MEMORY_CHANGES_KEY }], next }
        : { kind: 'none', ops: [], next };
    }
    const delta = size <= max && !prev.base.truncated ? formatMemoryDelta(diff) : null;
    if (delta) {
      return {
        kind: 'delta',
        ops: [{ op: 'put', key: MEMORY_CHANGES_KEY, value: delta }],
        next: { ...prev, seen: fingerprint, changes: true },
      };
    }
  }
  const dropChanges: InstructionOp[] = prev?.changes ? [{ op: 'remove', key: MEMORY_CHANGES_KEY }] : [];
  const full = renderFull();
  if (!full) {
    const ops: InstructionOp[] = [
      ...(prev?.indexed ? [{ op: 'remove', key: MEMORY_INDEX_KEY } as const] : []),
      ...dropChanges,
    ];
    return { kind: ops.length > 0 ? 'clear' : 'none', ops, next: EMPTY };
  }
  return {
    kind: 'full',
    ops: [{ op: 'put', key: MEMORY_INDEX_KEY, value: full.body }, ...dropChanges],
    next: { base: { fingerprint, truncated: full.truncated }, seen: fingerprint, indexed: true, changes: false },
  };
}

/** Account for the model's own write; `null` (nothing delivered yet) stays `null`. */
export function noteLocalChange(prev: MemoryDeliveryState | null, change: MemoryChange): MemoryDeliveryState | null {
  if (!prev?.indexed) return prev;
  if (change.kind === 'remove') return { ...prev, seen: withoutEntry(prev.seen, change.entry) };
  const base = change.replaced ? withoutEntry(prev.seen, change.replaced) : prev.seen;
  return { ...prev, seen: withEntry(base, change.entry) };
}

function isFingerprint(value: unknown): value is MemoryFingerprint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

/** Narrow a stored value; anything malformed reads as "nothing delivered". */
export function parseDeliveryState(raw: unknown): MemoryDeliveryState | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const base = v.base as Record<string, unknown> | undefined;
  if (!base || !isFingerprint(base.fingerprint) || typeof base.truncated !== 'boolean') return null;
  if (!isFingerprint(v.seen) || typeof v.indexed !== 'boolean' || typeof v.changes !== 'boolean') return null;
  return {
    base: { fingerprint: { ...base.fingerprint }, truncated: base.truncated },
    seen: { ...v.seen },
    indexed: v.indexed,
    changes: v.changes,
  };
}

/** The subset of `ctx.storage` the store needs. */
export interface DeliveryStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: MemoryDeliveryState): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface DeliveryStore {
  get(sessionID: string): Promise<MemoryDeliveryState | null>;
  /**
   * Run `mutate` on the latest state, one at a time per session, and
   * persist what it returns (`undefined` keeps the state).
   */
  update(
    sessionID: string,
    mutate: (state: MemoryDeliveryState | null) => Promise<MemoryDeliveryState | null | undefined>,
  ): Promise<void>;
  forget(sessionID: string): Promise<void>;
}

export function deliveryStorageKey(sessionID: string): string {
  return `session/${sessionID}`;
}

export function createDeliveryStore(storage: DeliveryStorage): DeliveryStore {
  const queues = new Map<string, Promise<void>>();
  const get = async (sessionID: string): Promise<MemoryDeliveryState | null> =>
    parseDeliveryState(await storage.get(deliveryStorageKey(sessionID)));
  const update: DeliveryStore['update'] = (sessionID, mutate) => {
    const run = (queues.get(sessionID) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const next = await mutate(await get(sessionID));
        if (next === undefined) return;
        if (next === null) await storage.remove(deliveryStorageKey(sessionID));
        else await storage.set(deliveryStorageKey(sessionID), next);
      });
    queues.set(sessionID, run);
    return run;
  };
  const forget = async (sessionID: string): Promise<void> => {
    queues.delete(sessionID);
    await storage.remove(deliveryStorageKey(sessionID));
  };
  return { get, update, forget };
}
