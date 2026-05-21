/**
 * Tool-callable side of the `research` overrides surface.
 *
 * The slash-command parser in `./research-command-args.ts` produces a
 * {@link ResearchOverrides} bundle from a free-form string. The
 * tool-callable surface accepts the same bundle but as structured JSON
 * coming off an LLM call - same fields, same allowed values, but a
 * different shape on the way in (every field is `unknown` until we
 * validate it).
 *
 * Split out of `research-command-args.ts` so the slash-parser surface
 * stays focused on tokenising + dispatching, and the tool-override
 * validator can be reasoned about - and tested - independently. Both
 * sides share the underlying validators (`parseModelSpec`,
 * `parseMaxTurns`, …) imported from the parser module so a change in
 * one accepted-value rule lands in one place.
 */

import {
  parseMaxTurns,
  parseModelSpec,
  parseParallel,
  parseWallClockSec,
  type ResearchOverrides,
} from './research-command-args.ts';

type ModelField = 'model' | 'planCritModel' | 'fanoutModel' | 'criticModel';

function coerceNumeric(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * Validate an overrides bundle coming from the `research` tool (where
 * the LLM can pass any JSON). Returns a cleaned copy (numbers
 * normalised, model normalised) or a human-readable error. Shares
 * every check with the slash-command parser in
 * `./research-command-args.ts`.
 */
export function validateToolOverrides(input: {
  model?: unknown;
  planCritModel?: unknown;
  fanoutModel?: unknown;
  criticModel?: unknown;
  fanoutMaxTurns?: unknown;
  criticMaxTurns?: unknown;
  reviewMaxIter?: unknown;
  fanoutParallel?: unknown;
  wallClockSec?: unknown;
}): { ok: true; overrides: ResearchOverrides; reviewMaxIter?: number } | { ok: false; error: string } {
  const overrides: ResearchOverrides = {};

  const modelFields: readonly ModelField[] = ['model', 'planCritModel', 'fanoutModel', 'criticModel'];
  for (const field of modelFields) {
    const v = input[field];
    if (v === undefined) continue;
    if (typeof v !== 'string') {
      return { ok: false, error: `\`${field}\` must be a "provider/id" string` };
    }
    const parsed = parseModelSpec(v);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    overrides[field] = `${parsed.provider}/${parsed.modelId}`;
  }

  if (input.fanoutMaxTurns !== undefined) {
    const n = coerceNumeric(input.fanoutMaxTurns);
    if (n === null) return { ok: false, error: '`fanoutMaxTurns` must be a positive integer' };
    const parsed = parseMaxTurns('fanoutMaxTurns', String(n));
    if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
    overrides.fanoutMaxTurns = parsed;
  }

  if (input.criticMaxTurns !== undefined) {
    const n = coerceNumeric(input.criticMaxTurns);
    if (n === null) return { ok: false, error: '`criticMaxTurns` must be a positive integer' };
    const parsed = parseMaxTurns('criticMaxTurns', String(n));
    if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
    overrides.criticMaxTurns = parsed;
  }

  let reviewMaxIter: number | undefined;
  if (input.reviewMaxIter !== undefined) {
    const n = coerceNumeric(input.reviewMaxIter);
    if (n === null) return { ok: false, error: '`reviewMaxIter` must be a positive integer' };
    const parsed = parseMaxTurns('reviewMaxIter', String(n));
    if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
    reviewMaxIter = parsed;
    overrides.reviewMaxIter = parsed;
  }

  if (input.fanoutParallel !== undefined) {
    const n = coerceNumeric(input.fanoutParallel);
    if (n === null) return { ok: false, error: '`fanoutParallel` must be a positive integer' };
    const parsed = parseParallel('fanoutParallel', String(n));
    if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
    overrides.fanoutParallel = parsed;
  }

  if (input.wallClockSec !== undefined) {
    const n = coerceNumeric(input.wallClockSec);
    if (n === null) return { ok: false, error: '`wallClockSec` must be a positive integer (seconds)' };
    const parsed = parseWallClockSec('wallClockSec', String(n));
    if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
    overrides.wallClockSec = parsed;
  }

  return reviewMaxIter !== undefined ? { ok: true, overrides, reviewMaxIter } : { ok: true, overrides };
}
