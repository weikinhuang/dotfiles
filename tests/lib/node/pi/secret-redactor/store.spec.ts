/**
 * Tests for lib/node/pi/secret-redactor/store.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { HANDLE_REF_RE, makePlaceholder, SecretStore } from '../../../../../lib/node/pi/secret-redactor/store.ts';

describe('SecretStore.register', () => {
  test('is idempotent: same value keeps its handle and label', () => {
    const store = new SecretStore();
    const a = store.register('sk_live_abc123', 'stripe-key');
    const b = store.register('sk_live_abc123', 'something-else');

    expect(b.handle).toBe(a.handle);
    expect(b.label).toBe('stripe-key'); // first label wins
    expect(store.size()).toBe(1);
  });

  test('distinct values get distinct handles', () => {
    const store = new SecretStore();
    const a = store.register('value-one', 'k');
    const b = store.register('value-two', 'k');

    expect(a.handle).not.toBe(b.handle);
    expect(store.size()).toBe(2);
  });

  test('handle is a stable hex prefix, not derived from the value text', () => {
    const store = new SecretStore();
    const entry = store.register('ghp_supersecrettoken', 'github-token');

    expect(entry.handle).toMatch(/^[0-9a-f]{4,}$/);
    expect('ghp_supersecrettoken').not.toContain(entry.handle); // not a slice of the secret
  });

  test('handle is a prefix of the value sha256 (shared hash helper)', () => {
    const store = new SecretStore();
    const value = 'sk_live_deadbeefdeadbeef';
    const { handle } = store.register(value, 'stripe-key');
    const full = createHash('sha256').update(value).digest('hex');

    expect(full.startsWith(handle)).toBe(true);
    expect(handle.length).toBe(4); // HANDLE_BASE_LEN, no collision
  });
});

describe('SecretStore approval', () => {
  test('approve only succeeds for a known handle', () => {
    const store = new SecretStore();
    const { handle } = store.register('secret', 'k');

    expect(store.isApproved(handle)).toBe(false);
    expect(store.approve(handle)).toBe(true);
    expect(store.isApproved(handle)).toBe(true);
    expect(store.approve('deadbeef')).toBe(false);
  });

  test('redactedCount excludes approved (revealed) handles', () => {
    const store = new SecretStore();
    const a = store.register('one', 'k');
    store.register('two', 'k');
    expect(store.redactedCount()).toBe(2);
    store.approve(a.handle);
    expect(store.redactedCount()).toBe(1);
    expect(store.size()).toBe(2); // still tracked
  });
});

describe('SecretStore.referencedHandles', () => {
  test('finds a full placeholder reference', () => {
    const store = new SecretStore();
    const { handle, label } = store.register('sk_live_xyz', 'stripe-key');
    const text = `STRIPE_KEY=${makePlaceholder(label, handle)} ./deploy.sh`;

    expect(store.referencedHandles(text)).toEqual([handle]);
  });

  test('finds a bare #handle reference (mangled placeholder fallback)', () => {
    const store = new SecretStore();
    const { handle } = store.register('sk_live_xyz', 'stripe-key');

    expect(store.referencedHandles(`run with #${handle} please`)).toEqual([handle]);
  });

  test('ignores unknown handles and short #refs', () => {
    const store = new SecretStore();
    store.register('sk_live_xyz', 'stripe-key');

    expect(store.referencedHandles('see PR #123 and commit #abcd')).toEqual([]);
  });

  test('dedupes repeated references', () => {
    const store = new SecretStore();
    const { handle } = store.register('s', 'k');

    expect(store.referencedHandles(`#${handle} #${handle}`)).toEqual([handle]);
  });
});

describe('SecretStore.clear', () => {
  test('drops values, handles, and approvals', () => {
    const store = new SecretStore();
    const { handle } = store.register('s', 'k');
    store.approve(handle);
    store.clear();

    expect(store.size()).toBe(0);
    expect(store.lookup(handle)).toBeUndefined();
    expect(store.isApproved(handle)).toBe(false);
  });
});

describe('HANDLE_REF_RE', () => {
  test('greedy hex run captures the whole handle (no substring collision)', () => {
    const matches = [...'#1a2bc'.matchAll(HANDLE_REF_RE)].map((m) => m[1] ?? m[2]);
    expect(matches).toEqual(['1a2bc']);
  });
});
