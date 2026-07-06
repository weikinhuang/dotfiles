/**
 * Cross-extension "a modal custom-UI component is on screen" signal.
 *
 * Extensions mount interactive components via `ctx.ui.custom(...)`. Unless
 * they pass `overlay: true` (none of ours do), pi mounts the component into
 * the editor container rather than the overlay stack, so `TUI.hasOverlay()`
 * returns false for them. Animators in *other* extensions (the avatar widget)
 * therefore can't tell that a full-screen modal (the `/scratchpad` notebook,
 * `/todos`, …) is up, and keep re-rendering - which, for an image-protocol
 * avatar, re-emits the sprite (sixel/kitty/iterm2) on every animation tick and
 * scrolls/flickers the screen underneath the modal.
 *
 * This is a globalThis-anchored counter (NOT module-level: pi loads each
 * extension in its own jiti instance with `moduleCache: false`, so a
 * module-level variable would not be shared across extensions - see the
 * `cross-extension-singleton-pattern` reference). A counter (not a boolean)
 * so nested / overlapping modals compose correctly.
 *
 * Producer: `config/pi/extensions/scratchpad.ts` (enter on open, exit on
 * close, reset on `session_shutdown`). Consumer: `config/pi/extensions/
 * avatar.ts` (freezes animation while active). Pure module - no pi imports.
 */

const SLOT_KEY = Symbol.for('@dotfiles/pi/ui-modal-active');

interface Slot {
  count: number;
}

function getSlot(): Slot {
  const g = globalThis as { [SLOT_KEY]?: Slot };
  let slot = g[SLOT_KEY];
  if (!slot) {
    slot = { count: 0 };
    g[SLOT_KEY] = slot;
  }
  return slot;
}

/** Mark that a modal custom-UI component has opened. Pair with `exitModalUi`. */
export function enterModalUi(): void {
  getSlot().count += 1;
}

/** Mark that a modal custom-UI component has closed. Clamped at zero. */
export function exitModalUi(): void {
  const slot = getSlot();
  slot.count = Math.max(0, slot.count - 1);
}

/** True while at least one modal custom-UI component is on screen. */
export function isModalUiActive(): boolean {
  return getSlot().count > 0;
}

/** Force the counter back to zero (call on `session_shutdown` / `/reload`). */
export function resetModalUi(): void {
  getSlot().count = 0;
}
