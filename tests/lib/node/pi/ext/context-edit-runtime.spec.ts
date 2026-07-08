/**
 * Tests for lib/node/pi/ext/context-edit-runtime.ts.
 *
 * The runtime is the pi-coupled plumbing shared by the three context-edit
 * extensions (`context-trim`, `message-edit`, `tool-collapse`). We drive it
 * with a fake `pi` (capturing `appendEntry`) and a fake `ExtensionContext`
 * (a branch + entries) so the shared behaviour - branch rebuild, the
 * context-hook snapshot, completion refresh, and the persist mirror - is
 * exercised without the pi runtime doing real session I/O.
 */

import { describe, expect, test } from 'vitest';

import {
  type ContextEditRuntime,
  createContextEditRuntime,
} from '../../../../../lib/node/pi/ext/context-edit-runtime.ts';
import { type CompletionCandidate } from '../../../../../lib/node/pi/context-edit/complete.ts';
import { addTrim, type ContextEditState, emptyState } from '../../../../../lib/node/pi/context-edit/directive.ts';
import { type Candidate, enumerate } from '../../../../../lib/node/pi/context-edit/enumerate.ts';
import { type LooseMessage } from '../../../../../lib/node/pi/context-edit/target.ts';

const CUSTOM_TYPE = 'context-edit-runtime-test';

interface AppendCall {
  customType: string;
  data: unknown;
}

/** Build a runtime plus the fake pi's captured append calls. */
function makeRuntime(
  candidatesFrom: (messages: readonly LooseMessage[]) => Candidate[] = (m) => enumerate(m, { minTextBytes: 1 }),
  describe?: (c: Candidate) => string,
): { rt: ContextEditRuntime; appends: AppendCall[] } {
  const appends: AppendCall[] = [];
  const pi = {
    appendEntry: (customType: string, data?: unknown) => {
      appends.push({ customType, data });
    },
  } as never;
  const rt = createContextEditRuntime({ pi, customType: CUSTOM_TYPE, candidatesFrom, describe });
  return { rt, appends };
}

/** Fake ExtensionContext exposing just the sessionManager surface the runtime reads. */
function fakeCtx(opts: { branch?: unknown[]; entries?: unknown[]; leafId?: string | null } = {}): never {
  return {
    sessionManager: {
      getBranch: () => opts.branch ?? [],
      getEntries: () => opts.entries ?? [],
      getLeafId: () => opts.leafId ?? null,
    },
  } as never;
}

const contextEvent = (messages: unknown): never => ({ type: 'context', messages }) as never;

describe('createContextEditRuntime: state + persist', () => {
  test('starts empty and setState round-trips', () => {
    const { rt } = makeRuntime();
    expect(rt.getState().directives).toEqual([]);
    const next: ContextEditState = { directives: [], nextId: 9 };
    rt.setState(next);
    expect(rt.getState().nextId).toBe(9);
  });

  test('rebuildFromSession replays the persisted custom entry from the branch', () => {
    const { rt } = makeRuntime();
    const persisted: ContextEditState = {
      directives: [{ kind: 'collapse', id: 1, toolCallId: 'c1', createdAt: 0 }],
      nextId: 2,
    };
    const branch = [{ type: 'custom', customType: CUSTOM_TYPE, data: persisted }];
    rt.rebuildFromSession(fakeCtx({ branch }));
    expect(rt.getState().directives).toHaveLength(1);
    expect(rt.getState().nextId).toBe(2);
  });

  test('persist mirrors a CLONE of the state as a custom entry and resets the snapshot', () => {
    const { rt, appends } = makeRuntime();
    rt.readContextMessages(contextEvent([{ role: 'user', content: 'hi', timestamp: 1 }]));
    expect(rt.getSnapshot()).not.toBeNull();

    const trimmed = addTrim(emptyState(), { by: 'message', role: 'user', timestamp: 1 }, undefined, 1);
    if (!trimmed.ok) throw new Error('addTrim failed');
    rt.setState(trimmed.state);
    rt.persist();

    expect(appends).toHaveLength(1);
    expect(appends[0].customType).toBe(CUSTOM_TYPE);
    expect((appends[0].data as ContextEditState).directives).toHaveLength(1);
    // Persisted a clone, not the live object.
    expect(appends[0].data).not.toBe(rt.getState());
    // Snapshot reset so a follow-up listing rebuilds from the branch.
    expect(rt.getSnapshot()).toBeNull();
  });

  test('persist never throws when appendEntry throws', () => {
    const pi = {
      appendEntry: () => {
        throw new Error('boom');
      },
    } as never;
    const rt = createContextEditRuntime({ pi, customType: CUSTOM_TYPE, candidatesFrom: () => [] });
    expect(() => rt.persist()).not.toThrow();
  });
});

describe('createContextEditRuntime: completion snapshot', () => {
  const messages: LooseMessage[] = [
    { role: 'user', content: 'hello world', timestamp: 1 },
    { role: 'assistant', content: 'a reply', timestamp: 2 },
  ];

  test('refreshFromMessages fills getCompletionCandidates with id + description + search', () => {
    const { rt } = makeRuntime();
    const cands = rt.refreshFromMessages(messages);
    const snap = rt.getCompletionCandidates();
    expect(snap.map((c) => c.id)).toEqual(cands.map((c) => c.id));
    expect(snap.every((c) => typeof c.description === 'string' && c.description.length > 0)).toBe(true);
  });

  test('describe override customises the menu description', () => {
    const { rt } = makeRuntime(undefined, () => 'CUSTOM');
    rt.refreshFromMessages(messages);
    expect(rt.getCompletionCandidates().every((c: CompletionCandidate) => c.description === 'CUSTOM')).toBe(true);
  });
});

describe('createContextEditRuntime: context-hook primitives', () => {
  test('readContextMessages returns null for a non-array payload and does not snapshot', () => {
    const { rt } = makeRuntime();
    expect(rt.readContextMessages(contextEvent(undefined))).toBeNull();
    expect(rt.getSnapshot()).toBeNull();
  });

  test('finishContext returns the messages only when a directive applied, and refreshes completion', () => {
    const { rt } = makeRuntime();
    const out: LooseMessage[] = [{ role: 'user', content: 'kept', timestamp: 1 }];

    expect(rt.finishContext(out, 0)).toBeUndefined();
    const applied = rt.finishContext(out, 1);
    expect(applied).toEqual({ messages: out });
    // Snapshot + completion both refreshed off the final list.
    expect(rt.getSnapshot()).toBe(out);
    expect(rt.getCompletionCandidates().length).toBeGreaterThan(0);
  });

  test('currentMessages prefers the live snapshot', () => {
    const { rt } = makeRuntime();
    const snap: LooseMessage[] = [{ role: 'user', content: 'snap', timestamp: 1 }];
    rt.readContextMessages(contextEvent(snap));
    expect(rt.currentMessages(fakeCtx())).toBe(snap);
  });

  test('currentMessages falls back to an array when there is no snapshot', () => {
    const { rt } = makeRuntime();
    expect(Array.isArray(rt.currentMessages(fakeCtx()))).toBe(true);
  });
});
