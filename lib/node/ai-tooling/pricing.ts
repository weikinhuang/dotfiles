// Model pricing loader + cost estimators for session-usage scripts.
// Prices come from LiteLLM's community-maintained JSON and are cached to
// disk so the CLI stays fast on repeat invocations.
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';

import type { SessionTokens } from './types.ts';

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CostVariant = 'anthropic' | 'openai';

export interface ModelPricing {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken?: number;
  cacheWritePerToken?: number;
}

export interface PricingTable {
  models: Record<string, ModelPricing>;
  fetchedAt: string;
  source: 'fetch' | 'cache' | 'stale' | 'empty';
}

function cacheFile(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const root = xdg && xdg !== '' ? xdg : path.join(process.env.HOME ?? '', '.cache');
  return path.join(root, 'ai-tool-usage', 'pricing.json');
}

function parseLiteLlm(raw: unknown): Record<string, ModelPricing> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, ModelPricing> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== 'object' || val === null) continue;
    const v = val as Record<string, unknown>;
    const input = v.input_cost_per_token;
    const output = v.output_cost_per_token;
    if (typeof input !== 'number' || typeof output !== 'number') continue;
    const mp: ModelPricing = { inputPerToken: input, outputPerToken: output };
    if (typeof v.cache_read_input_token_cost === 'number') {
      mp.cacheReadPerToken = v.cache_read_input_token_cost;
    }
    if (typeof v.cache_creation_input_token_cost === 'number') {
      mp.cacheWritePerToken = v.cache_creation_input_token_cost;
    }
    out[key] = mp;
  }
  return out;
}

interface CachePayload {
  fetched_at: string;
  data: unknown;
}

function readCache(): CachePayload | undefined {
  const file = cacheFile();
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as CachePayload;
    if (typeof parsed.fetched_at !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeCache(payload: CachePayload): void {
  const file = cacheFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
}

export async function loadPricing(refresh = false): Promise<PricingTable> {
  const cached = readCache();
  const cachedAge = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;
  const fresh = cached && cachedAge >= 0 && cachedAge < TTL_MS;

  if (fresh && !refresh) {
    return { models: parseLiteLlm(cached!.data), fetchedAt: cached!.fetched_at, source: 'cache' };
  }

  try {
    const res = await fetch(LITELLM_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as unknown;
    const now = new Date().toISOString();
    writeCache({ fetched_at: now, data });
    return { models: parseLiteLlm(data), fetchedAt: now, source: 'fetch' };
  } catch (err) {
    if (cached) {
      return { models: parseLiteLlm(cached.data), fetchedAt: cached.fetched_at, source: 'stale' };
    }
    console.error(`ai-tool-usage: could not load model pricing (${(err as Error).message}); costs will be $0`);
    return { models: {}, fetchedAt: '', source: 'empty' };
  }
}

// ---------------------------------------------------------------------------
// Model ID matching
// ---------------------------------------------------------------------------

function candidateKeys(modelId: string): string[] {
  if (!modelId) return [];
  const seen = new Set<string>();
  const push = (s: string) => {
    if (s && !seen.has(s)) seen.add(s);
  };

  push(modelId);
  // Strip trailing -YYYYMMDD date suffix (Anthropic snapshots).
  const noDate = modelId.replace(/-\d{8}$/, '');
  push(noDate);
  // Strip bracketed token-window suffix like "[1m]" (custom tags, e.g. claude-opus-4-7[1m]).
  const noSuffix = noDate.replace(/\[[^\]]+\]$/, '');
  push(noSuffix);
  // Provider-prefixed variants used by LiteLLM.
  for (const base of [modelId, noDate, noSuffix]) {
    push(`anthropic/${base}`);
    push(`openai/${base}`);
  }
  return [...seen];
}

export function lookupPricing(table: PricingTable, modelId: string): ModelPricing | undefined {
  for (const key of candidateKeys(modelId)) {
    const p = table.models[key];
    if (p) return p;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Cost estimators
// ---------------------------------------------------------------------------
//
// Anthropic Messages API `usage` semantics: input_tokens excludes cached
// tokens; cache_creation_input_tokens and cache_read_input_tokens are
// reported separately. Each gets its own per-token rate.
//
// OpenAI Responses API `usage` semantics: input_tokens is the grand total
// (including cached); cached portion is broken out in
// input_tokens_details.cached_tokens. Output_tokens includes reasoning
// tokens. We split fresh vs cached so the cached rate applies only to the
// cached slice.

export function estimateAnthropicCost(tokens: SessionTokens, p: ModelPricing): number {
  const cacheRead = tokens.cacheRead ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  return (
    tokens.input * p.inputPerToken +
    tokens.output * p.outputPerToken +
    cacheRead * (p.cacheReadPerToken ?? p.inputPerToken * 0.1) +
    cacheWrite * (p.cacheWritePerToken ?? p.inputPerToken * 1.25)
  );
}

export function estimateOpenAICost(tokens: SessionTokens, p: ModelPricing): number {
  const cacheRead = tokens.cacheRead ?? 0;
  const freshInput = Math.max(0, tokens.input - cacheRead);
  return (
    freshInput * p.inputPerToken +
    cacheRead * (p.cacheReadPerToken ?? p.inputPerToken * 0.5) +
    tokens.output * p.outputPerToken
  );
}

export function estimateCost(variant: CostVariant, tokens: SessionTokens, p: ModelPricing): number {
  return variant === 'anthropic' ? estimateAnthropicCost(tokens, p) : estimateOpenAICost(tokens, p);
}
