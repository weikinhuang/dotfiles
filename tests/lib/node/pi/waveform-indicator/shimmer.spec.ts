/**
 * Tests for lib/node/pi/waveform-indicator/shimmer.ts.
 */

/* oxlint-disable no-control-regex -- this whole file inspects ANSI SGR escapes */

import { describe, expect, test } from 'vitest';

import { shimmerLabel } from '../../../../../lib/node/pi/waveform-indicator/shimmer.ts';

const SGR_RE = /\x1b\[[0-9;]*m/g;
const TRUECOLOR_FG_RE = /\x1b\[38;2;\d+;\d+;\d+m/g;
const FG_RESET_RE = /\x1b\[39m/g;

function stripAnsi(s: string): string {
  return s.replace(SGR_RE, '');
}

describe('shimmerLabel', () => {
  test('preserves character order when ANSI is stripped', () => {
    const out = shimmerLabel('Thinking...', 0);

    expect(stripAnsi(out)).toBe('Thinking...');
  });

  test('wraps each non-whitespace character in its own SGR pair', () => {
    const out = shimmerLabel('abc', 0);

    expect(out.match(TRUECOLOR_FG_RE)).toHaveLength(3);
    expect(out.match(FG_RESET_RE)).toHaveLength(3);
  });

  test('does NOT colorize whitespace', () => {
    const out = shimmerLabel('a b', 0);

    // Two visible chars → two color escapes; the space passes through raw.
    expect(out.match(TRUECOLOR_FG_RE)).toHaveLength(2);
    expect(out).toContain(' ');
  });

  test('handles empty string', () => {
    expect(shimmerLabel('', 0)).toBe('');
  });

  test('different ticks produce different output (label shimmers)', () => {
    const a = shimmerLabel('Thinking...', 0);
    const b = shimmerLabel('Thinking...', 30);

    expect(a).not.toBe(b);
  });

  test('iterates by code point so multi-byte glyphs get one color', () => {
    // U+1F4A1 (light bulb) is 2 UTF-16 code units but one code point.
    const out = shimmerLabel('💡!', 0);

    expect(out.match(TRUECOLOR_FG_RE)).toHaveLength(2);
  });
});
