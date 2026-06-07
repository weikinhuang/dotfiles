/**
 * Tests for the neutral comfyui image-generated event bus (`events.ts`).
 *
 * The bus is globalThis-anchored, so each test resets it via
 * `resetImageGeneratedBus()` to stay independent.
 */

import { beforeEach, expect, test, vi } from 'vitest';

import {
  emitImageGenerated,
  getLastImageGenerated,
  type ImageGeneratedEvent,
  onImageGenerated,
  resetImageGeneratedBus,
} from '../../../../../lib/node/pi/comfyui/events.ts';

const sample: ImageGeneratedEvent = {
  savedPaths: ['/tmp/a.png', '/tmp/b.png'],
  workflow: 'anima',
  prompt: 'a forest at dusk',
  seed: 7,
  background: true,
};

beforeEach(() => {
  resetImageGeneratedBus();
});

test('a subscriber receives emitted events', () => {
  const seen: ImageGeneratedEvent[] = [];
  onImageGenerated((e) => seen.push(e));
  emitImageGenerated(sample);
  expect(seen).toEqual([sample]);
});

test('emitting with no subscribers is a no-op and still records last', () => {
  expect(() => emitImageGenerated(sample)).not.toThrow();
  expect(getLastImageGenerated()).toEqual(sample);
});

test('unsubscribe stops further delivery', () => {
  const fn = vi.fn();
  const off = onImageGenerated(fn);
  emitImageGenerated(sample);
  off();
  emitImageGenerated({ ...sample, workflow: 'txt2img' });
  expect(fn).toHaveBeenCalledTimes(1);
  expect(fn).toHaveBeenCalledWith(sample);
});

test('a throwing listener does not break the producer or other listeners', () => {
  const good = vi.fn();
  onImageGenerated(() => {
    throw new Error('boom');
  });
  onImageGenerated(good);
  expect(() => emitImageGenerated(sample)).not.toThrow();
  expect(good).toHaveBeenCalledWith(sample);
});

test('multiple subscribers all receive the event', () => {
  const a = vi.fn();
  const b = vi.fn();
  onImageGenerated(a);
  onImageGenerated(b);
  emitImageGenerated(sample);
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(1);
});

test('getLastImageGenerated tracks the most recent event', () => {
  expect(getLastImageGenerated()).toBeNull();
  emitImageGenerated(sample);
  const second = { ...sample, workflow: 'txt2img', seed: 9 };
  emitImageGenerated(second);
  expect(getLastImageGenerated()).toEqual(second);
});

test('reset clears listeners and the last event', () => {
  const fn = vi.fn();
  onImageGenerated(fn);
  emitImageGenerated(sample);
  resetImageGeneratedBus();
  expect(getLastImageGenerated()).toBeNull();
  emitImageGenerated(sample);
  expect(fn).toHaveBeenCalledTimes(1);
});
