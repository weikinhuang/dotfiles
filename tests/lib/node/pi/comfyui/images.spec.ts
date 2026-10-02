/**
 * Tests for lib/node/pi/comfyui/images.ts.
 */

import { describe, expect, test } from 'vitest';

import { mediaKindFromName, mediaMimeFromName, mimeFromName } from '../../../../../lib/node/pi/comfyui/images.ts';

describe('mimeFromName', () => {
  test('maps known image extensions case-insensitively', () => {
    expect(mimeFromName('a.png')).toBe('image/png');
    expect(mimeFromName('a.jpg')).toBe('image/jpeg');
    expect(mimeFromName('a.JPEG')).toBe('image/jpeg');
    expect(mimeFromName('a.webp')).toBe('image/webp');
    expect(mimeFromName('a.GIF')).toBe('image/gif');
  });

  test('falls back to png for unknown or extensionless names', () => {
    expect(mimeFromName('output')).toBe('image/png');
    expect(mimeFromName('a.bin')).toBe('image/png');
    expect(mimeFromName('')).toBe('image/png');
  });
});

describe('media output classification', () => {
  test('recognizes common video and audio formats', () => {
    expect(mediaMimeFromName('clip.mp4')).toBe('video/mp4');
    expect(mediaMimeFromName('clip.webm')).toBe('video/webm');
    expect(mediaMimeFromName('voice.wav')).toBe('audio/wav');
    expect(mediaMimeFromName('voice.flac')).toBe('audio/flac');
    expect(mediaKindFromName('clip.mp4')).toBe('video');
    expect(mediaKindFromName('voice.wav')).toBe('audio');
  });

  test('does not treat an unknown extension as an image', () => {
    expect(mediaMimeFromName('output.bin')).toBe('application/octet-stream');
    expect(mediaKindFromName('output.bin')).toBe('binary');
  });
});
