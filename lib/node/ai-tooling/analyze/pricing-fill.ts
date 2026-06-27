// Backfills per-turn cost from token counts for harnesses whose logs do not
// precompute it (claude, codex). pi and opencode record real cost, so their
// sessions arrive with `costNeedsBackfill === false` and skip this entirely.
//
// The per-component breakdown (input / output / cacheRead / cacheWrite)
// mirrors estimateAnthropicCost / estimateOpenAICost in pricing.ts, but keeps
// the components instead of collapsing to a single total so the report can
// show the cost split and the detectors can attribute cacheWrite vs cacheRead
// dollars.
// SPDX-License-Identifier: MIT

import { lookupPricing, type ModelPricing, type PricingTable } from '../pricing.ts';
import { type CachingModel, type NormalizedSession, type TurnCost, type TurnTokens } from './turn-model.ts';

// Anthropic Messages usage splits fresh input, cache_read, and cache_creation
// into separate slices, each with its own rate (cacheRead defaults to 0.1x
// input, cacheWrite to 1.25x). OpenAI Responses usage reports input_tokens as
// the grand total (cached included), so the fresh slice is input - cached and
// the cached slice is billed at the cached rate (defaults to 0.5x).
export function priceTurn(model: CachingModel, tokens: TurnTokens, p: ModelPricing): TurnCost {
  if (model === 'openai') {
    const fresh = Math.max(0, tokens.input - tokens.cacheReadInput);
    const input = fresh * p.inputPerToken;
    const cacheRead = tokens.cacheReadInput * (p.cacheReadPerToken ?? p.inputPerToken * 0.5);
    const output = tokens.output * p.outputPerToken;
    return { input, output, cacheRead, cacheWrite: 0, total: input + output + cacheRead };
  }
  // anthropic (and `none` priced like plain input, though detectors skip it)
  const input = tokens.input * p.inputPerToken;
  const output = tokens.output * p.outputPerToken;
  const cacheRead = tokens.cacheReadInput * (p.cacheReadPerToken ?? p.inputPerToken * 0.1);
  const cacheWrite = tokens.cacheWriteInput * (p.cacheWritePerToken ?? p.inputPerToken * 1.25);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

export interface BackfillResult {
  // Number of turns whose cost was filled in this call.
  filled: number;
  // Model ids that had no pricing match (their turns keep cost === undefined).
  unpricedModels: string[];
}

// Mutates the session in place: fills `cost` on every turn that lacks it and
// whose model resolves in the pricing table. Turns whose model is unknown are
// left without cost (detectors treat missing cost as $0 attribution but still
// flag the token signature). Returns what happened for the CLI to warn on.
export function fillTurnCosts(session: NormalizedSession, pricing: PricingTable): BackfillResult {
  let filled = 0;
  const unpriced = new Set<string>();

  for (const turn of session.turns) {
    if (turn.cost) continue;
    const modelId = turn.model ?? session.model;
    const mp = lookupPricing(pricing, modelId);
    if (!mp) {
      if (modelId) unpriced.add(modelId);
      continue;
    }
    turn.cost = priceTurn(turn.cachingModel, turn.tokens, mp);
    filled++;
  }

  if (filled > 0) session.costNeedsBackfill = false;
  return { filled, unpricedModels: [...unpriced].sort() };
}
