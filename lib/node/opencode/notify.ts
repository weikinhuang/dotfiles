/**
 * Pure helpers for the opencode `notify` plugin
 * (`config/opencode/plugins/notify/`): config resolution, per-session turn
 * tracking, the lifecycle notify decision, and `notify` tool input parsing.
 *
 * Notification content and the long-turn / error gate are shared with the pi
 * extension via `lib/node/pi/notify/desktop.ts`; this module only adapts
 * opencode's execution events onto them. The plugin shell owns the side
 * effects (event subscription, session lookups, spawning `quick-toast`).
 *
 * Pure module - no opencode imports.
 */

import {
  buildNotification,
  buildToolNotification,
  DEFAULT_COMMAND,
  DEFAULT_MIN_SECONDS,
  type NotificationContent,
  shouldNotify,
  type TurnSummary,
} from '../pi/notify/desktop.ts';
import { createOptionReader, type EnvBag, type PluginOptionBag } from './plugin-options.ts';

/** Env override prefix: option `minSeconds` -> `OPENCODE_NOTIFY_MIN_SECONDS`. */
export const OPENCODE_NOTIFY_ENV_PREFIX = 'OPENCODE_NOTIFY_';
/** Default title prefix shown before the project name. */
export const OPENCODE_DEFAULT_TITLE_PREFIX = 'opencode';

/** Resolved plugin configuration. */
export interface OpencodeNotifyConfig {
  /** Master switch; `false` makes the plugin a no-op. */
  enabled: boolean;
  /** Register the model-callable `notify` tool. */
  tool: boolean;
  /** Fire a notification when a root-session turn ends. */
  lifecycle: boolean;
  /** Minimum successful-turn duration (seconds) before the lifecycle path fires. */
  minSeconds: number;
  /** Notifier binary, invoked as `<command> <title> <body>`. */
  command: string;
  titlePrefix: string;
  /** Append one line per decision to this path when set. */
  trace?: string;
}

/**
 * Resolve {@link OpencodeNotifyConfig} from plugin options (`ctx.options`)
 * with `OPENCODE_NOTIFY_*` env overrides.
 */
export function resolveOpencodeNotifyConfig(options: PluginOptionBag | undefined, env: EnvBag): OpencodeNotifyConfig {
  const read = createOptionReader(options, env, OPENCODE_NOTIFY_ENV_PREFIX);
  return {
    enabled: read.bool('enabled', true),
    tool: read.bool('tool', true),
    lifecycle: read.bool('lifecycle', true),
    minSeconds: read.number('minSeconds', DEFAULT_MIN_SECONDS),
    command: read.string('command', DEFAULT_COMMAND),
    titlePrefix: read.string('titlePrefix', OPENCODE_DEFAULT_TITLE_PREFIX),
    trace: read.optionalString('trace'),
  };
}

/** Mutable per-session turn state. */
export interface TurnState {
  /** `session.execution.started` time; `undefined` when the plugin loaded mid-turn. */
  startedAt?: number;
  /** The `notify` tool fired during this turn (in this session or a descendant). */
  toolFired: boolean;
  /** Most recent non-empty assistant text block of the turn. */
  lastText: string;
  /** A terminal event was already handled for this turn. */
  ended: boolean;
}

/** Result of {@link TurnTracker.finish}. */
export type FinishResult = { duplicate: true } | { duplicate: false; state: TurnState };

/** Tracks one {@link TurnState} per session id across execution events. */
export interface TurnTracker {
  start(sessionID: string, at: number): void;
  text(sessionID: string, text: string): void;
  markToolFired(sessionID: string): void;
  /** Close the turn; repeated terminal events for one turn report `duplicate`. */
  finish(sessionID: string): FinishResult;
  forget(sessionID: string): void;
  /** Number of tracked sessions (for tests / diagnostics). */
  size(): number;
}

function freshState(startedAt?: number): TurnState {
  return { startedAt, toolFired: false, lastText: '', ended: false };
}

export function createTurnTracker(): TurnTracker {
  const turns = new Map<string, TurnState>();
  const open = (sessionID: string): TurnState => {
    let state = turns.get(sessionID);
    if (!state || state.ended) {
      state = freshState();
      turns.set(sessionID, state);
    }
    return state;
  };
  return {
    start(sessionID, at) {
      turns.set(sessionID, freshState(at));
    },
    text(sessionID, text) {
      if (!text.trim()) return;
      open(sessionID).lastText = text;
    },
    markToolFired(sessionID) {
      open(sessionID).toolFired = true;
    },
    finish(sessionID) {
      const state = turns.get(sessionID);
      if (state?.ended) return { duplicate: true };
      const closed = state ?? freshState();
      closed.ended = true;
      turns.set(sessionID, closed);
      return { duplicate: false, state: { ...closed } };
    },
    forget(sessionID) {
      turns.delete(sessionID);
    },
    size: () => turns.size,
  };
}

/** How an opencode execution ended (`session.execution.*`). */
export type TurnOutcome =
  | { kind: 'succeeded' }
  | { kind: 'failed'; message: string }
  | { kind: 'interrupted'; reason: string };

/**
 * Interrupt reasons that never notify: `shutdown` fires while opencode exits
 * and `superseded` when a newer prompt replaced the running execution.
 */
export const SILENT_INTERRUPT_REASONS: ReadonlySet<string> = new Set(['shutdown', 'superseded']);

/** Map an outcome plus captured text onto the shared {@link TurnSummary}. */
export function summarizeOutcome(outcome: TurnOutcome, lastText: string): TurnSummary {
  if (outcome.kind === 'failed') {
    return { text: lastText, errored: true, stopReason: 'error', errorMessage: outcome.message || undefined };
  }
  if (outcome.kind === 'interrupted') return { text: lastText, errored: true, stopReason: 'aborted' };
  return { text: lastText, errored: false };
}

/** Inputs for {@link decideTurnNotification}. */
export interface TurnDecisionInput {
  state: TurnState;
  outcome: TurnOutcome;
  isRoot: boolean;
  now: number;
  minSeconds: number;
  cwd: string;
  titlePrefix: string;
}

/** Lifecycle decision; `reason` / `elapsedMs` feed the trace line. */
export type TurnDecision =
  | ({ notify: true; elapsedMs: number } & NotificationContent)
  | { notify: false; elapsedMs: number; reason: string };

/**
 * Decide whether a finished turn notifies. Order: child sessions and silent
 * interrupts never notify; a turn where the `notify` tool already fired is
 * suppressed; otherwise the shared gate applies (errors / aborts always,
 * successful turns only after `minSeconds`).
 */
export function decideTurnNotification(input: TurnDecisionInput): TurnDecision {
  const { state, outcome } = input;
  const elapsedMs = state.startedAt === undefined ? 0 : Math.max(0, input.now - state.startedAt);
  if (!input.isRoot) return { notify: false, elapsedMs, reason: 'child-session' };
  if (outcome.kind === 'interrupted' && SILENT_INTERRUPT_REASONS.has(outcome.reason)) {
    return { notify: false, elapsedMs, reason: `interrupted-${outcome.reason}` };
  }
  if (state.toolFired) return { notify: false, elapsedMs, reason: 'tool-fired' };
  const summary = summarizeOutcome(outcome, state.lastText);
  if (!shouldNotify({ elapsedMs, minSeconds: input.minSeconds, errored: summary.errored })) {
    return { notify: false, elapsedMs, reason: 'short-turn' };
  }
  return { notify: true, elapsedMs, ...buildNotification({ summary, cwd: input.cwd, titlePrefix: input.titlePrefix }) };
}

/** JSON Schema for the `notify` tool input. */
export const NOTIFY_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description: 'The notification body the user will see. One short, specific line is best.',
    },
    title: {
      type: 'string',
      description: 'Optional short heading. Defaults to the project name.',
    },
  },
  required: ['message'],
  additionalProperties: false,
} as const;

/** Model-facing description of the `notify` tool (same wording as the pi tool). */
export const NOTIFY_TOOL_DESCRIPTION =
  'Send the user a desktop notification. Use sparingly - only when you have likely been left unattended and need a decision to continue, or to flag a milestone in a long-running task. Routine progress belongs in your normal reply, not here.';

/** Parse the tool input and build its notification, or return an error message. */
export function buildNotifyToolCall(
  input: unknown,
  cwd: string,
  titlePrefix: string,
): { ok: true; content: NotificationContent } | { ok: false; error: string } {
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  if (!message) return { ok: false, error: 'message must not be empty' };
  const title = typeof record.title === 'string' ? record.title : undefined;
  return { ok: true, content: buildToolNotification({ message, title, cwd, titlePrefix }) };
}
