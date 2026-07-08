/**
 * Tests for lib/node/pi/subdir-agents/file-names.ts.
 */

import { describe, expect, test } from 'vitest';

import { parseFileNames } from '../../../../../lib/node/pi/subdir-agents/file-names.ts';
import { DEFAULT_CONTEXT_FILE_NAMES } from '../../../../../lib/node/pi/subdir-agents.ts';

describe('parseFileNames', () => {
  test('undefined falls back to the default names', () => {
    expect(parseFileNames(undefined)).toBe(DEFAULT_CONTEXT_FILE_NAMES);
  });

  test('empty string falls back to the default names', () => {
    expect(parseFileNames('')).toBe(DEFAULT_CONTEXT_FILE_NAMES);
  });

  test('a single name is returned as one entry', () => {
    expect(parseFileNames('GUIDE.md')).toEqual(['GUIDE.md']);
  });

  test('comma-separated names are split and trimmed', () => {
    expect(parseFileNames(' A.md , B.md ,C.md')).toEqual(['A.md', 'B.md', 'C.md']);
  });

  test('blank entries are dropped', () => {
    expect(parseFileNames('A.md,,  ,B.md')).toEqual(['A.md', 'B.md']);
  });

  test('all-blank input falls back to the default names', () => {
    expect(parseFileNames('  , ,')).toBe(DEFAULT_CONTEXT_FILE_NAMES);
  });
});
