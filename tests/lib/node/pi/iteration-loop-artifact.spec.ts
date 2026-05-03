/**
 * Tests for lib/node/pi/iteration-loop-artifact.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  anyArtifactMatch,
  artifactMatches,
  extractEditTargets,
  normalizePath,
} from '../../../../lib/node/pi/iteration-loop-artifact.ts';

const CWD = '/repo';

describe('normalizePath', () => {
  test('resolves relative against cwd', () => {
    expect(normalizePath('out.svg', CWD)).toBe('/repo/out.svg');
  });

  test('preserves absolute', () => {
    expect(normalizePath('/tmp/a.svg', CWD)).toBe('/tmp/a.svg');
  });

  test('collapses .. and .', () => {
    expect(normalizePath('./sub/../out.svg', CWD)).toBe('/repo/out.svg');
  });

  test('rejects empty / non-string', () => {
    expect(normalizePath('', CWD)).toBeNull();
    expect(normalizePath('   ', CWD)).toBeNull();
    expect(normalizePath(null, CWD)).toBeNull();
    expect(normalizePath(undefined, CWD)).toBeNull();
  });

  test('strips a trailing slash (but not root)', () => {
    expect(normalizePath('/tmp/a/', CWD)).toBe('/tmp/a');
    expect(normalizePath('/', CWD)).toBe('/');
  });
});

describe('artifactMatches', () => {
  test('exact cwd-relative match', () => {
    expect(artifactMatches('out.svg', 'out.svg', CWD)).toBe(true);
  });

  test('match against absolute candidate', () => {
    expect(artifactMatches('out.svg', '/repo/out.svg', CWD)).toBe(true);
  });

  test('different names no match', () => {
    expect(artifactMatches('out.svg', 'out2.svg', CWD)).toBe(false);
  });

  test('falsy inputs safely false', () => {
    expect(artifactMatches(null, 'out.svg', CWD)).toBe(false);
    expect(artifactMatches('out.svg', '', CWD)).toBe(false);
  });
});

describe('anyArtifactMatch', () => {
  test('true when any candidate matches', () => {
    expect(anyArtifactMatch('out.svg', ['a.svg', 'out.svg', 'b.svg'], CWD)).toBe(true);
  });

  test('false when none match', () => {
    expect(anyArtifactMatch('out.svg', ['a.svg', 'b.svg'], CWD)).toBe(false);
  });

  test('tolerates null entries', () => {
    expect(anyArtifactMatch('out.svg', [null, undefined, '/repo/out.svg'], CWD)).toBe(true);
  });
});

describe('extractEditTargets', () => {
  test('write / edit with { path }', () => {
    expect(extractEditTargets('write', { path: 'a.ts' })).toEqual(['a.ts']);
    expect(extractEditTargets('edit', { path: 'b.ts' })).toEqual(['b.ts']);
  });

  test('file_path alias', () => {
    expect(extractEditTargets('write', { file_path: 'c.ts' })).toEqual(['c.ts']);
  });

  test('multi_edit via edits[]', () => {
    expect(
      extractEditTargets('multi_edit', {
        edits: [{ path: 'a.ts' }, { file_path: 'b.ts' }, { foo: 1 }],
      }),
    ).toEqual(['a.ts', 'b.ts']);
  });

  test('files[] shape', () => {
    expect(extractEditTargets('write', { files: [{ path: 'x' }, { path: 'y' }] })).toEqual(['x', 'y']);
  });

  test('non-edit tool returns empty', () => {
    expect(extractEditTargets('read', { path: 'a.ts' })).toEqual([]);
    expect(extractEditTargets('bash', { command: 'ls' })).toEqual([]);
  });

  test('case-insensitive tool name match', () => {
    expect(extractEditTargets('Edit', { path: 'a.ts' })).toEqual(['a.ts']);
    expect(extractEditTargets('MultiEdit', { edits: [{ path: 'a.ts' }] })).toEqual(['a.ts']);
  });
});
