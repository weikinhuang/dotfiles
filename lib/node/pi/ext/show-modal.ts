/**
 * `showModal` - a drop-in wrapper for `ctx.ui.custom(...)` that raises the
 * shared modal-UI flag (`lib/node/pi/ui-activity.ts`) for the lifetime of the
 * component and lowers it when the component closes, even on error.
 *
 * Why: extensions mount interactive components with `ctx.ui.custom(...)`.
 * Inline custom screens share the fullscreen dock with widgets and the footer,
 * so a terminal-sized component can be clipped even when it windows its body.
 * Default to a full-width real overlay with a terminal-relative row budget.
 * The shared activity flag also pauses animators for explicit inline callers.
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
 * so animator extensions pause. Explicit options (including `overlay: false`)
 * still win. Percentage sizing is resolved by pi on every render, unlike an
 * overlayOptions callback, which some pi versions evaluate only at mount time.
 */
export async function showModal<T>(ui: ModalCapableUi, factory: ModalFactory<T>, options?: ModalOptions): Promise<T> {
  enterModalUi();
  try {
    return await ui.custom<T>(factory, {
      overlay: true,
      overlayOptions: {
        width: '100%',
        maxHeight: '100%',
        anchor: 'bottom-center',
        margin: { top: 1, bottom: 1 },
      },
      ...options,
    });
  } finally {
    exitModalUi();
  }
}
