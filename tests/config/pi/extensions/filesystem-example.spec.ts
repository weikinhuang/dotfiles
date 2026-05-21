/**
 * Validates the bundled `config/pi/filesystem-example.json` parses
 * through the same loader the runtime uses, and that the resolved
 * policy round-trips through `classifyRead` / `classifyWrite` with
 * the expected default-policy posture.
 *
 * Lives under `tests/config/pi/extensions/` because Phase 1's plan
 * requires extension-adjacent example specs alongside any future
 * `filesystem.spec.ts` (Phase 3). The code under test is pure - no
 * pi-runtime imports - so it runs in the same vitest pass as the
 * helper specs.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { classifyRead, classifyWrite } from '../../../../lib/node/pi/filesystem-policy/classify.ts';
import { loadFilesystemPolicy } from '../../../../lib/node/pi/filesystem-policy/load.ts';

const EXAMPLE_PATH = resolve(__dirname, '../../../../config/pi/filesystem-example.json');
const HOME = homedir();
const CWD = '/repo';

function loadExample(): ReturnType<typeof loadFilesystemPolicy> {
  const raw = readFileSync(EXAMPLE_PATH, 'utf8');
  // Mimic what the runtime does: defaults are already shipped, so
  // disable them here to assert the example file alone is internally
  // sufficient.
  return loadFilesystemPolicy([{ source: 'example', raw }], { includeDefaults: false });
}

describe('config/pi/filesystem-example.json', () => {
  test('JSONC parses with no warnings', () => {
    const { warnings } = loadExample();
    expect(warnings).toEqual([]);
  });

  test('read.deny covers .env basenames and ~/.ssh prefix', () => {
    const { policy } = loadExample();
    expect(classifyRead('src/.env', CWD, policy)?.reason).toBe('deny-basename');
    expect(classifyRead('src/.envrc', CWD, policy)?.reason).toBe('deny-basename');
    expect(classifyRead(`${HOME}/.ssh/id_rsa`, CWD, policy)?.reason).toBe('deny-path-prefix');
    expect(classifyRead(`${HOME}/.aws/credentials`, CWD, policy)?.reason).toBe('deny-path-prefix');
  });

  test('write.allow covers cwd and /tmp; outside is gated', () => {
    const { policy } = loadExample();
    expect(classifyWrite('./src/x.ts', CWD, policy)).toBeNull();
    expect(classifyWrite('/tmp/scratch', CWD, policy)).toBeNull();
    expect(classifyWrite(`${HOME}/notes/foo.md`, CWD, policy)?.reason).toBe('outside-allowed-write');
    expect(classifyWrite('/etc/hosts', CWD, policy)?.reason).toBe('outside-allowed-write');
  });

  test('write.deny gates .env / .git/hooks / .git/config inside cwd', () => {
    const { policy } = loadExample();
    expect(classifyWrite('./src/.env', CWD, policy)?.reason).toBe('deny-basename');
    expect(classifyWrite('./.git/hooks/pre-commit', CWD, policy)?.reason).toBe('deny-segment');
    expect(classifyWrite('./.git/config', CWD, policy)?.reason).toBe('deny-segment');
    // node_modules is NOT in the example/default deny set; writes are
    // allowed by the workspace outer-gate. Stricter project policies
    // can opt back into denying it.
    expect(classifyWrite('./node_modules/foo/index.js', CWD, policy)).toBeNull();
  });

  test('clean reads/writes inside cwd remain ungated', () => {
    const { policy } = loadExample();
    expect(classifyRead('./src/index.ts', CWD, policy)).toBeNull();
    expect(classifyWrite('./src/index.ts', CWD, policy)).toBeNull();
  });
});
