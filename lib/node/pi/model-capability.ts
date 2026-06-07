/**
 * Tiny pure predicate over a pi `Model`'s declared input modalities.
 *
 * Pi's `Model` object carries `input: ("text" | "image")[]`. Rather than
 * coupling to pi's `Model` type, this helper takes a STRUCTURAL slice
 * (`{ input?: string[] }`) so the module stays pi-free and vitest-able.
 * Consumers pass `event.model` from `model_select`.
 *
 * Pure module - no pi imports.
 */

/**
 * Whether `model` can read images.
 *
 * Returns `(model.input ?? ["text"]).includes("image")`. The `["text"]`
 * default matches pi's own default for an unspecified `input`, so a model
 * pi treats as text-only we also treat as text-only - there is no separate
 * conservative-default judgment.
 */
export function isVisionCapable(model: { input?: string[] }): boolean {
  return (model.input ?? ['text']).includes('image');
}
