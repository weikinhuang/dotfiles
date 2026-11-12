/** Content-free sizing and outcome data for bounded recap attempts. */
import { isRecord } from '../shared.ts';

export type SummaryReason =
  | 'accepted'
  | 'over-limit'
  | 'collapsed'
  | 'no-output'
  | 'null-response'
  | 'model-unavailable'
  | 'child-failed'
  | 'cancelled'
  | 'disabled'
  | 'empty-span'
  | 'below-minimum'
  | 'constraints-conflict';

export interface SummaryLimits {
  targetChars: number;
  maxChars: number;
  minChars: number;
}

export interface SummaryAttemptMetadata extends SummaryLimits {
  priorChars: number;
  outputChars: number;
  reason: SummaryReason;
  attempts: readonly { reason: SummaryReason; outputChars: number }[];
}

function nonnegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
}

/** Resolve a soft target without weakening either the hard cap or prior-recap floor. */
export function resolveSummaryLimits(maxChars: number, targetChars = 0, priorChars = 0): SummaryLimits {
  const max = Math.max(1, nonnegativeInteger(maxChars));
  const min = Math.ceil(nonnegativeInteger(priorChars) / 2);
  const target = nonnegativeInteger(targetChars) || Math.max(1, Math.floor((max / 3) * 2));
  return {
    targetChars: Math.min(max, Math.max(target, min)),
    maxChars: max,
    minChars: min,
  };
}

function isReason(value: unknown): value is SummaryReason {
  return (
    value === 'accepted' ||
    value === 'over-limit' ||
    value === 'collapsed' ||
    value === 'no-output' ||
    value === 'null-response' ||
    value === 'model-unavailable' ||
    value === 'child-failed' ||
    value === 'cancelled' ||
    value === 'disabled' ||
    value === 'empty-span' ||
    value === 'below-minimum' ||
    value === 'constraints-conflict'
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Reject unknown fields and rebuild a safe, detached whitelist for diagnostics exports. */
export function readSummaryAttempt(value: unknown): SummaryAttemptMetadata | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['targetChars', 'maxChars', 'minChars', 'priorChars', 'outputChars', 'reason', 'attempts']) ||
    !isCount(value.targetChars) ||
    !isCount(value.maxChars) ||
    !isCount(value.minChars) ||
    !isCount(value.priorChars) ||
    !isCount(value.outputChars) ||
    value.targetChars < 1 ||
    value.targetChars > value.maxChars ||
    value.minChars !== Math.ceil(value.priorChars / 2) ||
    !isReason(value.reason) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > 2
  ) {
    return null;
  }
  const attempts: { reason: SummaryReason; outputChars: number }[] = [];
  for (const item of value.attempts) {
    const entry: unknown = item;
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ['reason', 'outputChars']) ||
      !isReason(entry.reason) ||
      !isCount(entry.outputChars)
    ) {
      return null;
    }
    attempts.push({ reason: entry.reason, outputChars: entry.outputChars });
  }
  return {
    targetChars: value.targetChars,
    maxChars: value.maxChars,
    minChars: value.minChars,
    priorChars: value.priorChars,
    outputChars: value.outputChars,
    reason: value.reason,
    attempts,
  };
}
