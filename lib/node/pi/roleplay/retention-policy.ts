/** Pure, scene-local prompt retention policy. No runtime or physical context-window dependency. */
import type { ReminderMessage } from '../context-reminder.ts';
import { reminderMessageAnchor, reminderMessageKeys } from '../reminder-identity.ts';
import { isRecord } from '../shared/guards.ts';
import { coerceConfigLayer, type RoleplayConfig } from './config.ts';
import { isSceneBoundary } from './scene-state.ts';

export const ROLEPLAY_POLICY_ENTRY = 'roleplay-context-policy';

export interface RoleplayPolicyOverrides {
  /** Full input-prompt target in tokens; zero explicitly disables the target. */
  target?: number;
  pin?: boolean;
  includeReply?: boolean;
}

export interface EffectiveRoleplayPolicy {
  target: number;
  pin: boolean;
  includeReply: boolean;
}

/** Latest valid value per field wins, but no value survives a scene or cast boundary. */
export function readRoleplayPolicyOverrides(
  entries: readonly Record<string, unknown>[],
  cast?: string,
): RoleplayPolicyOverrides {
  const result: RoleplayPolicyOverrides = {};
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isSceneBoundary(entry)) break;
    if (entry.type !== 'custom' || entry.customType !== ROLEPLAY_POLICY_ENTRY || !isRecord(entry.data)) continue;
    const data = entry.data;
    if (cast !== undefined && data.cast !== cast) continue;
    const target = coerceConfigLayer({ promptTokenTarget: data.target }).promptTokenTarget;
    if (result.target === undefined && target !== undefined) result.target = target;
    if (result.pin === undefined && typeof data.pin === 'boolean') result.pin = data.pin;
    if (result.includeReply === undefined && typeof data.includeReply === 'boolean')
      result.includeReply = data.includeReply;
  }
  return result;
}

/** Explicit zero / false branch values override enabled file settings. Reply pinning requires opener pinning. */
export function effectiveRoleplayPolicy(
  config: Pick<RoleplayConfig, 'promptTokenTarget' | 'pinSceneOpener' | 'pinSceneOpenerReply'>,
  overrides: RoleplayPolicyOverrides = {},
): EffectiveRoleplayPolicy {
  const pin = overrides.pin ?? config.pinSceneOpener;
  return {
    target: overrides.target ?? config.promptTokenTarget,
    pin,
    includeReply: pin && (overrides.includeReply ?? config.pinSceneOpenerReply),
  };
}

function genuineUser(message: ReminderMessage): boolean {
  return (
    message.role === 'user' &&
    message.cacheReminderSnapshot !== true &&
    message.customType === undefined &&
    message.startup !== true
  );
}

export interface SceneOpenerRange {
  from: number;
  /** Exclusive end; only a complete exchange can extend beyond the opening input. */
  to: number;
  anchor: string;
}

/**
 * Input must already be scene-scoped. Startup/custom/snapshot items never
 * become the opener. An unfinished or malformed tool chain pins only the input.
 */
export function sceneOpenerRange(messages: readonly ReminderMessage[], includeReply = false): SceneOpenerRange | null {
  const from = messages.findIndex(genuineUser);
  if (from < 0) return null;
  const range = { from, to: from + 1, anchor: reminderMessageAnchor(messages[from]) };
  if (!includeReply) return range;
  const pending = new Set<string>();
  let complete = false;
  let to = range.to;
  for (let i = from + 1; i < messages.length; i++) {
    const message = messages[i];
    if (genuineUser(message)) break;
    if (message.role === 'assistant') {
      if (pending.size > 0) return range;
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return range;
      const calls = Array.isArray(message.content) ? message.content.filter((part) => part.type === 'toolCall') : [];
      for (const call of calls) {
        if (!isRecord(call) || typeof call.id !== 'string' || pending.has(call.id)) return range;
        pending.add(call.id);
      }
      complete = calls.length === 0 && message.stopReason !== 'toolUse';
    } else if (message.role === 'toolResult') {
      if (typeof message.toolCallId !== 'string' || !pending.delete(message.toolCallId)) return range;
      complete = false;
    }
    if (complete) to = i + 1;
  }
  return complete && pending.size === 0 ? { ...range, to } : range;
}

/** All stable identity aliases for the pinned range, suitable for a caller's trim/drop predicate. */
export function sceneOpenerKeys(messages: readonly ReminderMessage[], includeReply = false): Set<string> {
  const range = sceneOpenerRange(messages, includeReply);
  return new Set(range ? messages.slice(range.from, range.to).flatMap(reminderMessageKeys) : []);
}

/**
 * Restore the original opener bytes after a drop/condense pass. The original
 * list must be scene-scoped and identity-stamped before transformation. Missing
 * opener messages precede the retained suffix, after its leading system head.
 */
export function preserveSceneOpener<M extends ReminderMessage>(
  original: readonly M[],
  transformed: readonly M[],
  includeReply = false,
): readonly M[] {
  const range = sceneOpenerRange(original, includeReply);
  if (!range) return transformed;
  const pinned = original.slice(range.from, range.to);
  const keys = sceneOpenerKeys(original, includeReply);
  const rest = transformed.filter((message) => !reminderMessageKeys(message).some((key) => keys.has(key)));
  const head = rest.findIndex((message) => message.role !== 'system');
  const at = head < 0 ? rest.length : head;
  return [...rest.slice(0, at), ...pinned, ...rest.slice(at)];
}

export interface TokenTargetPlan {
  targetInputTokens: number;
  targetAfterHysteresis: number;
}

/** Soft full-prompt limits, not context-window/output-reserve arithmetic. Null means off. */
export function planTokenTarget(target: number, hysteresis = 0.1): TokenTargetPlan | null {
  const normalized = coerceConfigLayer({ promptTokenTarget: target }).promptTokenTarget;
  if (!normalized) return null;
  const fraction = Number.isFinite(hysteresis) ? Math.max(0, Math.min(0.5, hysteresis)) : 0.1;
  return {
    targetInputTokens: normalized,
    targetAfterHysteresis: Math.floor(normalized * (1 - fraction)),
  };
}
