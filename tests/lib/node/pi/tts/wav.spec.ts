/**
 * Tests for lib/node/pi/tts/wav.ts - WAV header duration parsing on
 * synthetic headers (no audio files on disk).
 */

import { describe, expect, test } from 'vitest';

import { wavDurationSeconds } from '../../../../../lib/node/pi/tts/wav.ts';

/** Build a mono 16-bit PCM WAV: optional extra chunk before `data`, `payload` bytes of silence. */
function wav(opts: { rate?: number; payload: number; dataSize?: number; extra?: [string, number] }): Uint8Array {
  const rate = opts.rate ?? 24000;
  const extra = opts.extra;
  const extraLen = extra ? 8 + extra[1] + (extra[1] % 2) : 0;
  const buf = new Uint8Array(12 + 24 + extraLen + 8 + opts.payload);
  const view = new DataView(buf.buffer);
  const tag = (at: number, s: string): void => buf.set(new TextEncoder().encode(s), at);
  tag(0, 'RIFF');
  view.setUint32(4, buf.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  let at = 36;
  if (extra) {
    tag(at, extra[0]);
    view.setUint32(at + 4, extra[1], true);
    at += extraLen;
  }
  tag(at, 'data');
  view.setUint32(at + 4, opts.dataSize ?? opts.payload, true);
  return buf;
}

describe('wavDurationSeconds', () => {
  test('reads the duration from fmt byte rate and data size', () => {
    expect(wavDurationSeconds(wav({ payload: 48000 }))).toBe(1);
  });

  test('skips unrelated chunks (odd sizes are word-padded)', () => {
    expect(wavDurationSeconds(wav({ payload: 24000, extra: ['LIST', 7] }))).toBe(0.5);
  });

  test('clamps a streamed 0xFFFFFFFF data size to the bytes present', () => {
    expect(wavDurationSeconds(wav({ payload: 96000, dataSize: 0xffffffff }))).toBe(2);
  });

  test('returns undefined for non-WAV or truncated input', () => {
    expect(wavDurationSeconds(new TextEncoder().encode('ID3\u0004 not a wav file'))).toBeUndefined();
    expect(wavDurationSeconds(new Uint8Array(4))).toBeUndefined();
    expect(wavDurationSeconds(wav({ payload: 0 }).subarray(0, 30))).toBeUndefined();
  });
});
