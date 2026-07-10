import { describe, expect, test } from 'vitest';

import {
  buildPersonaEnvDirs,
  parsePersonaDirsEnv,
  resolvePersonaEnvDir,
} from '../../../../../lib/node/pi/persona/env-dirs.ts';

const ctx = { cwd: '/work/proj', homedir: '/home/alice' };

describe('parsePersonaDirsEnv', () => {
  test('undefined / empty -> []', () => {
    expect(parsePersonaDirsEnv(undefined)).toEqual([]);
    expect(parsePersonaDirsEnv('')).toEqual([]);
    expect(parsePersonaDirsEnv('   ')).toEqual([]);
  });

  test('splits on colon, trims, drops empties', () => {
    expect(parsePersonaDirsEnv('/a : /b::  /c ')).toEqual(['/a', '/b', '/c']);
  });
});

describe('resolvePersonaEnvDir', () => {
  test('absolute path passes through', () => {
    expect(resolvePersonaEnvDir('/abs/personas', ctx)).toBe('/abs/personas');
  });

  test('tilde expands against homedir', () => {
    expect(resolvePersonaEnvDir('~/eval/personas', ctx)).toBe('/home/alice/eval/personas');
  });

  test('relative path resolves against cwd', () => {
    expect(resolvePersonaEnvDir('fixtures/personas', ctx)).toBe('/work/proj/fixtures/personas');
  });

  test('leading ./ is stripped then resolved against cwd', () => {
    expect(resolvePersonaEnvDir('./fixtures/personas', ctx)).toBe('/work/proj/fixtures/personas');
  });
});

describe('buildPersonaEnvDirs', () => {
  test('maps every entry through resolvePersonaEnvDir preserving order', () => {
    expect(buildPersonaEnvDirs(['/abs', '~/u', 'rel'], ctx)).toEqual(['/abs', '/home/alice/u', '/work/proj/rel']);
  });

  test('empty list -> []', () => {
    expect(buildPersonaEnvDirs([], ctx)).toEqual([]);
  });
});
