/** UI-only projections owned by the exact TUI row that executed a tool. */
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';

/** Derive this public type because the SDK does not re-export ToolRenderContext. */
export type LiveCardRenderContext = Omit<Parameters<NonNullable<ToolDefinition['renderCall']>>[2], 'state'> & {
  state: object;
};

export interface LiveCardSnapshot<T> {
  value: T;
  /** Keep refreshing while work (or a schedule) can still change. */
  active: boolean;
  /** Keep observing explicit refreshes while paused, without a polling timer. */
  watch?: boolean;
}

type RowContext = Pick<LiveCardRenderContext, 'toolCallId' | 'state' | 'executionStarted' | 'isPartial' | 'invalidate'>;

interface LiveRow<T> {
  id: string;
  read: (() => LiveCardSnapshot<T> | undefined) | undefined;
  value: T | undefined;
  invalidate: (() => void) | undefined;
  active: boolean;
}

/**
 * Capture a row before execution, bind it from execute(), then project it from
 * renderResult(). Exports/replayed rows have different state objects and never
 * acquire execution ownership. No tool results, session entries or messages are
 * modified. One demand-driven timer services all active cards in an extension.
 */
export class LiveToolCards<T> {
  private enabled = false;
  private candidates = new Map<string, RowContext>();
  private rows = new WeakMap<object, LiveRow<T>>();
  private observed = new Set<LiveRow<T>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly intervalMs = 500) {}

  /** Call on session start/tree, and reset(false) before shutdown drains. */
  reset(enabled = false): void {
    this.enabled = enabled;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.candidates.clear();
    this.observed.clear();
    this.rows = new WeakMap();
  }

  /** Called by renderCall, before the host marks execution as started. */
  capture(context: RowContext): void {
    if (!this.enabled || context.executionStarted || this.rows.has(context.state)) return;
    this.candidates.set(context.toolCallId, context);
  }

  /** Called only by the actual invocation, once its runtime identity is known. */
  bind(toolCallId: string, ctx: Pick<ExtensionContext, 'mode'>, read: () => LiveCardSnapshot<T> | undefined): void {
    const candidate = this.candidates.get(toolCallId);
    this.candidates.delete(toolCallId);
    if (!this.enabled || ctx.mode !== 'tui' || !candidate) return;
    this.rows.set(candidate.state, { id: toolCallId, read, value: undefined, invalidate: undefined, active: false });
  }

  /** Return a live/frozen UI value, or undefined for normal snapshot rendering. */
  read(context: RowContext): T | undefined {
    const row = this.rows.get(context.state);
    if (!row || row.id !== context.toolCallId) {
      if (!context.isPartial && this.candidates.get(context.toolCallId)?.state === context.state) {
        this.candidates.delete(context.toolCallId);
      }
      return undefined;
    }
    row.invalidate = context.invalidate;
    this.sample(row);
    if (row.read && this.enabled) this.observed.add(row);
    else this.observed.delete(row);
    this.syncTimer();
    return row.value;
  }

  /** Flush before pruning/removal, or after a terminal transition is committed. */
  refresh(): void {
    // Invalidating synchronously re-enters renderers, which may reset subscriptions.
    const rows = [...this.observed];
    for (const row of rows) {
      if (!this.enabled || !this.observed.has(row)) continue;
      this.sample(row);
      if (!row.read) this.observed.delete(row);
      try {
        row.invalidate?.();
      } catch {
        // A detached UI must never break background work.
        this.observed.delete(row);
        row.read = undefined;
      }
      if (!row.read) row.invalidate = undefined;
    }
    this.syncTimer();
  }

  private sample(row: LiveRow<T>): void {
    if (!this.enabled || !row.read) return;
    try {
      const snapshot = row.read();
      if (snapshot) row.value = snapshot.value;
      row.active = snapshot?.active ?? false;
      if (!snapshot || (!snapshot.active && !snapshot.watch)) row.read = undefined;
    } catch {
      // Preserve the last successful view if the source was disposed.
      row.read = undefined;
    }
  }

  private syncTimer(): void {
    if (this.enabled && [...this.observed].some((row) => row.active)) {
      this.timer ??= setInterval(() => this.refresh(), this.intervalMs);
      this.timer.unref?.();
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
