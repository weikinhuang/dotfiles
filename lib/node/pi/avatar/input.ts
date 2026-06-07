/**
 * Neutral cross-extension input channel for the avatar widget.
 *
 * The `avatar` extension owns rendering; OTHER extensions (today
 * `roleplay`) drive *what* it shows by writing this slot. Two inputs:
 *
 *   - `emoteSet` - a preferred sprite-set name. The avatar prefers it
 *     over its model-glob resolution when the named set resolves to a
 *     real directory, so a roleplay cast can put its character's face on
 *     the avatar. Cleared (empty) -> the avatar falls back to model-glob.
 *   - `image` - an arbitrary override image shown in place of the sprite
 *     (a character portrait, a generated scene). `width` is an optional
 *     render-width hint in columns for images that want more room than
 *     the small reactive face (used by scene illustration). Cleared
 *     (undefined) -> the avatar shows its normal animated sprite.
 *
 * Anchored on `globalThis` behind a `Symbol.for()` key (the
 * `cross-extension-singleton-pattern`): pi gives each extension its own
 * jiti instance with `moduleCache: false`, so a plain module-level
 * variable would NOT be shared across the avatar + roleplay extensions.
 *
 * `rev` bumps on every mutation so a reader (the avatar) can cheaply
 * detect "did my input change since I last resolved?" without diffing.
 *
 * Pure module - no pi imports. Neither extension hard-depends on the
 * other: if the avatar is absent the setter just writes a slot nobody
 * reads; if the writer is absent the avatar reads an empty slot and
 * behaves exactly as before.
 */

import { createGlobalSlot } from '../global-slot.ts';

export interface AvatarOverrideImage {
  /** Absolute path to a PNG the avatar should render in place of the sprite. */
  readonly path: string;
  /** Optional render-width hint in columns (scene images want more than the face's `size`). */
  readonly width?: number;
}

export interface AvatarInput {
  /** Preferred sprite-set name; avatar prefers it over model-glob resolution when it resolves. */
  readonly emoteSet?: string;
  /** Override image shown instead of the sprite; absent = normal animated sprite. */
  readonly image?: AvatarOverrideImage;
}

interface AvatarInputSlot {
  input: AvatarInput;
  rev: number;
}

const getSlot = createGlobalSlot<AvatarInputSlot>('@dotfiles/pi/avatar/input', () => ({ input: {}, rev: 0 }));

/**
 * Merge a partial input into the slot and bump `rev`. Patch semantics:
 * a key present with a falsy value clears that field; a key absent is
 * left untouched. So `setAvatarInput({ emoteSet: '' })` clears only the
 * set and leaves any override image in place.
 */
export function setAvatarInput(patch: Partial<AvatarInput>): void {
  const slot = getSlot();
  const next: { emoteSet?: string; image?: AvatarOverrideImage } = { ...slot.input };
  if ('emoteSet' in patch) {
    const v = patch.emoteSet?.trim();
    if (v) next.emoteSet = v;
    else delete next.emoteSet;
  }
  if ('image' in patch) {
    if (patch.image) next.image = patch.image;
    else delete next.image;
  }
  slot.input = next;
  slot.rev += 1;
}

export function getAvatarInput(): AvatarInput {
  return getSlot().input;
}

/** Monotonic revision counter - changes on every `setAvatarInput` / `clearAvatarInput`. */
export function getAvatarInputRev(): number {
  return getSlot().rev;
}

/** Reset both inputs to empty and bump `rev`. */
export function clearAvatarInput(): void {
  const slot = getSlot();
  slot.input = {};
  slot.rev += 1;
}
