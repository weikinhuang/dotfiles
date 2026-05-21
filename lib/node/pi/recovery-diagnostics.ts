/**
 * Diagnostics factory shared by the small recovery / detector extensions
 * (`edit-recovery`, `tool-arg-recovery`, `loop-breaker`,
 * `read-reread-detector`). Each one wanted the same pair of helpers:
 *
 *   - `trace(msg)`: append `[<label>] <msg>\n` to a per-extension trace
 *     file when one is configured; otherwise no-op. Errors during the
 *     append are swallowed - diagnostics must never break a turn.
 *
 *   - `notify(ctx, msg, level?)`: forward to `ctx.ui.notify` only when
 *     the extension's `*_DEBUG` flag is on AND the host actually has a
 *     UI. Defaults to `'info'` when no level is supplied.
 *
 * The four call sites previously inlined byte-identical (or near-
 * identical) bodies, with subtle drift: some checked `ctx.hasUI`, some
 * did not. The factory unifies on the safer "gate on `hasUI`" rule.
 *
 * Pi-free: the `notify` half accepts a structural context slice declared
 * locally, matching the pattern from `approval-prompt.ts` / `bash-gate.ts`.
 */

import { appendFileSync } from 'node:fs';

/**
 * Structural slice of `ExtensionContext` - just the fields `notify`
 * touches. Pi's `ExtensionContext` is structurally assignable.
 */
export interface NotifyContext {
  hasUI: boolean;
  ui: { notify(msg: string, level: 'info' | 'warning' | 'error'): void };
}

export type NotifyLevel = 'info' | 'warning' | 'error';

export interface DiagnosticsOptions {
  /** Human-readable tag, e.g. `'edit-recovery'`. Wrapped in `[…]`. */
  label: string;
  /** Path from `process.env.PI_<X>_TRACE`. Falsy disables tracing. */
  tracePath: string | undefined;
  /** Whether the debug flag is set. Falsy disables `notify`. */
  debug: boolean;
}

export interface RecoveryDiagnostics {
  // Arrow-function property types (not method signatures) so callers can
  // destructure `{ trace, notify }` without tripping oxlint's
  // `unbound-method` rule - the bind is intrinsic to the arrow.
  trace: (msg: string) => void;
  notify: (ctx: NotifyContext, msg: string, level?: NotifyLevel) => void;
}

export function makeDiagnostics(opts: DiagnosticsOptions): RecoveryDiagnostics {
  const { label, tracePath, debug } = opts;
  // Arrow functions (not object-literal methods) so callers can
  // destructure `{ trace, notify }` without tripping oxlint's
  // `unbound-method` rule.
  const trace = (msg: string): void => {
    if (!tracePath) return;
    try {
      appendFileSync(tracePath, `[${label}] ${msg}\n`, 'utf8');
    } catch {
      /* diagnostics must never break a turn */
    }
  };
  const notify = (ctx: NotifyContext, msg: string, level: NotifyLevel = 'info'): void => {
    if (debug && ctx.hasUI) ctx.ui.notify(msg, level);
  };
  return { trace, notify };
}
