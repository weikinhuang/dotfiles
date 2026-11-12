/**
 * Tests for lib/node/opencode/session-tree.ts.
 */

import { expect, test, vi } from 'vitest';

import {
  cacheParentLookup,
  isRootSession,
  MAX_SESSION_DEPTH,
  type ParentLookup,
  resolveRootSessionID,
} from '../../../../lib/node/opencode/session-tree.ts';

function lookupFrom(parents: Record<string, string>): ParentLookup {
  return (id) => Promise.resolve(parents[id]);
}

test('resolveRootSessionID: walks to the root', async () => {
  const lookup = lookupFrom({ grandchild: 'child', child: 'root' });
  await expect(resolveRootSessionID('grandchild', lookup)).resolves.toBe('root');
  await expect(resolveRootSessionID('root', lookup)).resolves.toBe('root');
});

test('resolveRootSessionID: stops on a cycle', async () => {
  const lookup = lookupFrom({ a: 'b', b: 'a' });
  await expect(resolveRootSessionID('a', lookup)).resolves.toBe('b');
});

test('resolveRootSessionID: caps the walk depth', async () => {
  const lookup: ParentLookup = (id) => Promise.resolve(`${id}+`);
  const root = await resolveRootSessionID('s', lookup);
  expect(root).toBe(`s${'+'.repeat(MAX_SESSION_DEPTH)}`);
});

test('isRootSession: true only without a parent', async () => {
  const lookup = lookupFrom({ child: 'root' });
  await expect(isRootSession('root', lookup)).resolves.toBe(true);
  await expect(isRootSession('child', lookup)).resolves.toBe(false);
});

test('cacheParentLookup: memoizes results, including roots, but not failures', async () => {
  const inner = vi.fn<ParentLookup>((id) =>
    id === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(id === 'child' ? 'root' : undefined),
  );
  const cached = cacheParentLookup(inner);
  await cached('child');
  await cached('child');
  await cached('root');
  await cached('root');
  expect(inner).toHaveBeenCalledTimes(2);
  await expect(cached('bad')).rejects.toThrow('boom');
  await expect(cached('bad')).rejects.toThrow('boom');
  expect(inner).toHaveBeenCalledTimes(4);
});
