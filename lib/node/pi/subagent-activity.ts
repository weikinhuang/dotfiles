/**
 * Activity-tail primitives for the `/agents:running` overlay.
 *
 * The overlay renders a bounded ring of one-line summaries underneath
 * the per-child preview block. Lines are derived from the child's
 * structured event stream (`AgentSessionEvent`) and / or - for children
 * that have already terminated - from the on-disk JSONL transcript pi
 * persists at `<parentSessionDir>/<parentSid>/subagents/*.jsonl`.
 *
 * Pure module - no pi imports - so it can be unit-tested under `vitest`.
 * The pi-coupled glue (`child.subscribe(...)`) lives in
 * `config/pi/extensions/subagent.ts` and feeds formatted strings into
 * `ActivityRing.push(...)`.
 *
 * See `plans/pi-subagent-overlay.md` §3 for the per-event-type table
 * and follow-mode behaviour.
 */

import { readFileSync } from 'node:fs';

// ──────────────────────────────────────────────────────────────────────
// Event shapes (minimal subset matching `AgentSessionEvent` in pi)
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal structural subset of pi's `AgentSessionEvent` union. We only
 * inspect the fields the formatter cares about; everything else is
 * ignored so the helper survives upstream additions.
 */
export interface ActivityEvent {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  attempt?: number;
  maxAttempts?: number;
  reason?: string;
  errorMessage?: string;
  message?: {
    role?: string;
    content?: unknown;
    errorMessage?: string;
  };
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
}

/** Per-handle cursor state threaded through `formatActivityLine`. */
export interface ActivityFormatState {
  /** True while we're in a `message_update` chain (cursor `▌` is live). */
  streaming: boolean;
  /** Accumulated assistant text for the current streaming chain. */
  streamingText: string;
  /** Last turn index observed via `turn_start`. */
  turn: number;
}

export function makeActivityState(): ActivityFormatState {
  return { streaming: false, streamingText: '', turn: 0 };
}

const TOOL_ARG_CAP = 50;
const MESSAGE_CAP = 160;

function summariseArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return capText(args, TOOL_ARG_CAP);
  if (typeof args === 'number' || typeof args === 'boolean') return String(args);
  if (Array.isArray(args)) {
    return capText(args.map((a) => summariseArgs(a)).join(' '), TOOL_ARG_CAP);
  }
  if (typeof args === 'object') {
    const obj = args as Record<string, unknown>;
    // Prefer common single-argument shapes used by built-in tools.
    const preferred = ['path', 'pattern', 'command', 'query', 'file_path', 'text'];
    for (const key of preferred) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) return capText(v, TOOL_ARG_CAP);
    }
    const first = Object.values(obj).find((v) => typeof v === 'string' && (v as string).length > 0);
    if (typeof first === 'string') return capText(first, TOOL_ARG_CAP);
    return '';
  }
  return '';
}

function summariseResult(result: unknown, isError: boolean | undefined): string {
  if (isError === true) {
    if (typeof result === 'string') return `error: ${capText(result, TOOL_ARG_CAP)}`;
    if (result && typeof result === 'object') {
      const obj = result as { message?: unknown; error?: unknown };
      const msg = obj.message ?? obj.error;
      if (typeof msg === 'string') return `error: ${capText(msg, TOOL_ARG_CAP)}`;
    }
    return 'error';
  }
  if (result == null) return '';
  if (typeof result === 'string') {
    if (result.length === 0) return '0 chars';
    return `${result.length} chars`;
  }
  if (Array.isArray(result)) {
    return `${result.length} item${result.length === 1 ? '' : 's'}`;
  }
  if (typeof result === 'object') {
    const obj = result as { content?: unknown; output?: unknown };
    const c = obj.content ?? obj.output;
    if (typeof c === 'string') return `${c.length} chars`;
    if (Array.isArray(c)) return `${c.length} parts`;
    return 'ok';
  }
  return '';
}

function capText(s: string, cap: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= cap) return collapsed;
  return `${collapsed.slice(0, cap - 1).trimEnd()}…`;
}

function extractAssistantText(message: ActivityEvent['message']): string {
  if (!message || !message.content) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    const parts: string[] = [];
    for (const part of message.content) {
      if (part && typeof part === 'object') {
        const p = part as { type?: string; text?: unknown };
        if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
      }
    }
    return parts.join('');
  }
  return '';
}

// ──────────────────────────────────────────────────────────────────────
// Pure formatter
// ──────────────────────────────────────────────────────────────────────

/**
 * Push-mode for the returned activity line. `streaming` replaces the
 * previous streaming entry in the ring (so the cursor `▌` line updates
 * in place rather than spamming one row per token delta);
 * `streaming-final` drops the cursor on `message_end`; `append`
 * appends a fresh row.
 */
export type ActivityPushMode = 'append' | 'streaming' | 'streaming-final';

/**
 * Inspect the event type to decide how the formatted line should be
 * pushed into an `ActivityRing`. Centralised here so callers (the
 * live-subscribe glue + `tailJsonl`) stay in sync.
 */
export function activityPushModeFor(event: ActivityEvent): ActivityPushMode {
  if (event.type === 'message_update' && event.message?.role === 'assistant') return 'streaming';
  if (event.type === 'message_end' && event.message?.role === 'assistant') return 'streaming-final';
  return 'append';
}

/** Apply a formatted activity line to the ring using the matching push mode. */
export function applyActivityLine(ring: ActivityRing, line: string, mode: ActivityPushMode): void {
  if (mode === 'streaming') ring.pushStreaming(line);
  else if (mode === 'streaming-final') ring.pushStreamingFinal(line);
  else ring.push(line);
}

/**
 * Map a single `AgentSessionEvent` to a one-line activity-tail summary.
 * Returns `null` for events the tail should skip (idle ticks, message
 * boundaries that only matter for cursor state, queue updates, …).
 *
 * Mutates `state` to track the streaming-message cursor + the last-seen
 * turn index. The caller owns the state; `ActivityRing` does not.
 */
export function formatActivityLine(event: ActivityEvent, state: ActivityFormatState): string | null {
  switch (event.type) {
    case 'turn_start': {
      state.turn += 1;
      // Reset any half-finished streaming chain at the turn boundary.
      state.streaming = false;
      state.streamingText = '';
      return `turn ${state.turn}`;
    }
    case 'tool_execution_start': {
      const tool = event.toolName ?? '(tool)';
      const args = summariseArgs(event.args);
      return args ? `→ ${tool}  ${args}` : `→ ${tool}`;
    }
    case 'tool_execution_end': {
      const summary = summariseResult(event.result, event.isError);
      return `← ${summary || 'ok'}`;
    }
    case 'message_update': {
      const role = event.message?.role;
      if (role !== 'assistant') return null;
      const delta = event.assistantMessageEvent?.delta;
      if (typeof delta === 'string' && delta.length > 0) {
        state.streaming = true;
        state.streamingText = `${state.streamingText}${delta}`;
      } else {
        const full = extractAssistantText(event.message);
        if (full.length > state.streamingText.length) {
          state.streaming = true;
          state.streamingText = full;
        }
      }
      if (!state.streaming) return null;
      return `▌ ${capText(state.streamingText, MESSAGE_CAP)}`;
    }
    case 'message_end': {
      const role = event.message?.role;
      if (role !== 'assistant') return null;
      if (!state.streaming && state.streamingText.length === 0) {
        const full = extractAssistantText(event.message);
        if (!full) return null;
        return capText(full, MESSAGE_CAP);
      }
      const out = state.streamingText.length > 0 ? capText(state.streamingText, MESSAGE_CAP) : null;
      state.streaming = false;
      state.streamingText = '';
      return out;
    }
    case 'compaction_start': {
      return `compact: ${event.reason ?? 'start'}`;
    }
    case 'compaction_end': {
      return event.errorMessage ? `compact: failed (${capText(event.errorMessage, TOOL_ARG_CAP)})` : `compact: done`;
    }
    case 'auto_retry_start': {
      const a = event.attempt ?? 0;
      const m = event.maxAttempts ?? 0;
      return `retry ${a}/${m}`;
    }
    case 'auto_retry_end': {
      return event.errorMessage ? `retry: failed (${capText(event.errorMessage, TOOL_ARG_CAP)})` : `retry: ok`;
    }
    default:
      return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Bounded ring buffer
// ──────────────────────────────────────────────────────────────────────

export interface ActivityRingOptions {
  /** Maximum number of entries retained. Older entries are dropped. */
  capacity?: number;
}

/**
 * Bounded ring of one-line activity summaries, with a freeze switch.
 *
 * The overlay reads `snapshot()` every render tick; the per-child
 * subscribe glue pushes formatted lines. `freeze()` stops accepting new
 * lines until `resume()` is called - mirrors bg-bash's pause-the-tail
 * UX. Pure / no IO; safe to use under `vitest`.
 *
 * Streaming assistant deltas use `pushStreaming(...)` so they replace
 * the previous streaming line in place; on `message_end` the caller
 * uses `pushStreamingFinal(...)` to drop the cursor and commit the
 * line. Any non-streaming `push(...)` clears the streaming flag so the
 * next streaming chain starts fresh.
 */
export class ActivityRing {
  private readonly capacity: number;
  private buffer: string[] = [];
  private frozen = false;
  private streamingActive = false;

  constructor(options: ActivityRingOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 32);
  }

  push(line: string): void {
    if (this.frozen) return;
    this.appendOrReplace(line, false);
    this.streamingActive = false;
  }

  /**
   * Push a streaming continuation. Replaces the previous streaming
   * line in place when one is active; otherwise appends a new line and
   * arms the streaming flag.
   */
  pushStreaming(line: string): void {
    if (this.frozen) return;
    this.appendOrReplace(line, this.streamingActive);
    this.streamingActive = true;
  }

  /**
   * Commit a streaming chain: replaces the cursor line with the final
   * text (no cursor) and clears the streaming flag so the next event
   * appends instead of replacing.
   */
  pushStreamingFinal(line: string): void {
    if (this.frozen) return;
    this.appendOrReplace(line, this.streamingActive);
    this.streamingActive = false;
  }

  /** Push multiple lines at once - convenient for disk-tail bootstraps. */
  extend(lines: readonly string[]): void {
    for (const line of lines) this.push(line);
  }

  freeze(): void {
    this.frozen = true;
  }

  resume(): void {
    this.frozen = false;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  snapshot(): string[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
    this.streamingActive = false;
  }

  size(): number {
    return this.buffer.length;
  }

  private appendOrReplace(line: string, replace: boolean): void {
    if (replace && this.buffer.length > 0) {
      this.buffer[this.buffer.length - 1] = line;
      return;
    }
    this.buffer.push(line);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// On-disk JSONL tail (terminal children)
// ──────────────────────────────────────────────────────────────────────

export interface TailJsonlOptions {
  /** Maximum number of formatted lines to return (default 32). */
  maxLines?: number;
  /** File-reader override for testability. Defaults to `fs.readFileSync`. */
  readFile?: (path: string) => string;
}

/**
 * Read a child session's JSONL transcript from disk and reduce it to
 * the last N activity-tail lines. Used when the highlighted entry in
 * `/agents:running` is terminal (no live `child.subscribe`).
 *
 * The reader is best-effort: any line that fails to parse is skipped
 * silently so partial / truncated files still yield a useful tail.
 */
export function tailJsonl(path: string, options: TailJsonlOptions = {}): string[] {
  const maxLines = options.maxLines ?? 32;
  const reader = options.readFile ?? ((p) => readFileSync(p, 'utf8'));
  let raw: string;
  try {
    raw = reader(path);
  } catch {
    return [];
  }
  const state = makeActivityState();
  // Drain the transcript through an `ActivityRing` so streaming chains
  // collapse to a single line (matching the live overlay) instead of one
  // row per token delta.
  const ring = new ActivityRing({ capacity: Math.max(1, maxLines) });
  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let event: ActivityEvent;
    try {
      event = JSON.parse(trimmed) as ActivityEvent;
    } catch {
      continue;
    }
    const out = formatActivityLine(event, state);
    if (out) applyActivityLine(ring, out, activityPushModeFor(event));
  }
  return ring.snapshot();
}

// ──────────────────────────────────────────────────────────────────────
// Per-handle ring registry (cross-extension singleton)
// ──────────────────────────────────────────────────────────────────────

interface RegistrySlot {
  rings?: Map<string, ActivityRing>;
}

const REGISTRY_KEY = Symbol.for('@dotfiles/pi/subagent-activity-rings');

function getRegistrySlot(): RegistrySlot {
  const g = globalThis as { [REGISTRY_KEY]?: RegistrySlot };
  let slot = g[REGISTRY_KEY];
  if (!slot) {
    slot = {};
    g[REGISTRY_KEY] = slot;
  }
  return slot;
}

/**
 * Returns the process-wide map of `handle → ActivityRing`. The subagent
 * extension owns lifecycle - inserts a ring when the child spawns and
 * drops it on shutdown. The overlay reads through this map by handle
 * so it survives jiti re-evaluation of extension modules.
 */
export function getSessionActivityRings(): Map<string, ActivityRing> {
  const slot = getRegistrySlot();
  slot.rings ??= new Map();
  return slot.rings;
}

/** Test-only: drop the registry so subsequent calls see an empty map. */
export function __resetSessionActivityRingsForTests(): void {
  const slot = getRegistrySlot();
  slot.rings = undefined;
}
