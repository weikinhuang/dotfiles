/**
 * Validates the bundled `config/pi/sandbox-example.json` parses
 * through `loadSandboxConfig` and translates cleanly via
 * `translateToASRT` into a shape the SandboxRuntimeConfig type
 * accepts. This is the same pipeline the Phase 3 sandbox extension
 * will run on first bash invocation.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { loadSandboxConfig } from '../../../../lib/node/pi/sandbox/config-load.ts';
import { translateToASRT } from '../../../../lib/node/pi/sandbox/config-translate.ts';
import { emptyPolicy } from '../../../../lib/node/pi/filesystem-policy/schema.ts';

const EXAMPLE_PATH = resolve(__dirname, '../../../../config/pi/sandbox-example.json');

function loadExample(): ReturnType<typeof loadSandboxConfig> {
  const raw = readFileSync(EXAMPLE_PATH, 'utf8');
  return loadSandboxConfig([{ source: 'example', raw }]);
}

describe('config/pi/sandbox-example.json', () => {
  test('JSONC parses with no warnings', () => {
    const { warnings } = loadExample();
    expect(warnings).toEqual([]);
  });

  test('matches plan section 6 baseline (deny-all network, no socket bypass, all flags off)', () => {
    const { config } = loadExample();
    expect(config.network.allow).toEqual([]);
    expect(config.network.deny).toEqual([]);
    expect(config.unixSockets.allow).toEqual([]);
    expect(config.unixSockets.allowAll).toBe(false);
    expect(config.flags.weakerNestedSandbox).toBe(false);
    expect(config.flags.weakerNetworkIsolation).toBe(false);
    expect(config.flags.allowLocalBinding).toBe(false);
    expect(config.flags.linuxRuleDepth).toBe(3);
  });

  test('translates to a structurally-valid ASRT config (darwin)', () => {
    const { config } = loadExample();
    const { config: asrt } = translateToASRT({
      policy: emptyPolicy(),
      sandbox: config,
      cwd: '/repo',
      homeDir: '/home/tester',
      mode: 'darwin',
    });
    expect(asrt.network.allowedDomains).toEqual([]);
    expect(asrt.network.deniedDomains).toEqual([]);
    expect(asrt.filesystem.allowWrite).toContain('/home/tester/.pi');
    expect(asrt.enableWeakerNestedSandbox).toBeUndefined();
    expect(asrt.enableWeakerNetworkIsolation).toBeUndefined();
  });

  test('translates to a structurally-valid ASRT config (linux, with empty compiled)', () => {
    const { config } = loadExample();
    const { config: asrt } = translateToASRT({
      policy: emptyPolicy(),
      sandbox: config,
      cwd: '/repo',
      homeDir: '/home/tester',
      mode: 'linux',
      compiled: {
        read: { paths: [], inertBasenames: [], inertSegments: [], inertPaths: [] },
        write: { paths: [], inertBasenames: [], inertSegments: [], inertPaths: [] },
      },
    });
    expect(asrt.filesystem.denyRead).toEqual([]);
    expect(asrt.filesystem.denyWrite).toEqual([]);
    // ~/.pi auto-add still happens.
    expect(asrt.filesystem.allowWrite).toContain('/home/tester/.pi');
  });
});
