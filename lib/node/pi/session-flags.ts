/**
 * Cross-extension session flags.
 *
 * Small singleton shared between pi extensions in this directory.
 * Writers / readers in this v1:
 *
 *   - `bash-permissions.ts` writes `bashAutoEnabled`; `statusline.ts`
 *     reads it to render a ⚡ indicator in the footer.
 *   - `sandbox.ts` writes `sandbox` (mode + reason); `statusline.ts`
 *     reads it to render the 🛡️ badge per plan section 7.
 *
 * ⚠️  Pi's extension loader (`dist/core/extensions/loader.js`) creates a
 * fresh jiti instance per extension with `moduleCache: false`, so relying
 * on Node's ESM module cache to dedupe `./lib/session-flags.ts` between
 * the two extensions does NOT work - each import produces its own copy
 * with its own module-scoped `let`. To get a real process-wide singleton
 * we anchor the state on `globalThis` behind a symbol key. Every copy of
 * this module reads/writes the same slot, so writes from one extension
 * are visible in others.
 */

const STATE_KEY = Symbol.for('@dotfiles/pi/session-flags');

/**
 * Visible sandbox modes. `wrapped` is the happy path (kernel sandbox
 * actually rewrites bash); the other states surface a downgraded badge
 * + tooltip in the statusline so the bypass is impossible to miss. See
 * plan section 7's render table.
 */
export type SandboxMode = 'wrapped' | 'bypassed' | 'identity' | 'env-disabled' | 'off';

export interface SandboxState {
  /** Current visible mode. `'off'` is the default before sandbox.ts
   *  initializes (or after `session_shutdown`). */
  mode: SandboxMode;
  /** Optional human-readable reason surfaced in the badge tooltip
   *  (e.g. `"missing deps: bwrap, socat"`, `"PI_SANDBOX_DISABLED=1"`). */
  reason?: string;
}

interface SessionFlagsState {
  bashAutoEnabled: boolean;
  sandbox: SandboxState;
}

interface GlobalWithState {
  [STATE_KEY]?: SessionFlagsState;
}

function getState(): SessionFlagsState {
  const g = globalThis as GlobalWithState;
  let state = g[STATE_KEY];
  if (!state) {
    state = { bashAutoEnabled: false, sandbox: { mode: 'off' } };
    g[STATE_KEY] = state;
  }
  // Defensive: an older copy of this module (from a stale jiti cache
  // on `/reload`) may have populated the slot before `sandbox` existed.
  state.sandbox ??= { mode: 'off' };
  return state;
}

export function isBashAutoEnabled(): boolean {
  return getState().bashAutoEnabled;
}

export function setBashAutoEnabled(value: boolean): void {
  getState().bashAutoEnabled = value;
}

/**
 * Snapshot the current sandbox state. Returns a frozen-ish copy so
 * callers can't mutate the slot through the return value.
 */
export function getSandboxState(): SandboxState {
  const cur = getState().sandbox;
  return cur.reason !== undefined ? { mode: cur.mode, reason: cur.reason } : { mode: cur.mode };
}

/**
 * Publish the current sandbox state. Called by `sandbox.ts` from its
 * `before_agent_start` and `tool_call` paths so the statusline can
 * render the badge per plan section 7.
 */
export function setSandboxState(value: SandboxState): void {
  getState().sandbox = value.reason !== undefined ? { mode: value.mode, reason: value.reason } : { mode: value.mode };
}
