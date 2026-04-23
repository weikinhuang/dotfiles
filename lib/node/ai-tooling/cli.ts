// Shared CLI runner for session-usage tool adapters.
// SPDX-License-Identifier: MIT

import { parseArgs, type ParsedArgs } from './args.ts';
import { setColorEnabled } from './format.ts';
import {
  printDetailJson,
  printListJson,
  printSessionDetail,
  printSessionTable,
  printTotalsJson,
  printTotalsTable,
  sortSessions,
} from './output.ts';
import { expandUserPath } from './paths.ts';
import { type CostVariant, estimateCost, loadPricing, lookupPricing, type PricingTable } from './pricing.ts';
import type { ModelTokenBreakdown, SessionDetail, SessionSummary, Subagent, SessionTokens } from './types.ts';

export interface SessionUsageAdapter<Ctx> {
  help: string;
  // Absolute path or `~`-prefixed path to the tool's data dir.
  defaultUserDir: string;
  // Resolves a tool-specific context from parsed args and the resolved user dir.
  resolveContext: (args: ParsedArgs, userDir: string) => Ctx;
  // Returns all sessions relevant to the current filter context (cwd/project).
  listSessions: (ctx: Ctx) => SessionSummary[];
  // Loads a full detail record for a specific session (supports prefix match).
  loadSessionDetail: (ctx: Ctx, sessionId: string) => SessionDetail;
  // Returns sessions across every project (ignoring cwd/project filter). Used by
  // the `totals` command when no explicit project filter was passed. Adapters
  // that omit this fall back to `listSessions`.
  listAllSessions?: (ctx: Ctx) => SessionSummary[];
  // Optional label shown above the session list (e.g. claude's project slug).
  listLabel?: (ctx: Ctx) => string | undefined;
  // Optional session-argument label shown in help/errors (e.g. "<uuid>").
  sessionArgLabel?: string;
  // When set, the CLI estimates `cost` for every session/subagent using the
  // LiteLLM pricing table. Omit for tools that supply real costs themselves.
  costVariant?: CostVariant;
}

// Cost over a list of per-model token slices. Sets each slice's .cost and
// returns the aggregate. Returns undefined if no slice had a price match.
function annotateBreakdown(
  breakdown: ModelTokenBreakdown[],
  pricing: PricingTable,
  variant: CostVariant,
): number | undefined {
  let total = 0;
  let matched = false;
  for (const mb of breakdown) {
    const mp = lookupPricing(pricing, mb.model);
    if (!mp) continue;
    mb.cost = estimateCost(variant, mb.tokens, mp);
    total += mb.cost;
    matched = true;
  }
  return matched ? total : undefined;
}

function annotateOne(
  entry: { model: string; tokens: SessionTokens; modelBreakdown?: ModelTokenBreakdown[]; cost?: number },
  pricing: PricingTable,
  variant: CostVariant,
): void {
  if ((entry.cost ?? 0) > 0) return;
  if (entry.modelBreakdown && entry.modelBreakdown.length > 0) {
    const total = annotateBreakdown(entry.modelBreakdown, pricing, variant);
    if (total !== undefined) entry.cost = total;
    return;
  }
  const mp = lookupPricing(pricing, entry.model);
  if (!mp) return;
  entry.cost = estimateCost(variant, entry.tokens, mp);
}

function annotateSessionCosts(sessions: SessionSummary[], pricing: PricingTable, variant: CostVariant): void {
  for (const s of sessions) annotateOne(s, pricing, variant);
}

function annotateSubagentCosts(subagents: Subagent[], pricing: PricingTable, variant: CostVariant): void {
  for (const sa of subagents) annotateOne(sa, pricing, variant);
}

export async function runSessionUsageCli<Ctx>(adapter: SessionUsageAdapter<Ctx>): Promise<void> {
  const args = parseArgs(process.argv.slice(2), {
    help: adapter.help,
    sessionArgLabel: adapter.sessionArgLabel,
  });
  setColorEnabled(!args.noColor && !args.json && process.stdout.isTTY !== false);

  const userDir = expandUserPath(args.userDir || adapter.defaultUserDir);
  const ctx = adapter.resolveContext(args, userDir);

  const shouldEstimate = adapter.costVariant !== undefined && !args.noCost;
  let pricing: PricingTable | undefined;
  const ensurePricing = async (): Promise<PricingTable> => {
    if (!pricing) pricing = await loadPricing(args.refreshPrices);
    return pricing;
  };

  if (args.command === 'session') {
    const detail = adapter.loadSessionDetail(ctx, args.sessionId);
    if (shouldEstimate) {
      const p = await ensurePricing();
      annotateSessionCosts([detail], p, adapter.costVariant!);
      annotateSubagentCosts(detail.subagents, p, adapter.costVariant!);
    }
    if (args.json) {
      printDetailJson(detail);
    } else {
      printSessionDetail(detail);
    }
    return;
  }

  if (args.command === 'totals') {
    const useAll = !args.projectArg && adapter.listAllSessions !== undefined;
    const sessions = useAll ? adapter.listAllSessions!(ctx) : adapter.listSessions(ctx);
    if (shouldEstimate) {
      const p = await ensurePricing();
      annotateSessionCosts(sessions, p, adapter.costVariant!);
    }
    const label = useAll ? undefined : adapter.listLabel?.(ctx);
    if (args.json) {
      printTotalsJson(sessions, args.groupBy, args.sort, args.limit, label);
    } else {
      printTotalsTable(sessions, args.groupBy, args.sort, args.limit, label);
    }
    return;
  }

  let sessions = adapter.listSessions(ctx);
  if (shouldEstimate) {
    const p = await ensurePricing();
    annotateSessionCosts(sessions, p, adapter.costVariant!);
  }
  sessions = sortSessions(sessions, args.sort);
  if (args.limit > 0) sessions = sessions.slice(0, args.limit);

  const label = adapter.listLabel?.(ctx);
  if (args.json) {
    printListJson(sessions, label);
  } else {
    printSessionTable(sessions, label);
  }
}
