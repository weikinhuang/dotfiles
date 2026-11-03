/**
 * Cross-extension "a modal custom-UI component is on screen" signal.
 *
 * `ext/show-modal.ts` raises this signal for every modal interaction, including
 * explicit inline custom screens, which `TUI.hasOverlay()` cannot detect.
 * Animators in other extensions (the avatar widget) pause while it is active,
 * avoiding image re-emission and flicker underneath an interactive screen.
 *
 * This is a globalThis-anchored counter (NOT module-level: pi loads each
 * extension in its own jiti instance with `moduleCache: false`, so a
 * module-level variable would not be shared across extensions - see the
 * `cross-extension-singleton-pattern` reference). A counter (not a boolean)
 * so nested / overlapping modals compose correctly.
 *
 * Producer: `ext/show-modal.ts` (enter on open, exit on close; reset by
 * extensions on `session_shutdown`). Consumer: `config/pi/extensions/
 * avatar.ts` (freezes animation while active). Pure module - no pi imports.
 */

import { createGlobalSlot } from './global-slot.ts';

interface Slot {
  count: number;
}

const getSlot = createGlobalSlot<Slot>('@dotfiles/pi/ui-modal-active', () => ({ count: 0 }));

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
