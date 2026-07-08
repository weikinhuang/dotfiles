/**
 * Neutral image-generation event contract for the `comfyui` extension: the
 * payload type, the pi event-bus channel it travels on, and a validator for
 * the untyped bus payload.
 *
 * The `comfyui` extension EMITS an {@link ImageGeneratedEvent} on pi's shared
 * event bus under {@link COMFYUI_IMAGE_CHANNEL} every time a `generate_image`
 * render finishes and its PNG(s) land on disk - whether the call ran in the
 * foreground, was auto-downloaded by the poll timer, or was collected via
 * `image_jobs`. It does NOT know or care who listens: emitting to zero
 * subscribers is a no-op.
 *
 * OTHER extensions (today `roleplay`, which mirrors the latest scene render
 * into the avatar's `scene` banner) SUBSCRIBE via
 * `pi.events.on(COMFYUI_IMAGE_CHANNEL, …)`. This keeps comfyui decoupled from
 * roleplay and from the avatar: comfyui depends on nothing, the consumer
 * depends on this small stable event contract rather than on comfyui's
 * internal tool-result detail shape. Payloads arrive untyped (`unknown`), so
 * validate with {@link isImageGeneratedEvent} before use.
 *
 * pi hands every extension the SAME `EventBus` instance (created once in its
 * extension loader), so the channel is shared across extensions without the
 * `globalThis`/`Symbol.for` singleton dance a hand-rolled bus would need under
 * pi's per-extension jiti isolation.
 *
 * Pure module - no pi imports.
 */

/** pi event-bus channel comfyui emits {@link ImageGeneratedEvent}s on. */
export const COMFYUI_IMAGE_CHANNEL = 'comfyui:image-generated';

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

/**
 * Narrow an untyped bus payload to an {@link ImageGeneratedEvent}.
 * Subscribers receive `unknown` from `pi.events.on`, so guard with this
 * before use; it tolerates foreign / malformed payloads by returning `false`.
 */
export function isImageGeneratedEvent(value: unknown): value is ImageGeneratedEvent {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as {
    savedPaths?: unknown;
    workflow?: unknown;
    prompt?: unknown;
    seed?: unknown;
    background?: unknown;
  };
  return (
    Array.isArray(candidate.savedPaths) &&
    candidate.savedPaths.every((p) => typeof p === 'string') &&
    typeof candidate.workflow === 'string' &&
    (candidate.prompt === undefined || typeof candidate.prompt === 'string') &&
    (candidate.seed === undefined || typeof candidate.seed === 'number') &&
    typeof candidate.background === 'boolean'
  );
}
