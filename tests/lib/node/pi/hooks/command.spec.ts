/**
 * Tests for lib/node/pi/hooks/command.ts.
 */

import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { resolveCommand } from '../../../../../lib/node/pi/hooks/command.ts';

const HOME = '/home/tester';
const CWD = '/work/repo';

describe('resolveCommand', () => {
  test('absolute paths pass through unchanged', () => {
    expect(resolveCommand('/usr/local/bin/hook.sh', CWD, HOME)).toBe('/usr/local/bin/hook.sh');
  });

  test('bare commands (no separator) pass through for PATH lookup', () => {
    expect(resolveCommand('my-hook', CWD, HOME)).toBe('my-hook');
  });

  test('relative paths with a separator resolve against cwd', () => {
    expect(resolveCommand('./scripts/my-hook.sh', CWD, HOME)).toBe(resolve(CWD, './scripts/my-hook.sh'));
  });

  test('a lone tilde expands to the home directory', () => {
    expect(resolveCommand('~', CWD, HOME)).toBe(HOME);
  });

  test('~/ paths expand against home and are normalized', () => {
    expect(resolveCommand('~/scripts/hook.sh', CWD, HOME)).toBe(resolve(HOME, 'scripts/hook.sh'));
    expect(resolveCommand('~/scripts/hook.sh', CWD, HOME)).toBe('/home/tester/scripts/hook.sh');
  });

  test('~/ tail is run through resolve so . / .. collapse', () => {
    expect(resolveCommand('~/a/../b/hook.sh', CWD, HOME)).toBe(resolve(HOME, 'b/hook.sh'));
  });
});
