/**
 * Tests for lib/node/pi/sandbox/active.ts.
 */

import { afterEach, describe, expect, test } from 'vitest';

import {
  activeReconfigure,
  beginActiveReconfigure,
  clearActiveSandbox,
  getActiveSandbox,
  hashSandboxConfig,
  publishActiveSandbox,
} from '../../../../../lib/node/pi/sandbox/active.ts';
import { emptySandboxConfig } from '../../../../../lib/node/pi/sandbox/config-schema.ts';
import { emptyPolicy } from '../../../../../lib/node/pi/filesystem-policy/schema.ts';

afterEach(() => {
  clearActiveSandbox();
});

const baseInput = (): {
  filesystem: ReturnType<typeof emptyPolicy>;
  sandbox: ReturnType<typeof emptySandboxConfig>;
  platform: 'darwin';
} => ({
  filesystem: emptyPolicy(),
  sandbox: emptySandboxConfig(),
  platform: 'darwin' as const,
});

describe('hashSandboxConfig', () => {
  test('deterministic across object key ordering', () => {
    const a = { sandbox: emptySandboxConfig(), filesystem: emptyPolicy() };
    const b = { filesystem: emptyPolicy(), sandbox: emptySandboxConfig() };
    expect(hashSandboxConfig(a)).toBe(hashSandboxConfig(b));
  });

  test('changes when a value changes', () => {
    const a = { filesystem: emptyPolicy(), sandbox: emptySandboxConfig() };
    const b = { filesystem: emptyPolicy(), sandbox: emptySandboxConfig() };
    b.sandbox.network.allow.push('github.com');
    expect(hashSandboxConfig(a)).not.toBe(hashSandboxConfig(b));
  });

  test('order-sensitive for arrays (rule order is meaningful)', () => {
    const a = { filesystem: emptyPolicy(), sandbox: emptySandboxConfig() };
    const b = { filesystem: emptyPolicy(), sandbox: emptySandboxConfig() };
    a.sandbox.network.allow.push('a.com', 'b.com');
    b.sandbox.network.allow.push('b.com', 'a.com');
    expect(hashSandboxConfig(a)).not.toBe(hashSandboxConfig(b));
  });
});

describe('publishActiveSandbox / getActiveSandbox', () => {
  test('returns undefined before any publish', () => {
    expect(getActiveSandbox()).toBeUndefined();
  });

  test('first publish is changed: true', () => {
    const { changed, snapshot } = publishActiveSandbox(baseInput(), 1000);
    expect(changed).toBe(true);
    expect(snapshot.version).toBe(1);
    expect(snapshot.publishedAt).toBe(1000);
    expect(getActiveSandbox()).toBe(snapshot);
  });

  test('republishing the same config: changed is false but version still bumps', () => {
    const a = publishActiveSandbox(baseInput(), 1000);
    const b = publishActiveSandbox(baseInput(), 2000);
    expect(b.changed).toBe(false);
    expect(b.snapshot.version).toBe(2);
    expect(b.snapshot.configHash).toBe(a.snapshot.configHash);
    expect(b.snapshot.publishedAt).toBe(2000);
  });

  test('publishing a different config flips changed: true', () => {
    publishActiveSandbox(baseInput(), 1000);
    const next = baseInput();
    next.sandbox.network.allow.push('github.com');
    const result = publishActiveSandbox(next, 2000);
    expect(result.changed).toBe(true);
    expect(result.snapshot.version).toBe(2);
  });

  test('snapshot is frozen', () => {
    publishActiveSandbox(baseInput(), 1000);
    const snap = getActiveSandbox();
    expect(snap).toBeDefined();
    expect(Object.isFrozen(snap)).toBe(true);
  });

  test('clearActiveSandbox resets to undefined', () => {
    publishActiveSandbox(baseInput(), 1000);
    clearActiveSandbox();
    expect(getActiveSandbox()).toBeUndefined();
  });
});

describe('activeReconfigure mutex', () => {
  test('await is a no-op when nothing is in flight', async () => {
    await expect(activeReconfigure()).resolves.toBeUndefined();
  });

  test('beginActiveReconfigure blocks awaiters until done() is called', async () => {
    let resolved = false;
    const done = beginActiveReconfigure();
    const waiter = activeReconfigure().then(() => {
      resolved = true;
    });
    await Promise.resolve(); // settle microtasks
    await Promise.resolve();
    expect(resolved).toBe(false);
    done();
    await waiter;
    expect(resolved).toBe(true);
  });

  test('multiple in-flight reconfigures chain (last awaiter waits for all)', async () => {
    const done1 = beginActiveReconfigure();
    const done2 = beginActiveReconfigure();
    let resolved = false;
    const waiter = activeReconfigure().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    done1();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    done2();
    await waiter;
    expect(resolved).toBe(true);
  });
});
