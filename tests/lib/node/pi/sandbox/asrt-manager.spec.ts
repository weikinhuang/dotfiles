/**
 * Tests for lib/node/pi/sandbox/asrt-manager.ts.
 *
 * The dynamic-import path can't be exercised in vitest without
 * downloading the real ASRT package, so we cover the cache + test-seam
 * behavior here and treat the import line as runtime-only.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';

import {
  type AsrtModule,
  type AsrtSandboxManager,
  loadAsrtModule,
  resolveAsrtPackageRoot,
  setAsrtModuleForTesting,
  validateRuntimeConfig,
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

describe('validateRuntimeConfig (real ASRT schema)', () => {
  const fs = { denyRead: [], allowWrite: ['/repo'], denyWrite: [] };

  test('a valid config has no issues', () => {
    expect(
      validateRuntimeConfig(SandboxRuntimeConfigSchema, {
        network: { allowedDomains: ['github.com', 'localhost:8188', '[::1]'], deniedDomains: [] },
        filesystem: fs,
      }),
    ).toEqual([]);
  });

  test('reports invalid domain entries with their path', () => {
    const issues = validateRuntimeConfig(SandboxRuntimeConfigSchema, {
      network: { allowedDomains: ['https://x.com', '::1'], deniedDomains: [] },
      filesystem: fs,
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^network\.allowedDomains\.0: /);
    expect(issues[1]).toMatch(/^network\.allowedDomains\.1: /);
  });

  test('ignores the deliberately omitted domain lists of unrestricted mode', () => {
    expect(
      validateRuntimeConfig(SandboxRuntimeConfigSchema, { network: { allowAllUnixSockets: true }, filesystem: fs }),
    ).toEqual([]);
  });

  test('no schema (old runtime / test stub) = no issues; a throwing schema is reported', () => {
    expect(validateRuntimeConfig(undefined, { anything: true })).toEqual([]);
    const throwing = {
      safeParse: () => {
        throw new Error('nope');
      },
    };
    expect(validateRuntimeConfig(throwing, {})).toEqual(['schema validation threw: nope']);
  });
});

describe('resolveAsrtPackageRoot', () => {
  test('resolves the installed package directory', () => {
    const root = resolveAsrtPackageRoot();
    expect(root).toBeDefined();
    expect(existsSync(join(root ?? '', 'package.json'))).toBe(true);
    expect(root).toMatch(/sandbox-runtime$/);
  });
});
