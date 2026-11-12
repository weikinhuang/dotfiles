/**
 * Tests for lib/node/opencode/context-edit-store.ts.
 */

import { expect, test } from 'vitest';

import {
  createDirectiveStore,
  type KeyValueStorage,
  storageKey,
} from '../../../../lib/node/opencode/context-edit-store.ts';
import { addCollapse, type ContextEditState, emptyState } from '../../../../lib/node/pi/context-edit/directive.ts';

interface FakeStorage extends KeyValueStorage {
  data: Map<string, unknown>;
  reads: number;
  failWrites: boolean;
}

function fakeStorage(initial: Record<string, unknown> = {}): FakeStorage {
  const storage: FakeStorage = {
    data: new Map(Object.entries(initial)),
    reads: 0,
    failWrites: false,
    get: (key) => {
      storage.reads++;
      return Promise.resolve(storage.data.get(key));
    },
    set: (key, value) => {
      if (storage.failWrites) return Promise.reject(new Error('disk full'));
      storage.data.set(key, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
    remove: (key) => {
      storage.data.delete(key);
      return Promise.resolve();
    },
  };
  return storage;
}

function collapse(id: string): (s: ContextEditState) => ContextEditState {
  return (s) => {
    const r = addCollapse(s, id, undefined, 1);
    if (!r.ok) throw new Error(r.error);
    return r.state;
  };
}

test('storageKey namespaces by session', () => {
  expect(storageKey('ses_1')).toBe('session/ses_1');
});

test('get loads once, defaults to empty, and ignores junk', async () => {
  const storage = fakeStorage({ 'session/junk': { nope: 1 } });
  const store = createDirectiveStore(storage);
  expect(await store.get('ses_1')).toEqual(emptyState());
  await store.get('ses_1');
  expect(storage.reads).toBe(1);
  expect(await store.get('junk')).toEqual(emptyState());
});

test('update persists the full set and survives a new store (restart)', async () => {
  const storage = fakeStorage();
  const store = createDirectiveStore(storage);
  await store.update('ses_1', collapse('call_1'));
  await store.update('ses_1', collapse('call_2'));
  const reopened = createDirectiveStore(storage);
  const state = await reopened.get('ses_1');
  expect(state.directives.map((d) => (d.kind === 'collapse' ? d.toolCallId : ''))).toEqual(['call_1', 'call_2']);
  expect(state.nextId).toBe(3);
});

test('concurrent updates apply in order without losing writes', async () => {
  const store = createDirectiveStore(fakeStorage());
  await Promise.all(['a', 'b', 'c'].map((id) => store.update('ses_1', collapse(id))));
  expect((await store.get('ses_1')).directives).toHaveLength(3);
});

test('returning undefined skips the write; emptying removes the key', async () => {
  const storage = fakeStorage();
  const store = createDirectiveStore(storage);
  await store.update('ses_1', () => undefined);
  expect(storage.data.size).toBe(0);
  await store.update('ses_1', collapse('a'));
  expect(storage.data.has('session/ses_1')).toBe(true);
  await store.update('ses_1', (s) => ({ ...s, directives: [] }));
  expect(storage.data.has('session/ses_1')).toBe(false);
});

test('a failed write rejects and keeps the previous state', async () => {
  const storage = fakeStorage();
  const store = createDirectiveStore(storage);
  await store.update('ses_1', collapse('a'));
  storage.failWrites = true;
  await expect(store.update('ses_1', collapse('b'))).rejects.toThrow('disk full');
  storage.failWrites = false;
  expect((await store.get('ses_1')).directives).toHaveLength(1);
  await store.update('ses_1', collapse('c'));
  expect((await store.get('ses_1')).directives).toHaveLength(2);
});

test('the mutation sees a copy, not the cached state', async () => {
  const store = createDirectiveStore(fakeStorage());
  await store.update('ses_1', collapse('a'));
  const before = await store.get('ses_1');
  await store.update('ses_1', (s) => {
    s.directives.length = 0;
    return undefined;
  });
  expect(before.directives).toHaveLength(1);
  expect((await store.get('ses_1')).directives).toHaveLength(1);
});

test('forget clears cache and storage', async () => {
  const storage = fakeStorage();
  const store = createDirectiveStore(storage);
  await store.update('ses_1', collapse('a'));
  await store.forget('ses_1');
  expect(storage.data.size).toBe(0);
  expect(await store.get('ses_1')).toEqual(emptyState());
});
