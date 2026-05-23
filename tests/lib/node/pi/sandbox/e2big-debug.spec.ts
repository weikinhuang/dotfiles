/**
 * Tests for lib/node/pi/sandbox/e2big-debug.ts.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { logE2bigWrap } from '../../../../../lib/node/pi/sandbox/e2big-debug.ts';

let tmp: string;
const ENV_KEY = 'PI_SANDBOX_E2BIG_DEBUG';
let savedEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'e2big-debug-'));
  savedEnv = process.env[ENV_KEY];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe('logE2bigWrap', () => {
  test('no-op when env var unset', () => {
    delete process.env[ENV_KEY];

    expect(() =>
      logE2bigWrap({ wrapsAttempted: 1, lastResolvedAsrtConfig: undefined }, 'ls', 'srt -- ls'),
    ).not.toThrow();
  });

  test('writes to the env-var path with input/output sizes', () => {
    const path = join(tmp, 'log');
    process.env[ENV_KEY] = path;

    logE2bigWrap(
      {
        wrapsAttempted: 7,
        lastResolvedAsrtConfig: {
          filesystem: { denyRead: ['a', 'b', 'c'], denyWrite: [], allowWrite: ['/tmp', '/var'] },
        },
      },
      'echo hi',
      'srt -- echo hi',
    );

    const line = readFileSync(path, 'utf8').trim();
    expect(line).toContain('call=7');
    expect(line).toContain('in=7'); // 'echo hi'.length === 7
    expect(line).toContain('out=14');
    expect(line).toContain('denyRead=3');
    expect(line).toContain('denyWrite=0');
    expect(line).toContain('allowWrite=2');
    expect(line).toMatch(/inHead="echo hi"/);
  });

  test('appends across calls', () => {
    const path = join(tmp, 'log');
    process.env[ENV_KEY] = path;

    logE2bigWrap({ wrapsAttempted: 1, lastResolvedAsrtConfig: undefined }, 'a', 'b');
    logE2bigWrap({ wrapsAttempted: 2, lastResolvedAsrtConfig: undefined }, 'c', 'd');

    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
  });

  test('emits -1 when filesystem rule lists are missing', () => {
    const path = join(tmp, 'log');
    process.env[ENV_KEY] = path;

    logE2bigWrap({ wrapsAttempted: 0, lastResolvedAsrtConfig: { filesystem: {} } }, 'x', 'y');

    expect(readFileSync(path, 'utf8')).toContain('denyRead=-1 denyWrite=-1 allowWrite=-1');
  });
});
