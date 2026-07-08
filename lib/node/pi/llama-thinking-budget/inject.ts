/**
 * Pure decision core for the `before_provider_request` hook: given a
 * request payload plus the resolved provider/model/config, decide whether
 * to inject a numeric thinking budget and produce the trace line.
 *
 * The shell keeps the pi wiring (reading `event.payload` / `ctx.model`,
 * emitting the trace, returning the mutated payload); this module is a
 * plain-inputs -> decision transform so it stays pi-free and testable.
 *
 * `getSessionLevel` is a lazy accessor for the session's thinking level -
 * it is only consulted for the boolean (qwen) formats, matching the
 * original's on-demand read.
 */

import { resolveBudget } from './resolve-budget.ts';
import { LEVELS, type InjectionConfig, type Level } from './types.ts';

/** Plain inputs the shell gathers before deciding. */
export interface InjectInputs {
  payload: unknown;
  providerName: string | undefined;
  modelId: string | undefined;
  providers: Map<string, InjectionConfig>;
  settings: Partial<Record<Level, number>>;
  env: Partial<Record<Level, number>>;
  getSessionLevel: () => Level | undefined;
}

/**
 * The decision: `inject` carries the new payload the shell returns from the
 * hook; `skip` returns nothing. Both carry the diagnostic `trace` line the
 * shell feeds to its debug log.
 */
export type InjectDecision =
  | { action: 'skip'; trace: string }
  | { action: 'inject'; trace: string; payload: Record<string, unknown> };

/**
 * Detect the reasoning signal in `payload` (one of `reasoning_effort`,
 * `chat_template_kwargs.enable_thinking`, or top-level `enable_thinking`),
 * resolve the level + budget, and decide whether to inject the provider's
 * numeric budget field. Returns a {@link InjectDecision} mirroring the
 * original hook's control flow and trace strings exactly.
 */
export function computeInjection(input: InjectInputs): InjectDecision {
  const { payload, providerName, modelId, providers, settings, env, getSessionLevel } = input;

  if (!payload || typeof payload !== 'object') {
    return { action: 'skip', trace: 'skip: payload not object' };
  }
  const p = payload as Record<string, unknown>;

  // Detect the current reasoning level from whichever thinking format pi emitted.
  let effort: Level | undefined;
  let detectedVia: string;
  const rawEffort = p.reasoning_effort;
  const ctk = p.chat_template_kwargs as { enable_thinking?: unknown } | undefined;
  const qwenEnable = p.enable_thinking;
  if (typeof rawEffort === 'string' && (LEVELS as readonly string[]).includes(rawEffort)) {
    effort = rawEffort as Level;
    detectedVia = 'reasoning_effort';
  } else if (ctk && typeof ctk === 'object' && ctk.enable_thinking === true) {
    // thinkingFormat="qwen-chat-template": payload carries only a boolean,
    // so read the level from the session.
    effort = getSessionLevel();
    detectedVia = 'chat_template_kwargs.enable_thinking';
  } else if (qwenEnable === true) {
    // thinkingFormat="qwen" or "zai": top-level `enable_thinking: true`.
    effort = getSessionLevel();
    detectedVia = 'enable_thinking';
  } else {
    return { action: 'skip', trace: 'skip: no reasoning signal in payload (not a thinking request)' };
  }
  if (!effort) {
    return { action: 'skip', trace: `skip: detected ${detectedVia} but no current thinking level in session` };
  }

  if (!providerName) {
    return { action: 'skip', trace: 'skip: no ctx.model.provider' };
  }

  const injection = providers.get(providerName);
  if (!injection) {
    return {
      action: 'skip',
      trace: `skip: provider "${providerName}" not opted in (have: ${[...providers.keys()].join(',') || '<none>'})`,
    };
  }
  if (injection.models && modelId && !injection.models.has(modelId)) {
    return { action: 'skip', trace: `skip: model "${modelId}" not in allow-list` };
  }

  const budget = resolveBudget(effort, injection, settings, env);
  if (!Number.isFinite(budget) || budget <= 0) {
    return { action: 'skip', trace: `skip: invalid budget ${budget} for level ${effort}` };
  }

  const next: Record<string, unknown> = { ...p, [injection.field]: budget };
  if (injection.stripEffort) delete next.reasoning_effort;
  return {
    action: 'inject',
    trace: `inject: provider=${providerName} model=${modelId ?? '?'} via=${detectedVia} effort=${effort} ${injection.field}=${budget} strip=${injection.stripEffort}`,
    payload: next,
  };
}
