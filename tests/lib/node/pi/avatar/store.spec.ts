/**
 * Tests for lib/node/pi/avatar/store.ts.
 */

import { describe, expect, test, vi } from 'vitest';

import {
  type RenderedFrame,
  asciiFramesToLines,
  lazyImageState,
  readyState,
  wrapIndex,
} from '../../../../../lib/node/pi/avatar/store.ts';

const textFrame = (line: string): RenderedFrame => ({ kind: 'text', lines: [line] });

describe('wrapIndex', () => {
  test('leaves in-range indices untouched', () => {
    expect(wrapIndex(0, 3)).toBe(0);
    expect(wrapIndex(2, 3)).toBe(2);
  });

  test('wraps positive overflow', () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(4, 3)).toBe(1);
  });

  test('wraps negatives from the end', () => {
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(-4, 3)).toBe(2);
  });
});

describe('readyState', () => {
  test('reports length and returns frames in range', () => {
    const frames = [textFrame('a'), textFrame('b')];
    const state = readyState(frames);
    expect(state.length).toBe(2);
    expect(state.frameAt(0)).toBe(frames[0]);
    expect(state.frameAt(1)).toBe(frames[1]);
  });

  test('returns null out of range', () => {
    const state = readyState([textFrame('a')]);
    expect(state.frameAt(-1)).toBeNull();
    expect(state.frameAt(1)).toBeNull();
  });
});

describe('lazyImageState', () => {
  test('builds each frame at most once and memoises the result', () => {
    const build = vi.fn((path: string) => textFrame(path));
    const state = lazyImageState(['x.png', 'y.png'], build);
    expect(state.length).toBe(2);

    expect(state.frameAt(0)).toEqual(textFrame('x.png'));
    expect(state.frameAt(0)).toEqual(textFrame('x.png'));
    expect(build).toHaveBeenCalledTimes(1);

    expect(state.frameAt(1)).toEqual(textFrame('y.png'));
    expect(build).toHaveBeenCalledTimes(2);
  });

  test('memoises a null build result (never re-invokes the builder)', () => {
    const build = vi.fn(() => null);
    const state = lazyImageState(['x.png'], build);
    expect(state.frameAt(0)).toBeNull();
    expect(state.frameAt(0)).toBeNull();
    expect(build).toHaveBeenCalledTimes(1);
  });

  test('returns null out of range without invoking the builder', () => {
    const build = vi.fn(() => textFrame('a'));
    const state = lazyImageState(['x.png'], build);
    expect(state.frameAt(-1)).toBeNull();
    expect(state.frameAt(5)).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });
});

describe('asciiFramesToLines', () => {
  test('wraps a bare string into a single frame', () => {
    expect(asciiFramesToLines('face')).toEqual(['face']);
  });

  test('passes an array through unchanged', () => {
    expect(asciiFramesToLines(['a', 'b'])).toEqual(['a', 'b']);
  });

  test('takes the values of a record in insertion order', () => {
    expect(asciiFramesToLines({ one: 'a', two: 'b' })).toEqual(['a', 'b']);
  });
});
