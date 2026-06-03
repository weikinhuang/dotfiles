/**
 * Tests for lib/node/pi/image-ref/extract.ts.
 */

import { describe, expect, test } from 'vitest';

import { cleanToken, extractPathTokens, rewriteWithRefs } from '../../../../../lib/node/pi/image-ref/extract.ts';

describe('cleanToken', () => {
  test('strips the leading & marker', () => {
    expect(cleanToken('&./a.png')).toBe('./a.png');
    expect(cleanToken('&/tmp/x.png')).toBe('/tmp/x.png');
  });

  test('strips the marker then surrounding quotes', () => {
    expect(cleanToken('&"./a b.png"')).toBe('./a b.png');
    expect(cleanToken("&'/tmp/x.png'")).toBe('/tmp/x.png');
  });

  test('strips trailing sentence punctuation', () => {
    expect(cleanToken('&./a.png.')).toBe('./a.png');
    expect(cleanToken('&./a.png,')).toBe('./a.png');
    expect(cleanToken('&./a.png)')).toBe('./a.png');
    expect(cleanToken('&./a.png?')).toBe('./a.png');
  });

  test('leaves a clean marked token untouched', () => {
    expect(cleanToken('&~/pics/x.png')).toBe('~/pics/x.png');
  });
});

describe('extractPathTokens', () => {
  test('only picks up &-marked tokens', () => {
    const text = 'compare &./a.png with ./b.png and talk about Example.jpg';
    expect(extractPathTokens(text).map((t) => t.path)).toEqual(['./a.png']);
  });

  test('finds multiple marked tokens of any path shape, marker stripped', () => {
    const text = 'see &./a.png and &/tmp/b.jpg and &~/c.webp and &screenshot';
    expect(extractPathTokens(text).map((t) => t.path)).toEqual(['./a.png', '/tmp/b.jpg', '~/c.webp', 'screenshot']);
  });

  test('returns nothing when no token is marked', () => {
    expect(extractPathTokens('open ./a.png and src/main.ts')).toEqual([]);
    expect(extractPathTokens('rename Example.jpg later')).toEqual([]);
  });

  test('de-duplicates repeated marked paths, keeping first occurrence', () => {
    const tokens = extractPathTokens('&./a.png then again &./a.png');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('./a.png');
  });

  test('preserves the raw substring (incl. marker) for verbatim replacement', () => {
    const tokens = extractPathTokens('look at &./a.png.');
    expect(tokens[0].path).toBe('./a.png');
    expect(tokens[0].raw).toBe('&./a.png.');
  });

  test('ignores a bare marker with no path', () => {
    expect(extractPathTokens('a & b')).toEqual([]);
  });
});

describe('rewriteWithRefs', () => {
  test('replaces the raw marked token with a tagged reference including the note', () => {
    const out = rewriteWithRefs('look at &./a.png now', [{ raw: '&./a.png', name: 'a.png', note: '1024x768' }]);
    expect(out).toBe('look at <image name="a.png">1024x768</image> now');
  });

  test('omits the note when absent and drops the marker', () => {
    const out = rewriteWithRefs('see &./a.png', [{ raw: '&./a.png', name: 'a.png' }]);
    expect(out).toBe('see <image name="a.png"></image>');
  });

  test('replaces each attached token, leaving unrelated text intact', () => {
    const out = rewriteWithRefs('a &./x.png b &/y.jpg c', [
      { raw: '&./x.png', name: 'x.png', note: '10x10' },
      { raw: '&/y.jpg', name: 'y.jpg', note: '20x20' },
    ]);
    expect(out).toBe('a <image name="x.png">10x10</image> b <image name="y.jpg">20x20</image> c');
  });
});
