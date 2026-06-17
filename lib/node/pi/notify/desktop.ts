/**
 * Pure helpers for the `notify` pi extension: turning a finished agent turn
 * into desktop-notification content, the long-turn / error gating decision,
 * and the env-driven config.
 *
 * The extension layer (`config/pi/extensions/notify.ts`) owns the side effect
 * (spawning the platform `quick-toast` binary); everything decidable without
 * a running process lives here so it's unit-testable without pi's runtime.
 */

import { basename } from 'node:path';

import { envTruthy, parseNonNegativeInt } from '../parse-env.ts';

/** Default minimum successful-turn duration (seconds) before notifying. */
export const DEFAULT_MIN_SECONDS = 30;
/** Default notifier binary - the repo's platform-abstracting bin script. */
export const DEFAULT_COMMAND = 'quick-toast';
/** Default title prefix shown before the project name. */
export const DEFAULT_TITLE_PREFIX = 'pi';
/** Body text is collapsed to one line and truncated to this many chars. */
export const MAX_BODY_LEN = 140;

/** Resolved configuration for the extension. */
export interface NotifyConfig {
  disabled: boolean;
  toolDisabled: boolean;
  minSeconds: number;
  command: string;
  titlePrefix: string;
  verbose: boolean;
  trace?: string;
}

/** Trim a raw env value, mapping blank / missing to `undefined`. */
function nonEmpty(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (trimmed) return trimmed;
  return undefined;
}

/**
 * Build {@link NotifyConfig} from the process environment. All knobs are
 * optional; only `PI_NOTIFY_DISABLED` turns the feature off entirely.
 */
export function resolveNotifyConfig(env: Record<string, string | undefined>): NotifyConfig {
  return {
    disabled: envTruthy(env.PI_NOTIFY_DISABLED),
    toolDisabled: envTruthy(env.PI_NOTIFY_TOOL_DISABLED),
    minSeconds: parseNonNegativeInt(env.PI_NOTIFY_MIN_SECONDS, DEFAULT_MIN_SECONDS),
    command: nonEmpty(env.PI_NOTIFY_COMMAND) ?? DEFAULT_COMMAND,
    titlePrefix: nonEmpty(env.PI_NOTIFY_TITLE_PREFIX) ?? DEFAULT_TITLE_PREFIX,
    verbose: envTruthy(env.PI_NOTIFY_VERBOSE),
    trace: nonEmpty(env.PI_NOTIFY_TRACE),
  };
}

/** Distilled view of the final assistant message of an agent loop. */
export interface TurnSummary {
  /** Concatenated text content of the final assistant message ('' when none). */
  text: string;
  /** True when the final assistant turn ended in error or was aborted. */
  errored: boolean;
  /** Raw `stopReason` of the final assistant message, when present. */
  stopReason?: string;
  /** `errorMessage` of the final assistant message, when present. */
  errorMessage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * Walk `messages` from the end and summarize the last assistant message.
 * Structurally typed (pi-free) so the helper needs no pi imports.
 */
export function summarizeTurn(messages: readonly unknown[]): TurnSummary {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== 'assistant') continue;
    const stopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined;
    const errorMessage = typeof message.errorMessage === 'string' ? message.errorMessage : undefined;
    return {
      text: extractText(message.content),
      errored: stopReason === 'error' || stopReason === 'aborted',
      stopReason,
      errorMessage,
    };
  }
  return { text: '', errored: false };
}

/** Inputs to the long-turn / error gating decision. */
export interface NotifyDecisionInput {
  elapsedMs: number;
  minSeconds: number;
  errored: boolean;
}

/**
 * Decide whether to fire. Errored / aborted turns always notify; otherwise
 * the turn must have run at least `minSeconds`.
 */
export function shouldNotify({ elapsedMs, minSeconds, errored }: NotifyDecisionInput): boolean {
  if (errored) return true;
  return elapsedMs >= minSeconds * 1000;
}

/** Collapse whitespace to a single line and truncate with an ellipsis. */
export function firstLine(text: string, maxLen = MAX_BODY_LEN): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1).trimEnd()}…`;
}

/** Title + body pair handed to the notifier binary. */
export interface NotificationContent {
  title: string;
  body: string;
}

/** Inputs for {@link buildNotification}. */
export interface BuildNotificationInput {
  summary: TurnSummary;
  cwd: string;
  titlePrefix: string;
}

function notificationBody(summary: TurnSummary): string {
  if (summary.errored) {
    const label = summary.stopReason === 'aborted' ? 'Turn aborted' : 'Turn failed';
    const detail = firstLine(summary.errorMessage ?? summary.text);
    return detail ? `${label}: ${detail}` : label;
  }
  const snippet = firstLine(summary.text);
  return snippet ? snippet : 'Turn complete - awaiting your input';
}

/**
 * Build the `{ title, body }` shown to the user. Title is
 * `<prefix> · <project>`; body is the first line of the final reply, or a
 * failure label when the turn errored / aborted.
 */
export function buildNotification({ summary, cwd, titlePrefix }: BuildNotificationInput): NotificationContent {
  const project = basename(cwd) || cwd;
  return {
    title: `${titlePrefix} · ${project}`,
    body: notificationBody(summary),
  };
}

/** Inputs for {@link buildToolNotification}. */
export interface ToolNotificationInput {
  /** The model-supplied body. */
  message: string;
  /** Optional model-supplied heading; defaults to the project name. */
  title?: string;
  cwd: string;
  titlePrefix: string;
}

/**
 * Build the `{ title, body }` for a model-initiated `notify` tool call. Title
 * is `<prefix> · <heading>` where heading is the model's `title` arg or the
 * project basename; body is the first line of the message.
 */
export function buildToolNotification({
  message,
  title,
  cwd,
  titlePrefix,
}: ToolNotificationInput): NotificationContent {
  const heading = nonEmpty(title) ?? (basename(cwd) || cwd);
  return {
    title: `${titlePrefix} · ${heading}`,
    body: firstLine(message),
  };
}
