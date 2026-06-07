/**
 * Tests for lib/node/pi/context-edit/placeholder.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import {
  collapsePlaceholder,
  countLines,
  imagePlaceholder,
  isPlaceholder,
  textPlaceholder,
} from '../../../../../lib/node/pi/context-edit/placeholder.ts';

const MARKER = '\u27e8pi-context-edit\u27e9';

describe('imagePlaceholder', () => {
  test('size-only when no description / dimensions', () => {
    expect(imagePlaceholder({ approxBytes: 1_258_291 })).toBe(`${MARKER} [IMAGE REMOVED \u00b7 ~1.20MB]`);
  });

  test('bare marker when nothing is provided', () => {
    expect(imagePlaceholder()).toBe(`${MARKER} [IMAGE REMOVED]`);
  });

  test('renders dimensions, size, and a quoted description inside the brackets', () => {
    expect(
      imagePlaceholder({
        approxBytes: 1_258_291,
        description: 'a red fox in snow, cinematic lighting',
        width: 1024,
        height: 1024,
      }),
    ).toBe(
      `${MARKER} [IMAGE REMOVED \u00b7 1024\u00d71024 \u00b7 ~1.20MB \u00b7 "a red fox in snow, cinematic lighting"]`,
    );
  });

  test('reason stays OUTSIDE the brackets, description stays inside', () => {
    const out = imagePlaceholder({ reason: 'too big', description: 'a cat', approxBytes: 2048 });
    expect(out).toBe(`${MARKER} [IMAGE REMOVED \u00b7 ~2.0KB \u00b7 "a cat"] - too big`);
  });

  test('omits dimensions unless both width and height are positive', () => {
    expect(imagePlaceholder({ width: 1024 })).toBe(`${MARKER} [IMAGE REMOVED]`);
    expect(imagePlaceholder({ width: 1024, height: 0 })).toBe(`${MARKER} [IMAGE REMOVED]`);
    expect(imagePlaceholder({ width: 1024, height: 768 })).toBe(`${MARKER} [IMAGE REMOVED \u00b7 1024\u00d7768]`);
  });

  test('collapses whitespace and neutralizes inner double-quotes in the caption', () => {
    const out = imagePlaceholder({ description: '  a "loud"\n  banner   sign  ' });
    expect(out).toBe(`${MARKER} [IMAGE REMOVED \u00b7 "a 'loud' banner sign"]`);
  });

  test('is byte-stable - identical inputs render identical bytes', () => {
    const opts = { approxBytes: 4096, description: 'x', width: 512, height: 512, reason: 'r' };
    expect(imagePlaceholder(opts)).toBe(imagePlaceholder({ ...opts }));
  });

  test('an empty / whitespace-only description is dropped (size-only)', () => {
    expect(imagePlaceholder({ approxBytes: 2048, description: '   ' })).toBe(`${MARKER} [IMAGE REMOVED \u00b7 ~2.0KB]`);
  });

  test('every variant is recognized by isPlaceholder', () => {
    expect(isPlaceholder(imagePlaceholder({ description: 'a cat' }))).toBe(true);
    expect(isPlaceholder(imagePlaceholder())).toBe(true);
  });
});

describe('textPlaceholder + collapsePlaceholder (unchanged)', () => {
  test('text placeholder notes lines + bytes', () => {
    const out = textPlaceholder('a\nb\nc', 'noise');
    expect(out.startsWith(`${MARKER} [CONTENT TRIMMED - 3 lines,`)).toBe(true);
    expect(out.endsWith('] - noise')).toBe(true);
  });

  test('collapse placeholder names the tool', () => {
    expect(collapsePlaceholder('bash', undefined)).toBe(`${MARKER} [TOOL CALLED bash]`);
  });

  test('countLines counts newline-delimited lines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one')).toBe(1);
    expect(countLines('one\ntwo')).toBe(2);
  });
});
