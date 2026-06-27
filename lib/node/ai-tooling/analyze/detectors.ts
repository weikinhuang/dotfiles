// Pure, harness-agnostic cost / caching pathology detectors.
//
// Each detector is `(session, cfg) => Finding[]` and branches only on a
// turn's `cachingModel` - never on `session.harness`. They walk the
// normalized per-turn series and attribute dollars to the offending turn
// range. v1 ships the four detectors that explained every real cost
// explosion we investigated: cache-poisoning, cache-write-dominant,
// ttl-expiry, and large-context-carry.
//
// Ground truth they are tuned against (pi, opus, Bedrock):
//   019f0109 "poisoned": cacheRead frozen at 38541 for turns 16-55, ~90% of
//            the $32 total is cache-write.
//   019f01b7 "mixed":   healthy stretches + a poisoned run (turns 59-87,
//            cacheRead frozen at 32483, ~$25 cache-write), several idle-gap
//            TTL re-writes, and a large-context tail (cacheRead 180k-358k).
// SPDX-License-Identifier: MIT

import {
  type CachingModel,
  type NormalizedSession,
  type NormalizedTurn,
  sessionCostTotals,
  turnContextTokens,
} from './turn-model.ts';

export type DetectorId =
  | 'cache-poisoning'
  | 'cache-write-dominant'
  | 'ttl-expiry'
  | 'cache-bust'
  | 'large-context-carry';

export type Severity = 'info' | 'warn' | 'critical';

export interface TurnRange {
  startIndex: number;
  endIndex: number;
  startTime?: string;
  endTime?: string;
  turnCount: number;
}

export interface Finding {
  detector: DetectorId;
  severity: Severity;
  range: TurnRange;
  // Dollars this detector attributes to the flagged range. 0 when the log
  // carried no cost and no pricing backfill ran.
  dollarsAttributed: number;
  // One-line description of what was observed (token counts, ratios).
  explanation: string;
  // What to do about it.
  remediation: string;
}

export interface DetectorConfig {
  // cache-poisoning: minimum consecutive frozen-cacheRead turns to flag.
  poisonMinRun: number;
  // cache-poisoning: a run's cacheRead values must vary by <= this fraction
  // of the run max to count as "frozen".
  poisonFreezeRelTol: number;
  // cache-poisoning: median (cacheWrite / context) over the run must reach
  // this to flag (separates costly poison from cheap stable plateaus).
  poisonWriteShare: number;
  // cache-write-dominant: session cacheWrite cost / total cost threshold.
  writeDominantRatio: number;
  // ttl-expiry: idle gap (s) above which a cacheRead->0 drop is treated as a
  // cache-TTL expiry rather than a content mutation.
  ttlSec: number;
  // large-context-carry: per-turn context tokens above which the context is
  // "large", and the minimum sustained run length to flag.
  largeContextTokens: number;
  largeContextMinRun: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  poisonMinRun: 4,
  poisonFreezeRelTol: 0.02,
  poisonWriteShare: 0.5,
  writeDominantRatio: 0.7,
  ttlSec: 300,
  largeContextTokens: 150_000,
  largeContextMinRun: 8,
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function rangeOf(turns: NormalizedTurn[], start: number, end: number): TurnRange {
  return {
    startIndex: turns[start].index,
    endIndex: turns[end].index,
    startTime: turns[start].timestamp || undefined,
    endTime: turns[end].timestamp || undefined,
    turnCount: end - start + 1,
  };
}

function sumCacheWriteCost(turns: NormalizedTurn[], start: number, end: number): number {
  let acc = 0;
  for (let i = start; i <= end; i++) acc += turns[i].cost?.cacheWrite ?? 0;
  return acc;
}

function sumCacheReadCost(turns: NormalizedTurn[], start: number, end: number): number {
  let acc = 0;
  for (let i = start; i <= end; i++) acc += turns[i].cost?.cacheRead ?? 0;
  return acc;
}

function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

// ---------------------------------------------------------------------------
// cache-poisoning (anthropic-style only)
// ---------------------------------------------------------------------------
//
// Signature: cacheRead pinned to a near-constant value across many turns
// (the cached prefix never advances) while cacheWrite re-writes most of the
// context every turn. This is the ephemeral-tail cache trap: a per-turn
// block sits inside the cached prefix, so the conversation breakpoint never
// matches and the whole history re-writes at the 1.25x rate each turn.

export function detectCachePoisoning(session: NormalizedSession, cfg: DetectorConfig): Finding[] {
  const turns = session.turns;
  const findings: Finding[] = [];
  let i = 0;

  while (i < turns.length) {
    if (turns[i].cachingModel !== 'anthropic') {
      i++;
      continue;
    }

    // Extend a maximal frozen-cacheRead run starting at i.
    let runMin = turns[i].tokens.cacheReadInput;
    let runMax = runMin;
    let j = i;
    while (j + 1 < turns.length && turns[j + 1].cachingModel === 'anthropic') {
      const next = turns[j + 1].tokens.cacheReadInput;
      const newMin = Math.min(runMin, next);
      const newMax = Math.max(runMax, next);
      // All-zero is "no caching at all", not a frozen positive prefix - and
      // would divide by zero below. A frozen poison prefix is > 0.
      if (newMax === 0) break;
      if ((newMax - newMin) / newMax > cfg.poisonFreezeRelTol) break;
      runMin = newMin;
      runMax = newMax;
      j++;
    }

    const runLen = j - i + 1;
    if (runLen >= cfg.poisonMinRun && runMax > 0) {
      const shares: number[] = [];
      for (let k = i; k <= j; k++) {
        const ctx = turnContextTokens(turns[k]);
        shares.push(ctx > 0 ? turns[k].tokens.cacheWriteInput / ctx : 0);
      }
      const medShare = median(shares);
      if (medShare >= cfg.poisonWriteShare) {
        const dollars = sumCacheWriteCost(turns, i, j);
        const frozenAt = Math.round((runMin + runMax) / 2);
        findings.push({
          detector: 'cache-poisoning',
          severity: dollars >= 1 || medShare >= 0.7 ? 'critical' : 'warn',
          range: rangeOf(turns, i, j),
          dollarsAttributed: dollars,
          explanation:
            `cacheRead frozen at ~${fmtK(frozenAt)} tokens across ${runLen} turns while ` +
            `cacheWrite re-wrote a median ${(medShare * 100).toFixed(0)}% of context each turn`,
          remediation:
            'a per-turn-changing block sits inside the cached prefix; move volatile/ephemeral ' +
            'content off the cache breakpoint (see cache-breakpoint extension)',
        });
      }
      // Whole plateau evaluated as one unit; jump past it either way.
      i = j + 1;
      continue;
    }
    i++;
  }

  return findings;
}

// ---------------------------------------------------------------------------
// cache-write-dominant (anthropic-style only)
// ---------------------------------------------------------------------------
//
// Session-level: when most spend is re-writing the cache, something is wrong
// (poisoning, or repeated TTL churn). Complements cache-poisoning, which
// localizes the offending turns; this is the blunt session-wide ratio.

export function detectCacheWriteDominant(session: NormalizedSession, cfg: DetectorConfig): Finding[] {
  const anthropicTurns = session.turns.filter((t) => t.cachingModel === 'anthropic');
  if (anthropicTurns.length === 0) return [];

  const totals = sessionCostTotals({ ...session, turns: anthropicTurns });
  if (totals.total <= 0) return [];

  const ratio = totals.cacheWrite / totals.total;
  if (ratio < cfg.writeDominantRatio) return [];

  const first = anthropicTurns[0];
  const last = anthropicTurns[anthropicTurns.length - 1];
  return [
    {
      detector: 'cache-write-dominant',
      severity: 'critical',
      range: {
        startIndex: first.index,
        endIndex: last.index,
        startTime: first.timestamp || undefined,
        endTime: last.timestamp || undefined,
        turnCount: anthropicTurns.length,
      },
      dollarsAttributed: totals.cacheWrite,
      explanation: `${(ratio * 100).toFixed(0)}% of session cost ($${totals.cacheWrite.toFixed(2)} of $${totals.total.toFixed(2)}) is cache-write`,
      remediation: 'most spend is re-writing cache; check for poisoning or TTL churn',
    },
  ];
}

// ---------------------------------------------------------------------------
// ttl-expiry
// ---------------------------------------------------------------------------
//
// A turn whose cacheRead collapsed to 0 right after a predecessor that had a
// warm cache, separated by an idle gap longer than the provider cache TTL.
// The whole prefix re-writes once. Inherent (not a bug) but worth attributing
// - and distinguishable from a content-mutation bust by the wall-clock gap.

export function detectTtlExpiry(session: NormalizedSession, cfg: DetectorConfig): Finding[] {
  const turns = session.turns;
  const findings: Finding[] = [];

  for (let i = 1; i < turns.length; i++) {
    const turn = turns[i];
    const prev = turns[i - 1];
    if (turn.cachingModel === 'none') continue;
    if (prev.tokens.cacheReadInput <= 0) continue; // predecessor wasn't warm
    if (turn.tokens.cacheReadInput > 0) continue; // this turn still hit cache
    const gap = turn.gapSecFromPrev;
    if (gap === undefined || gap < cfg.ttlSec) continue; // mutation bust, not TTL

    // Did anything actually re-write? Anthropic: cacheWrite slice. OpenAI:
    // the (now uncached) fresh input is reprocessed.
    const anthropic = turn.cachingModel === 'anthropic';
    const rewroteTokens = anthropic ? turn.tokens.cacheWriteInput : turn.tokens.input;
    if (rewroteTokens <= 0) continue;
    const dollars = anthropic ? (turn.cost?.cacheWrite ?? 0) : (turn.cost?.input ?? 0);

    const mins = Math.round(gap / 60);
    findings.push({
      detector: 'ttl-expiry',
      severity: 'warn',
      range: rangeOf(turns, i, i),
      dollarsAttributed: dollars,
      explanation:
        `cacheRead dropped to 0 after a ${mins}m idle gap; ${fmtK(rewroteTokens)} tokens of ` +
        'prefix re-written once',
      remediation:
        'idle gap blew the cache TTL; unavoidable, or use 1h cache retention if you ' + 'pause-and-resume often',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// cache-bust
// ---------------------------------------------------------------------------
//
// The sibling of ttl-expiry: cacheRead collapses to 0 right after a warm
// predecessor, but the idle gap is SHORTER than the cache TTL - so time did
// not blow the cache. Something invalidated the prefix mid-session: a
// /compact, an in-place history edit (tool-output condense / context-trim /
// collapse), a model switch, or large inline images churning the prefix. The
// whole prefix re-writes once. Mutually exclusive with ttl-expiry by the gap
// threshold, so the two never double-count the same turn.

export function detectCacheBust(session: NormalizedSession, cfg: DetectorConfig): Finding[] {
  const turns = session.turns;
  const findings: Finding[] = [];

  for (let i = 1; i < turns.length; i++) {
    const turn = turns[i];
    const prev = turns[i - 1];
    if (turn.cachingModel === 'none') continue;
    if (prev.tokens.cacheReadInput <= 0) continue; // predecessor wasn't warm
    if (turn.tokens.cacheReadInput > 0) continue; // this turn still hit cache
    const gap = turn.gapSecFromPrev;
    // An unknown or TTL-sized gap is handled by detectTtlExpiry; here we only
    // want busts that happened well within the cache lifetime.
    if (gap === undefined || gap >= cfg.ttlSec) continue;

    const anthropic = turn.cachingModel === 'anthropic';
    const rewroteTokens = anthropic ? turn.tokens.cacheWriteInput : turn.tokens.input;
    if (rewroteTokens <= 0) continue;
    const dollars = anthropic ? (turn.cost?.cacheWrite ?? 0) : (turn.cost?.input ?? 0);

    findings.push({
      detector: 'cache-bust',
      severity: 'warn',
      range: rangeOf(turns, i, i),
      dollarsAttributed: dollars,
      explanation:
        `cacheRead dropped to 0 only ${Math.round(gap)}s after the previous turn (within the cache TTL); ` +
        `${fmtK(rewroteTokens)} tokens of prefix re-written`,
      remediation:
        'a mid-session cache bust not explained by idle time; check for in-place history edits ' +
        '(tool-output condense / context-trim / collapse), a model switch, or large inline images',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// large-context-carry
// ---------------------------------------------------------------------------
//
// Even with perfect caching, a large context costs real money to read (or
// re-write) every turn. Sustained large per-turn context is the dominant
// cost once poisoning is fixed; the lever is /compact, not caching tweaks.
// Uses total context tokens (read + write + fresh) so a single TTL re-write
// turn inside the stretch doesn't fragment the run.

export function detectLargeContextCarry(session: NormalizedSession, cfg: DetectorConfig): Finding[] {
  const turns = session.turns;
  const findings: Finding[] = [];
  let i = 0;

  while (i < turns.length) {
    if (turns[i].cachingModel === 'none' || turnContextTokens(turns[i]) < cfg.largeContextTokens) {
      i++;
      continue;
    }
    let j = i;
    while (
      j + 1 < turns.length &&
      turns[j + 1].cachingModel !== 'none' &&
      turnContextTokens(turns[j + 1]) >= cfg.largeContextTokens
    ) {
      j++;
    }

    const runLen = j - i + 1;
    if (runLen >= cfg.largeContextMinRun) {
      const contexts: number[] = [];
      for (let k = i; k <= j; k++) contexts.push(turnContextTokens(turns[k]));
      const medCtx = median(contexts);
      const dollars = sumCacheReadCost(turns, i, j);
      findings.push({
        detector: 'large-context-carry',
        severity: dollars >= 2 ? 'warn' : 'info',
        range: rangeOf(turns, i, j),
        dollarsAttributed: dollars,
        explanation: `context sustained at a median ~${fmtK(medCtx)} tokens across ${runLen} turns (read every turn)`,
        remediation: 'context is large; /compact or branch a fresh session to shrink the carried prefix',
      });
    }
    i = j + 1;
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export const ALL_DETECTORS: ((s: NormalizedSession, c: DetectorConfig) => Finding[])[] = [
  detectCachePoisoning,
  detectCacheWriteDominant,
  detectTtlExpiry,
  detectCacheBust,
  detectLargeContextCarry,
];

export function runDetectors(session: NormalizedSession, cfg: DetectorConfig = DEFAULT_DETECTOR_CONFIG): Finding[] {
  const findings: Finding[] = [];
  for (const detector of ALL_DETECTORS) findings.push(...detector(session, cfg));
  // Stable order: by first turn, then by descending dollars within a turn.
  findings.sort((a, b) => a.range.startIndex - b.range.startIndex || b.dollarsAttributed - a.dollarsAttributed);
  return findings;
}

// Convenience for callers that only know the caching model at the session
// level (e.g. before per-turn classification). Not used by detectors.
export function dominantCachingModel(session: NormalizedSession): CachingModel {
  const counts = new Map<CachingModel, number>();
  for (const t of session.turns) counts.set(t.cachingModel, (counts.get(t.cachingModel) ?? 0) + 1);
  let best: CachingModel = 'none';
  let bestN = -1;
  for (const [m, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = m;
    }
  }
  return best;
}
