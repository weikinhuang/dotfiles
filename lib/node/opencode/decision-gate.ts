/**
 * Pure helpers for the opencode `decision-gate` plugin
 * (config/opencode/plugins/decision-gate/). The plugin hooks
 * `permission.evaluate`: when opencode's rules resolve a `shell` request
 * to `ask`, the shared decision-model shell gate may turn it into
 * `allow`; otherwise the ask goes ahead unchanged.
 *
 * This module turns the evaluate event into gate input and pairs an
 * abstained decision with the user's later reply, so the decision log
 * records what actually happened.
 *
 * Pure module: no `@opencode/*` imports.
 */

import { join } from 'node:path';

import { DECISION_MODEL_CONFIG_FILE, DECISION_MODEL_LOG_FILE } from '../decision-model/config.ts';
import type { ResolutionRecord } from '../decision-model/log.ts';
import type { ShellGateInput } from '../decision-model/shell-gate.ts';
import { createOptionReader, type EnvBag, type PluginOptionBag } from './plugin-options.ts';

export const DECISION_GATE_ENV_PREFIX = 'OPENCODE_DECISION_GATE_';

export interface DecisionGatePluginConfig {
  enabled: boolean;
  configPath: string;
  defaultLogPath: string;
  /** Debug trace file (one line per evaluate), never the command text. */
  trace?: string;
}

/** Plugin options / env: `enabled` (default true), `config` (path override), `trace`. */
export function resolveDecisionGateConfig(
  options: PluginOptionBag | undefined,
  env: EnvBag,
  configDir: string,
): DecisionGatePluginConfig {
  const read = createOptionReader(options, env, DECISION_GATE_ENV_PREFIX);
  return {
    enabled: read.bool('enabled', true),
    configPath: read.string('config', join(configDir, DECISION_MODEL_CONFIG_FILE)),
    defaultLogPath: join(configDir, DECISION_MODEL_LOG_FILE),
    trace: read.optionalString('trace'),
  };
}

/** Structural slice of opencode's `PermissionEvaluation`. */
export interface EvaluateEventLike {
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  effect: string;
}

function metaString(meta: Readonly<Record<string, unknown>> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = meta?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface StashedCall {
  command: string;
}

const STASH_PER_SESSION = 8;
const STASH_SESSIONS = 50;

/**
 * Recent shell tool calls per session, captured in `tool.execute.before`
 * (which opencode runs before the shell permission check). opencode's
 * shell permission event carries only the parsed sub-commands, so this
 * recovers the full command line, operators and redirects included.
 */
export class CommandStash {
  private readonly bySession = new Map<string, StashedCall[]>();

  /** Record a tool call's input when it has a string `command`. */
  record(sessionID: string, input: unknown): void {
    if (typeof input !== 'object' || input === null) return;
    const fields = input as Record<string, unknown>;
    if (typeof fields.command !== 'string' || !fields.command.trim()) return;
    const calls = this.bySession.get(sessionID) ?? [];
    calls.unshift({ command: fields.command });
    calls.length = Math.min(calls.length, STASH_PER_SESSION);
    this.bySession.delete(sessionID);
    this.bySession.set(sessionID, calls);
    while (this.bySession.size > STASH_SESSIONS) {
      const oldest = this.bySession.keys().next().value;
      if (oldest === undefined) break;
      this.bySession.delete(oldest);
    }
  }

  /**
   * The most recent call in `sessionID` whose command contains every
   * resource (whitespace-insensitive), so parallel calls are not mixed up.
   */
  find(sessionID: string, resources: readonly string[]): StashedCall | undefined {
    const parts = resources.map(collapse);
    return this.bySession.get(sessionID)?.find((call) => {
      const command = collapse(call.command);
      return parts.every((part) => command.includes(part));
    });
  }
}

/**
 * Gate input for an evaluate event the gate should consider, else
 * `undefined`. Only `shell` requests currently resolved to `ask` qualify:
 * an explicit allow or deny rule always stands. The full command comes
 * from the matching stashed call, then from metadata; otherwise the
 * parsed sub-commands (`resources`) stand in for it.
 */
export function shellGateInputFor(
  event: EvaluateEventLike,
  fallbackCwd: string,
  stashed?: StashedCall,
): ShellGateInput | undefined {
  if (event.action !== 'shell' || event.effect !== 'ask') return undefined;
  if (event.resources.length === 0) return undefined;
  const command = stashed?.command ?? metaString(event.metadata, 'command') ?? event.resources.join('\n');
  return {
    command,
    unresolved: [...event.resources],
    cwd: metaString(event.metadata, 'cwd') ?? fallbackCwd,
    sessionId: event.sessionID,
  };
}

/** Correlation key for an ask: same session, same action, same resources. */
export function askKey(sessionID: string, action: string, resources: readonly string[]): string {
  return [sessionID, action, ...resources].join('\u0000');
}

/** opencode's reply to a permission prompt -> decision-log outcome. */
export function replyOutcome(reply: string): ResolutionRecord['outcome'] | undefined {
  if (reply === 'once' || reply === 'always') return 'allow';
  if (reply === 'reject') return 'deny';
  return undefined;
}

const MAX_TRACKED = 200;

/**
 * Tracks abstained decisions from `evaluate` until their prompt is asked
 * (`permission.asked` carries the request id) and replied to
 * (`permission.replied` references that id). Bounded; oldest entries drop.
 */
export class AskTracker {
  private readonly byKey = new Map<string, string>();
  private readonly byRequest = new Map<string, string>();

  /** Remember that `decisionId` abstained on this ask. */
  abstained(key: string, decisionId: string): void {
    this.byKey.set(key, decisionId);
    AskTracker.trim(this.byKey);
  }

  /** A prompt was shown; link its request id to the pending decision. */
  asked(key: string, requestID: string): void {
    const decisionId = this.byKey.get(key);
    if (decisionId === undefined) return;
    this.byKey.delete(key);
    this.byRequest.set(requestID, decisionId);
    AskTracker.trim(this.byRequest);
  }

  /** The prompt was answered; returns the decision id once, then forgets it. */
  replied(requestID: string): string | undefined {
    const decisionId = this.byRequest.get(requestID);
    this.byRequest.delete(requestID);
    return decisionId;
  }

  private static trim(map: Map<string, string>): void {
    while (map.size > MAX_TRACKED) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }
}
