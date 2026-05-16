/**
 * Cross-extension session flags.
 *
 * Small singleton shared between pi extensions in this directory.
 * `bash-permissions.ts` is the owner/writer of `bashAuto`; `statusline.ts`
 * reads it to render a ⚡ indicator in the footer.
 *
 * ⚠️  Pi's extension loader (`dist/core/extensions/loader.js`) creates a
 * fresh jiti instance per extension with `moduleCache: false`, so relying
 * on Node's ESM module cache to dedupe `./lib/session-flags.ts` between
 * the two extensions does NOT work - each import produces its own copy
 * with its own module-scoped `let`. To get a real process-wide singleton
 * we anchor the state on `globalThis` behind a symbol key. Every copy of
 * this module reads/writes the same slot, so writes from
 * bash-permissions.ts are visible to statusline.ts.
 */

const STATE_KEY = Symbol.for('@dotfiles/pi/session-flags');

interface SessionFlagsState {
  bashAutoEnabled: boolean;
}

interface GlobalWithState {
  [STATE_KEY]?: SessionFlagsState;
}

function getState(): SessionFlagsState {
  const g = globalThis as GlobalWithState;
  let state = g[STATE_KEY];
  if (!state) {
    state = { bashAutoEnabled: false };
    g[STATE_KEY] = state;
  }
  return state;
}

export function isBashAutoEnabled(): boolean {
  return getState().bashAutoEnabled;
}

export function setBashAutoEnabled(value: boolean): void {
  getState().bashAutoEnabled = value;
}
