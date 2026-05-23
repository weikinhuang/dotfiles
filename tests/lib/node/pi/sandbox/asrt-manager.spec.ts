/**
 * Tests for lib/node/pi/sandbox/asrt-manager.ts.
 *
 * The dynamic-import path can't be exercised in vitest without
 * downloading the real ASRT package, so we cover the cache + test-seam
 * behavior here and treat the import line as runtime-only.
 */

import { afterEach, describe, expect, test } from 'vitest';

import {
  type AsrtModule,
  type AsrtSandboxManager,
  loadAsrtModule,
  setAsrtModuleForTesting,
} from '../../../../../lib/node/pi/sandbox/asrt-manager.ts';

function stubManager(): AsrtSandboxManager {
  return {
    initialize: () => Promise.resolve(),
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => true,
    wrapWithSandbox: (cmd) => Promise.resolve(`wrapped(${cmd})`),
    updateConfig: () => undefined,
    reset: () => Promise.resolve(),
    getSandboxViolationStore: () => ({ getViolations: () => [] }),
    annotateStderrWithSandboxFailures: (_c, s) => s,
  };
}

afterEach(() => {
  setAsrtModuleForTesting(null);
});

describe('loadAsrtModule', () => {
  test('returns the injected stub when one is set', async () => {
    const stub: AsrtModule = { SandboxManager: stubManager() };
    setAsrtModuleForTesting(stub);

    expect(await loadAsrtModule()).toBe(stub);
  });

  test('subsequent calls return the same cached module', async () => {
    const stub: AsrtModule = { SandboxManager: stubManager() };
    setAsrtModuleForTesting(stub);

    const a = await loadAsrtModule();
    const b = await loadAsrtModule();

    expect(a).toBe(b);
  });
});
