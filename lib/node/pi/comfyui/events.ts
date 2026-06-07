/**
 * Neutral image-generation event bus for the `comfyui` extension.
 *
 * The `comfyui` extension EMITS an {@link ImageGeneratedEvent} every time a
 * `generate_image` render finishes and its PNG(s) land on disk - whether the
 * call ran in the foreground, was auto-downloaded by the poll timer, or was
 * collected via `image_jobs`. It does NOT know or care who listens: emitting to
 * zero subscribers is a no-op.
 *
 * OTHER extensions (today `roleplay`, which mirrors the latest scene render into
 * the avatar's `scene` banner) SUBSCRIBE via {@link onImageGenerated}. This
 * keeps comfyui decoupled from roleplay and from the avatar: comfyui depends on
 * nothing, the consumer depends on this small stable event contract rather than
 * on comfyui's internal tool-result detail shape.
 *
 * Anchored on `globalThis` behind a `Symbol.for()` key (the
 * `cross-extension-singleton-pattern`): pi gives each extension its own jiti
 * instance with `moduleCache: false`, so a plain module-level emitter would not
 * be shared across the comfyui + roleplay extensions.
 *
 * Pure module - no pi imports.
 */

import { createGlobalSlot } from '../global-slot.ts';

/** Payload published when a `generate_image` render completes and is saved. */
export interface ImageGeneratedEvent {
  /** Absolute path(s) of the saved PNG(s), in render order. */
  readonly savedPaths: readonly string[];
  /** Workflow name the image was rendered with (e.g. `anima`, `txt2img`). */
  readonly workflow: string;
  /** The positive prompt, when known. */
  readonly prompt?: string;
  /** The resolved seed, when known. */
  readonly seed?: number;
  /** True when the render was a background job (vs a blocking foreground call). */
  readonly background: boolean;
}

type Listener = (event: ImageGeneratedEvent) => void;

interface ImageEventBus {
  listeners: Set<Listener>;
  /** The most recent event, so a late subscriber can catch up on the last render. */
  last: ImageGeneratedEvent | null;
}

const getBus = createGlobalSlot<ImageEventBus>('@dotfiles/pi/comfyui/image-events', () => ({
  listeners: new Set(),
  last: null,
}));

/**
 * Subscribe to image-generated events. Returns an unsubscribe function the
 * caller MUST invoke on teardown (`session_shutdown`) so a reloaded extension
 * instance does not leak stale listeners onto the shared bus.
 */
export function onImageGenerated(listener: Listener): () => void {
  const bus = getBus();
  bus.listeners.add(listener);
  return () => {
    bus.listeners.delete(listener);
  };
}

/**
 * Emit an image-generated event to every subscriber. A throwing listener is
 * swallowed: a broken consumer must never break image generation itself.
 */
export function emitImageGenerated(event: ImageGeneratedEvent): void {
  const bus = getBus();
  bus.last = event;
  for (const listener of bus.listeners) {
    try {
      listener(event);
    } catch {
      /* a stale / broken consumer must not break the producer */
    }
  }
}

/** The most recent emitted event, or `null` if none yet this process. */
export function getLastImageGenerated(): ImageGeneratedEvent | null {
  return getBus().last;
}

/** Drop all listeners and the cached last event. Test/teardown helper. */
export function resetImageGeneratedBus(): void {
  const bus = getBus();
  bus.listeners.clear();
  bus.last = null;
}
