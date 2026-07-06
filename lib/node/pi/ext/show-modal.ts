/**
 * `showModal` - a drop-in wrapper for `ctx.ui.custom(...)` that raises the
 * shared modal-UI flag (`lib/node/pi/ui-activity.ts`) for the lifetime of the
 * component and lowers it when the component closes, even on error.
 *
 * Why: extensions mount interactive components with `ctx.ui.custom(...)`.
 * Unless they pass `overlay: true` (most don't), pi mounts them inline in the
 * editor container rather than the overlay stack, so `TUI.hasOverlay()` is
 * false for them and animator extensions (the avatar widget) can't tell a
 * full-screen modal is up - they keep re-rendering and, for an image-protocol
 * avatar, re-emit the sprite on every tick and scroll the screen underneath.
 * Routing the call through `showModal` sets `isModalUiActive()` so those
 * animators pause.
 *
 * Usage is a one-token change at the call site - the factory and options are
 * unchanged, only the receiver moves:
 *
 *   await ctx.ui.custom<T>(factory, options)
 *   -> await showModal<T>(ctx.ui, factory, options)
 *
 * Lives under `ext/` because it imports pi runtime types; the flag itself
 * stays pure in `lib/node/pi/ui-activity.ts`.
 */

import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, OverlayHandle, OverlayOptions, TUI } from '@earendil-works/pi-tui';

import { enterModalUi, exitModalUi } from '../ui-activity.ts';

/** Factory signature accepted by `ctx.ui.custom` / `showModal`. */
export type ModalFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

/** Options accepted by `ctx.ui.custom` / `showModal`. */
export interface ModalOptions {
  overlay?: boolean;
  overlayOptions?: OverlayOptions | (() => OverlayOptions);
  onHandle?: (handle: OverlayHandle) => void;
}

/** Minimal shape of `ctx.ui` that `showModal` needs. */
export interface ModalCapableUi {
  custom<T>(factory: ModalFactory<T>, options?: ModalOptions): Promise<T>;
}

/**
 * Show a modal custom-UI component, flagging the UI as modal for its lifetime
 * so animator extensions pause. Resolves/rejects exactly as `ui.custom` does.
 */
export async function showModal<T>(ui: ModalCapableUi, factory: ModalFactory<T>, options?: ModalOptions): Promise<T> {
  enterModalUi();
  try {
    return await ui.custom<T>(factory, options);
  } finally {
    exitModalUi();
  }
}
