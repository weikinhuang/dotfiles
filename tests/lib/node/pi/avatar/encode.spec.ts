/**
 * Tests for lib/node/pi/avatar/encode.ts.
 */

import { describe, expect, test } from 'vitest';

import { encodeITermImage, encodeKittyImage } from '../../../../../lib/node/pi/avatar/encode.ts';

const ESC = '\x1b';
const ST = '\x1b\\';

describe('encodeKittyImage', () => {
  test('single chunk for a small payload', () => {
    const out = encodeKittyImage('AAAA', { cols: 8, rows: 4 });
    expect(out).toBe(`${ESC}_Ga=T,f=100,c=8,r=4,C=1,q=2;AAAA${ST}`);
  });

  test('chunks payloads larger than 4096 with m=1 continuations', () => {
    const payload = 'x'.repeat(4096 + 100);
    const out = encodeKittyImage(payload, { cols: 8, rows: 4 });
    // First chunk carries the control keys plus m=1.
    expect(out.startsWith(`${ESC}_Ga=T,f=100,c=8,r=4,C=1,q=2,m=1;`)).toBe(true);
    // Exactly one continuation chunk, terminating with m=0.
    expect(out).toContain(`${ESC}_Gm=0;`);
    expect(out.split(ST).filter((s) => s.length > 0)).toHaveLength(2);
  });
});

describe('encodeITermImage', () => {
  test('emits an OSC 1337 inline-image sequence sized in cells', () => {
    const out = encodeITermImage('AAAA', { cols: 8, rows: 4 });
    expect(out).toBe(`${ESC}]1337;File=inline=1;width=8;height=4;preserveAspectRatio=1:AAAA\x07`);
  });

  test('includes size= when a byte length is provided', () => {
    const out = encodeITermImage('AAAA', { cols: 8, rows: 4 }, 512);
    expect(out).toContain(';size=512:');
  });

  test('omits size= for zero / undefined byte length', () => {
    expect(encodeITermImage('AAAA', { cols: 8, rows: 4 }, 0)).not.toContain('size=');
    expect(encodeITermImage('AAAA', { cols: 8, rows: 4 })).not.toContain('size=');
  });
});
