/**
 * Tests for `lib/node/pi/scope-pick.ts`.
 *
 * Exercises the three pickScopeFile fallthrough rungs against a real
 * tmpdir so the `statSync` calls aren't stubbed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { pickScopeFile } from '../../../../lib/node/pi/scope-pick.ts';

let cwd: string;
const userFile = '/tmp/__pi-scope-pick-test-user.json';

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi-scope-pick-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('pickScopeFile', () => {
  test('returns the project file when it already exists', () => {
    const projectFile = join(cwd, '.pi', 'sandbox.json');
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(projectFile, '{}');
    expect(pickScopeFile({ cwd, projectFile, userFile })).toBe(projectFile);
  });

  test('returns the project file when only the `.pi/` dir exists', () => {
    const projectFile = join(cwd, '.pi', 'sandbox.json');
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    expect(pickScopeFile({ cwd, projectFile, userFile })).toBe(projectFile);
  });

  test('falls back to user file when neither exists', () => {
    const projectFile = join(cwd, '.pi', 'sandbox.json');
    expect(pickScopeFile({ cwd, projectFile, userFile })).toBe(userFile);
  });
});
