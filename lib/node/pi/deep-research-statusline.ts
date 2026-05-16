/* Read "Internals" at the bottom - public API comes first. The
 * `no-use-before-define` rule is disabled at the file scope because
 * TS function declarations are hoisted and this ordering reads
 * top-down (public API → helpers). */
/* eslint-disable no-use-before-define */

/**
 * Statusline state machine for the deep-research pipeline.
 *
 * Phase 5 of `plans/pi-deep-research.md` asks the extension to
 * surface a statusline widget via `ctx.ui.setWidget("deep-research",
 * [...])` that shows:
 *
 *   - the current phase (`planning / self-crit / plan-crit /
 *     fanout 3/6 / synth 2/6 / merge / structural / subjective`),
 *   - cost-so-far (USD),
 *   - wall-clock elapsed.
 *
 * This module is pure: it exposes a reducer that folds
 * {@link PhaseEvent}s into {@link StatuslineState}, plus a renderer
 * that turns the state into the widget body (a `string[]`). The
 * extension shell calls the reducer on every phase transition the
 * pipeline emits and hands the rendered lines to
 * `ctx.ui.setWidget(...)`.
 *
 * The shape is deliberately minimal:
 *
 *   - One discriminated `PhaseEvent` per transition, so tests can
 *     script transitions as a flat array and diff the rendered
 *     widget.
 *   - No clock coupling inside the reducer - the caller passes
 *     `now` when it wants elapsed-time rendering.
 *   - No pi imports.
 *
 * The state also tracks a cumulative `costUsd` field; in v1 the
 * extension does not yet wire a cost counter (pi's cost accounting
 * is per-session and not trivially attributable to a single
 * research run), so the field stays at $0.00 unless the caller
 * emits `cost` events explicitly. The schema is nonetheless here so
 * a later commit can add cost deltas without reshaping the widget.
 */

// ──────────────────────────────────────────────────────────────────────
// Public types.
// ──────────────────────────────────────────────────────────────────────

/**
 * High-level phase the pipeline is currently in. Mirrors the
 * pipeline's own macro stages + the two review phases that land
 * after synthesis.
 */
export type PhaseKind =
  | 'idle'
  | 'planning'
  | 'self-crit'
  | 'plan-crit'
  | 'fanout'
  | 'synth'
  | 'merge'
  | 'structural'
  | 'subjective'
  | 'done'
  | 'error';

/**
 * Discriminated transition event. The extension wires the pipeline
 * (and the review wire) to emit these; the state machine folds
 * them into {@link StatuslineState}.
 */
export type PhaseEvent =
  /** Sent once at the start of a run, before any other event. */
  | { kind: 'start' }
  | { kind: 'planning' }
  | { kind: 'self-crit' }
  | { kind: 'plan-crit' }
  /** Fanout begins; `total` is the number of sub-questions. */
  | { kind: 'fanout-start'; total: number }
  /** Fanout progresses; `done` is cumulative completed+failed+aborted. */
  | { kind: 'fanout-progress'; done: number; total?: number }
  /** Synth begins; `total` is the number of sections. */
  | { kind: 'synth-start'; total: number }
  /** Synth progresses; `done` is sections whose outcome has been emitted. */
  | { kind: 'synth-progress'; done: number; total?: number }
  | { kind: 'merge' }
  /** Structural review starts a new iteration. */
  | { kind: 'structural'; iteration: number }
  /** Subjective critic runs its iteration. */
  | { kind: 'subjective'; iteration: number }
  /** Add to the cumulative cost counter (USD). */
  | { kind: 'cost'; deltaUsd: number }
  /** Pipeline completed successfully. `message` is a short summary. */
  | { kind: 'done'; message?: string }
  /** Pipeline aborted / errored. `message` carries the reason. */
  | { kind: 'error'; message: string };

/** Machine-readable snapshot of the current widget state. */
export interface StatuslineState {
  phase: PhaseKind;
  /** Human label suitable for the top line - e.g. `"fanout 3/6"`. */
  label: string;
  /** `Date.now()` at the moment the run started. */
  startedAt: number;
  /** Cumulative cost in USD. */
  costUsd: number;
  fanout: { done: number; total: number };
  synth: { done: number; total: number };
  reviewIter: number;
  /** Terminal message on `done` / `error`. */
  message?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Initial state + reducer.
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the idle initial state. `now` is inlined into `startedAt`
 * so the renderer can compute elapsed time without re-reading it.
 */
export function initialStatuslineState(now = Date.now()): StatuslineState {
  return {
    phase: 'idle',
    label: 'idle',
    startedAt: now,
    costUsd: 0,
    fanout: { done: 0, total: 0 },
    synth: { done: 0, total: 0 },
    reviewIter: 0,
  };
}

/**
 * Pure reduction step. Does not mutate the input state; callers
 * thread the returned object into their next call. The reducer is
 * total: every event kind is handled without a wildcard fallback,
 * so adding a new kind to `PhaseEvent` breaks the build until the
 * reducer catches up.
 */
export function reduceStatusline(state: StatuslineState, event: PhaseEvent): StatuslineState {
  switch (event.kind) {
    case 'start':
      // `start` resets everything except the caller-visible
      // `startedAt` anchor, which is picked by the caller when it
      // built the initial state (so tests can pin it explicitly).
      return {
        ...state,
        phase: 'idle',
        label: 'idle',
        costUsd: 0,
        fanout: { done: 0, total: 0 },
        synth: { done: 0, total: 0 },
        reviewIter: 0,
        ...(state.message !== undefined ? { message: undefined } : {}),
      };
    case 'planning':
      return { ...state, phase: 'planning', label: 'planning' };
    case 'self-crit':
      return { ...state, phase: 'self-crit', label: 'self-crit' };
    case 'plan-crit':
      return { ...state, phase: 'plan-crit', label: 'plan-crit' };
    case 'fanout-start':
      return {
        ...state,
        phase: 'fanout',
        label: formatProgressLabel('fanout', 0, Math.max(0, event.total)),
        fanout: { done: 0, total: Math.max(0, event.total) },
      };
    case 'fanout-progress': {
      const baseTotal = event.total !== undefined ? Math.max(0, event.total) : state.fanout.total;
      const done = Math.max(0, Number.isFinite(event.done) ? event.done : 0);
      // If `done` exceeds the known total (e.g. the extension
      // re-emits a completion that the inner counter doesn't
      // recognize), grow `total` to match so the label stays
      // legible. Shrinking `total` is never safe.
      const total = Math.max(baseTotal, done);
      return {
        ...state,
        phase: 'fanout',
        fanout: { done, total },
        label: formatProgressLabel('fanout', done, total),
      };
    }
    case 'synth-start':
      return {
        ...state,
        phase: 'synth',
        label: formatProgressLabel('synth', 0, Math.max(0, event.total)),
        synth: { done: 0, total: Math.max(0, event.total) },
      };
    case 'synth-progress': {
      const baseTotal = event.total !== undefined ? Math.max(0, event.total) : state.synth.total;
      const done = Math.max(0, Number.isFinite(event.done) ? event.done : 0);
      const total = Math.max(baseTotal, done);
      return {
        ...state,
        phase: 'synth',
        synth: { done, total },
        label: formatProgressLabel('synth', done, total),
      };
    }
    case 'merge':
      return { ...state, phase: 'merge', label: 'merge' };
    case 'structural':
      return {
        ...state,
        phase: 'structural',
        reviewIter: event.iteration,
        label: `structural (iter ${event.iteration})`,
      };
    case 'subjective':
      return {
        ...state,
        phase: 'subjective',
        reviewIter: event.iteration,
        label: `subjective (iter ${event.iteration})`,
      };
    case 'cost':
      return { ...state, costUsd: Math.max(0, state.costUsd + event.deltaUsd) };
    case 'done': {
      const next: StatuslineState = { ...state, phase: 'done', label: 'done' };
      if (event.message !== undefined) next.message = event.message;
      return next;
    }
    case 'error':
      return { ...state, phase: 'error', label: 'error', message: event.message };
  }
}

/**
 * Fold a whole event stream at once. Convenience for tests and for
 * the extension's resume path (when re-hydrating from the journal
 * we can replay events in order to derive the current widget).
 */
export function reduceAllStatusline(
  events: readonly PhaseEvent[],
  initial: StatuslineState = initialStatuslineState(),
): StatuslineState {
  let s = initial;
  for (const e of events) s = reduceStatusline(s, e);
  return s;
}

// ──────────────────────────────────────────────────────────────────────
// Renderer.
// ──────────────────────────────────────────────────────────────────────

/**
 * Produce the widget body (`string[]`) that `ctx.ui.setWidget(...)`
 * expects. Two lines, always:
 *
 *   1. `deep-research: <label>`  (or `<spinner> research: <label>`
 *      when `frame` is passed and the phase is actively working)
 *   2. `  elapsed <Xm YYs> · cost $0.123`
 *
 * A third message line is appended on terminal states so the user
 * sees why the widget stopped updating even if they missed the
 * `ctx.ui.notify` toast.
 *
 * When the extension's statusline controller drives a short-cadence
 * re-render (e.g. every 80ms), it bumps `opts.frame` each tick so
 * the braille spinner rotates - mirroring pi's own "Working…"
 * indicator. Frozen states (`idle` / `done` / `error`) never show
 * the spinner because the run is not doing active work.
 */
export function renderStatuslineWidget(
  state: StatuslineState,
  now: number = Date.now(),
  opts: { frame?: number } = {},
): string[] {
  const spinner = formatSpinner(state.phase, opts.frame);
  const elapsedMs = Math.max(0, now - state.startedAt);
  const lines: string[] = [];
  lines.push(`${spinner}deep-research: ${state.label}`);
  lines.push(`  elapsed ${formatElapsed(elapsedMs)} · cost ${formatCost(state.costUsd)}`);
  if ((state.phase === 'done' || state.phase === 'error') && state.message) {
    lines.push(`  ${state.message}`);
  }
  return lines;
}

/**
 * Braille spinner frames, matching the set pi uses in its own
 * "Working…" indicator. Exported so tests can assert the frame
 * sequence without reaching into this module's internals.
 */
export const SPINNER_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/**
 * Pick the spinner prefix for a given phase + frame counter.
 * Returns the empty string (no prefix) when the phase is a frozen
 * terminal/idle state - a stalled run should not animate.
 *
 * Exported for unit tests; the main renderer inlines it via
 * `formatSpinner` at the top of each render.
 */
export function spinnerPrefix(phase: PhaseKind, frame: number | undefined): string {
  if (frame === undefined) return '';
  if (phase === 'idle' || phase === 'done' || phase === 'error') return '';
  const idx = Math.abs(Math.trunc(frame)) % SPINNER_FRAMES.length;
  return `${SPINNER_FRAMES[idx]} `;
}

function formatSpinner(phase: PhaseKind, frame: number | undefined): string {
  return spinnerPrefix(phase, frame);
}

// ──────────────────────────────────────────────────────────────────────
// Internals.
// ──────────────────────────────────────────────────────────────────────

function formatProgressLabel(prefix: 'fanout' | 'synth', done: number, total: number): string {
  return total > 0 ? `${prefix} ${done}/${total}` : prefix;
}

/**
 * Render a milliseconds value as a compact elapsed string.
 * Examples:
 *   - `7s`
 *   - `1m 05s`
 *   - `1h 23m 04s`
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad2(m)}m ${pad2(s)}s`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Format a USD cost value with three decimal places. */
export function formatCost(usd: number): string {
  const clamped = Math.max(0, usd);
  return `$${clamped.toFixed(3)}`;
}
