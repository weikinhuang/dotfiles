/**
 * Tests for lib/node/pi/comfyui/summary.ts.
 */

import { describe, expect, test } from 'vitest';

import type { SendDecision } from '../../../../../lib/node/pi/comfyui/config.ts';
import {
  imageCountNote,
  notSentNote,
  type RenderedImageSummary,
  seedNote,
  summarizeRenderedImages,
} from '../../../../../lib/node/pi/comfyui/summary.ts';

const SENT: SendDecision = { send: true, visionBlocked: false };
const NOT_SENT: SendDecision = { send: false, visionBlocked: false };
const VISION_BLOCKED: SendDecision = { send: false, visionBlocked: true };

describe('imageCountNote', () => {
  test('singular for one image', () => {
    expect(imageCountNote(1)).toBe('1 image');
  });
  test('plural otherwise (including zero)', () => {
    expect(imageCountNote(0)).toBe('0 images');
    expect(imageCountNote(2)).toBe('2 images');
  });
});

describe('seedNote', () => {
  test('formats a known seed', () => {
    expect(seedNote(42)).toBe(' (seed 42)');
    expect(seedNote(0)).toBe(' (seed 0)');
  });
  test('empty when unknown', () => {
    expect(seedNote(undefined)).toBe('');
  });
});

describe('notSentNote', () => {
  test('empty when the image is being sent', () => {
    expect(notSentNote(SENT)).toBe('');
  });
  test('plain note when sendToModel is off', () => {
    expect(notSentNote(NOT_SENT)).toBe(' (image not sent to model)');
  });
  test('vision-blocked note when the model lacks image input', () => {
    expect(notSentNote(VISION_BLOCKED)).toBe(' (active model has no image input; not sent to model)');
  });
});

describe('summarizeRenderedImages', () => {
  const base: RenderedImageSummary = {
    verb: 'Generated',
    count: 1,
    workflow: 'anima',
    saveDir: '/tmp/out',
    decision: SENT,
  };

  test('foreground render with generation id + seed', () => {
    expect(summarizeRenderedImages({ ...base, count: 2, idNote: ' [g3]', seed: 7 })).toBe(
      'Generated 2 images [g3] via "anima" (seed 7). Saved to /tmp/out.',
    );
  });

  test('appends the not-sent note from the decision', () => {
    expect(summarizeRenderedImages({ ...base, decision: NOT_SENT })).toBe(
      'Generated 1 image via "anima". Saved to /tmp/out. (image not sent to model)',
    );
    expect(summarizeRenderedImages({ ...base, decision: VISION_BLOCKED })).toBe(
      'Generated 1 image via "anima". Saved to /tmp/out. (active model has no image input; not sent to model)',
    );
  });

  test('extra text trails the whole line (e.g. ephemeral marker / enhance note)', () => {
    expect(summarizeRenderedImages({ ...base, extra: ' (ephemeral: shown once, not kept in context)' })).toBe(
      'Generated 1 image via "anima". Saved to /tmp/out. (ephemeral: shown once, not kept in context)',
    );
  });

  test('collect path: fromJob segment sits between count and generation id', () => {
    expect(
      summarizeRenderedImages({
        ...base,
        verb: 'Collected',
        count: 1,
        fromJob: ' from [j1]',
        idNote: ' (g5)',
        workflow: 'flux2-edit',
        seed: 99,
        saveDir: '/imgs',
      }),
    ).toBe('Collected 1 image from [j1] (g5) via "flux2-edit" (seed 99). Saved to /imgs.');
  });
});
