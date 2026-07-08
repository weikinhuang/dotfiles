/**
 * Tests for the neutral comfyui image-generated event contract (`events.ts`):
 * the bus-channel constant and the `isImageGeneratedEvent` payload validator
 * used to narrow the untyped `pi.events` payload.
 *
 * Transport itself is pi's shared `EventBus` (emit via `ComfyuiRuntime`,
 * subscribe in `roleplay.ts`), so there is nothing stateful to reset here.
 */

import { expect, test } from 'vitest';

import {
  COMFYUI_IMAGE_CHANNEL,
  type ImageGeneratedEvent,
  isImageGeneratedEvent,
} from '../../../../../lib/node/pi/comfyui/events.ts';

const sample: ImageGeneratedEvent = {
  savedPaths: ['/tmp/a.png', '/tmp/b.png'],
  workflow: 'anima',
  prompt: 'a forest at dusk',
  seed: 7,
  background: true,
};

test('COMFYUI_IMAGE_CHANNEL is the namespaced bus channel', () => {
  expect(COMFYUI_IMAGE_CHANNEL).toBe('comfyui:image-generated');
});

test('isImageGeneratedEvent accepts a full event', () => {
  expect(isImageGeneratedEvent(sample)).toBe(true);
});

test('isImageGeneratedEvent accepts optional prompt/seed omitted', () => {
  expect(isImageGeneratedEvent({ savedPaths: ['/tmp/a.png'], workflow: 'txt2img', background: false })).toBe(true);
});

test('isImageGeneratedEvent rejects malformed / foreign payloads', () => {
  expect(isImageGeneratedEvent(null)).toBe(false);
  expect(isImageGeneratedEvent(undefined)).toBe(false);
  expect(isImageGeneratedEvent('anima')).toBe(false);
  expect(isImageGeneratedEvent({ workflow: 'anima', background: true })).toBe(false); // no savedPaths
  expect(isImageGeneratedEvent({ savedPaths: [1], workflow: 'anima', background: true })).toBe(false); // non-string path
  expect(isImageGeneratedEvent({ savedPaths: ['/tmp/a.png'], background: true })).toBe(false); // no workflow
  expect(isImageGeneratedEvent({ savedPaths: ['/tmp/a.png'], workflow: 'anima' })).toBe(false); // no background
  expect(isImageGeneratedEvent({ ...sample, seed: '7' })).toBe(false); // seed not number
  expect(isImageGeneratedEvent({ ...sample, prompt: 5 })).toBe(false); // prompt not string
});
