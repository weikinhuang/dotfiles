/**
 * Tests for lib/node/pi/png/binary.ts - the shared PNG byte primitives.
 * Pure module.
 */

import { describe, expect, test } from 'vitest';

import { PNG_SIGNATURE, hasPngSignature, readUint32BE } from '../../../../../lib/node/pi/png/binary.ts';

describe('hasPngSignature', () => {
  test('true for the exact signature (with trailing bytes)', () => {
    expect(hasPngSignature(Uint8Array.from([...PNG_SIGNATURE, 0x00, 0x01]))).toBe(true);
  });

  test('false when a signature byte differs', () => {
    const bytes = Uint8Array.from(PNG_SIGNATURE);
    bytes[3] = 0x00;
    expect(hasPngSignature(bytes)).toBe(false);
  });

  test('false when shorter than the signature', () => {
    expect(hasPngSignature(Uint8Array.from(PNG_SIGNATURE.slice(0, 4)))).toBe(false);
    expect(hasPngSignature(new Uint8Array(0))).toBe(false);
  });
});

describe('readUint32BE', () => {
  test('reads a big-endian uint32', () => {
    expect(readUint32BE(Uint8Array.from([0x00, 0x00, 0x00, 0x0d]), 0)).toBe(13);
    expect(readUint32BE(Uint8Array.from([0x12, 0x34, 0x56, 0x78]), 0)).toBe(0x12345678);
  });

  test('stays unsigned for a high top byte (no sign flip)', () => {
    expect(readUint32BE(Uint8Array.from([0xff, 0xff, 0xff, 0xff]), 0)).toBe(0xffffffff);
    expect(readUint32BE(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), 0)).toBe(0x89504e47);
  });

  test('honours the offset', () => {
    expect(readUint32BE(Uint8Array.from([0xaa, 0xbb, 0x00, 0x00, 0x00, 0x2a]), 2)).toBe(42);
  });

  test('missing trailing bytes read as 0 (no NaN)', () => {
    expect(readUint32BE(Uint8Array.from([0x00, 0x00, 0x01]), 0)).toBe(0x000001 * 0x100);
    expect(readUint32BE(new Uint8Array(0), 0)).toBe(0);
  });
});
