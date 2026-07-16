/**
 * Pure request-time decision for the `oai-params` extension's
 * `before_provider_request` hook: given the outgoing provider payload and
 * the active provider name, decide whether this request belongs to a
 * derived variant and, if so, rewrite `payload.model` to the parent server
 * id and fill in the variant's sampling params (fill-only: never overwrite
 * a key pi already set).
 *
 * No pi imports - directly unit-testable.
 */

import { RESERVED_KEYS, type SamplingParams, type VariantInjection } from './types.ts';

export interface InjectDecision {
  action: 'inject' | 'skip';
  /** Present only when `action === 'inject'`: the rewritten payload. */
  payload?: Record<string, unknown>;
  /** One-line diagnostic describing the decision. */
  trace: string;
}

/**
 * Compute the injection for one request. Returns `skip` when the provider
 * is not a known variant or the payload isn't a plain object. Otherwise
 * returns `inject` with a shallow-cloned payload whose `model` is the
 * parent server id and whose absent, non-reserved sampling keys are filled.
 */
export function computeInjection(args: {
  payload: unknown;
  provider: string | undefined;
  injections: Map<string, VariantInjection>;
}): InjectDecision {
  const { payload, provider, injections } = args;

  if (!provider) return { action: 'skip', trace: 'skip: no provider' };
  const variant = injections.get(provider);
  if (!variant) return { action: 'skip', trace: `skip: "${provider}" is not a variant` };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { action: 'skip', trace: `skip: payload is not an object (${provider})` };
  }

  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  next.model = variant.parentId;

  const applied: string[] = [];
  const skipped: string[] = [];
  const params: SamplingParams = variant.samplingParams;
  for (const [key, value] of Object.entries(params)) {
    if (RESERVED_KEYS.has(key)) {
      skipped.push(`${key}(reserved)`);
      continue;
    }
    if (key in next) {
      skipped.push(`${key}(present)`);
      continue;
    }
    next[key] = value;
    applied.push(key);
  }

  const appliedStr = applied.length ? applied.join(',') : 'none';
  const skippedStr = skipped.length ? ` skipped=${skipped.join(',')}` : '';
  return {
    action: 'inject',
    payload: next,
    trace: `inject: ${provider} -> model=${variant.parentId} params=${appliedStr}${skippedStr}`,
  };
}
