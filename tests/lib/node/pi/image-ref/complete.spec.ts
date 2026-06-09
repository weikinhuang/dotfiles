/**
 * Tests for lib/node/pi/image-ref/complete.ts.
 */

import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  buildCompletionItems,
  completionPrefix,
  type DirEntry,
  extractMarkerToken,
  isImageFile,
  resolveReadDir,
} from '../../../../../lib/node/pi/image-ref/complete.ts';

describe('extractMarkerToken', () => {
  test('returns null when the cursor is not in a marked token', () => {
    expect(extractMarkerToken('')).toBeNull();
    expect(extractMarkerToken('look at the file')).toBeNull();
    expect(extractMarkerToken('rename Example.jpg')).toBeNull();
  });

  test('matches a bare marker at a token boundary', () => {
    expect(extractMarkerToken('&')).toEqual({ partial: '', dirPrefix: '', base: '' });
    expect(extractMarkerToken('see &')).toEqual({ partial: '', dirPrefix: '', base: '' });
  });

  test('splits a partial path into dirPrefix and base', () => {
    expect(extractMarkerToken('&src/ima')).toEqual({ partial: 'src/ima', dirPrefix: 'src/', base: 'ima' });
    expect(extractMarkerToken('&./a')).toEqual({ partial: './a', dirPrefix: './', base: 'a' });
    expect(extractMarkerToken('&/tmp/')).toEqual({ partial: '/tmp/', dirPrefix: '/tmp/', base: '' });
    expect(extractMarkerToken('&logo')).toEqual({ partial: 'logo', dirPrefix: '', base: 'logo' });
  });

  test('only the token ending at the cursor wins', () => {
    expect(extractMarkerToken('&a.png &b')).toEqual({ partial: 'b', dirPrefix: '', base: 'b' });
  });

  test('requires a whitespace boundary before the marker', () => {
    // No preceding boundary inside a word - e.g. an email-ish "a&b".
    expect(extractMarkerToken('foo&bar')).toBeNull();
  });
});

describe('completionPrefix', () => {
  test('reattaches the marker to the typed partial', () => {
    expect(completionPrefix({ partial: 'src/ima', dirPrefix: 'src/', base: 'ima' })).toBe('&src/ima');
    expect(completionPrefix({ partial: '', dirPrefix: '', base: '' })).toBe('&');
  });
});

describe('resolveReadDir', () => {
  test('resolves a relative dirPrefix against cwd', () => {
    const token = { partial: 'src/ima', dirPrefix: 'src/', base: 'ima' };
    expect(resolveReadDir(token, '/work', '/home/u')).toBe(resolve('/work', 'src/'));
  });

  test('reads cwd when there is no directory prefix', () => {
    const token = { partial: 'logo', dirPrefix: '', base: 'logo' };
    expect(resolveReadDir(token, '/work', '/home/u')).toBe(resolve('/work', '.'));
  });

  test('expands a leading tilde', () => {
    const token = { partial: '~/pics/x', dirPrefix: '~/pics/', base: 'x' };
    expect(resolveReadDir(token, '/work', '/home/u')).toBe('/home/u/pics/');
  });

  test('keeps an absolute dirPrefix', () => {
    const token = { partial: '/tmp/x', dirPrefix: '/tmp/', base: 'x' };
    expect(resolveReadDir(token, '/work', '/home/u')).toBe('/tmp/');
  });
});

describe('isImageFile', () => {
  test('accepts the supported extensions case-insensitively', () => {
    for (const name of ['a.png', 'a.jpg', 'a.JPEG', 'a.Gif', 'a.webp']) {
      expect(isImageFile(name)).toBe(true);
    }
  });

  test('rejects non-images and extensionless names', () => {
    for (const name of ['a.txt', 'a.svg', 'README', '.gitignore', 'a.pngx']) {
      expect(isImageFile(name)).toBe(false);
    }
  });
});

describe('buildCompletionItems', () => {
  const entries: DirEntry[] = [
    { name: 'images', isDirectory: true },
    { name: 'icons', isDirectory: true },
    { name: 'logo.png', isDirectory: false },
    { name: 'photo.JPG', isDirectory: false },
    { name: 'notes.txt', isDirectory: false },
    { name: '.hidden.png', isDirectory: false },
  ];

  test('offers directories and image files, directories first', () => {
    const items = buildCompletionItems(entries, { partial: '', dirPrefix: '', base: '' }, 20);
    expect(items.map((i) => i.label)).toEqual(['icons/', 'images/', 'logo.png', 'photo.JPG']);
  });

  test('filters non-image files and hidden entries by default', () => {
    const labels = buildCompletionItems(entries, { partial: '', dirPrefix: '', base: '' }, 20).map((i) => i.label);
    expect(labels).not.toContain('notes.txt');
    expect(labels).not.toContain('.hidden.png');
  });

  test('surfaces hidden entries once a leading dot is typed', () => {
    const items = buildCompletionItems(entries, { partial: '.h', dirPrefix: '', base: '.h' }, 20);
    expect(items.map((i) => i.label)).toEqual(['.hidden.png']);
  });

  test('matches the basename fragment case-insensitively', () => {
    const items = buildCompletionItems(entries, { partial: 'i', dirPrefix: '', base: 'i' }, 20);
    expect(items.map((i) => i.label)).toEqual(['icons/', 'images/']);
  });

  test('value carries the marker, typed dirPrefix, and a trailing slash for directories', () => {
    const items = buildCompletionItems(entries, { partial: 'src/lo', dirPrefix: 'src/', base: 'lo' }, 20);
    expect(items).toEqual([{ value: '&src/logo.png', label: 'logo.png' }]);

    const dirItems = buildCompletionItems(entries, { partial: 'src/ic', dirPrefix: 'src/', base: 'ic' }, 20);
    expect(dirItems).toEqual([{ value: '&src/icons/', label: 'icons/' }]);
  });

  test('caps the result at maxItems', () => {
    expect(buildCompletionItems(entries, { partial: '', dirPrefix: '', base: '' }, 2)).toHaveLength(2);
  });
});
