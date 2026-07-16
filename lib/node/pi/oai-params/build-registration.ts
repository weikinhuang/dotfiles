/**
 * Pure logic that turns parsed {@link ParsedVariant}s plus a parsed
 * `models.json` object into (a) the provider-registration specs the
 * extension shell hands to `pi.registerProvider`, and (b) the per-provider
 * injection map the `before_provider_request` hook consults at request
 * time. Everything is derived from `models.json` alone - no pi model
 * registry needed - so registration can happen at extension load.
 *
 * No pi imports - directly unit-testable.
 */

import type {
  JsonValue,
  ModelRegistrationSpec,
  ParsedVariant,
  ProviderRegistrationSpec,
  VariantInjection,
} from './types.ts';

/** Only OpenAI-compatible parents can be extended (llama.cpp, litellm, ...). */
const OAI_API = 'openai-completions';

interface ModelsJsonProvider {
  baseUrl?: unknown;
  apiKey?: unknown;
  api?: unknown;
  headers?: unknown;
  authHeader?: unknown;
  compat?: unknown;
  models?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function mergeStringRecords(
  base: Record<string, string> | undefined,
  override: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override };
}

function mergeCompat(base: unknown, override: unknown): JsonValue | undefined {
  const b = asRecord(base);
  const o = asRecord(override);
  if (!b && !o) return undefined;
  return { ...b, ...o } as JsonValue;
}

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Build registration specs + the injection map from parsed variants and a
 * parsed `models.json` `providers` object. Variants whose parent provider
 * or model can't be resolved (or aren't OpenAI-compatible) are skipped and
 * described in `errors`.
 */
export function buildRegistrations(
  variants: ParsedVariant[],
  providers: Record<string, unknown> | undefined,
): {
  registrations: ProviderRegistrationSpec[];
  injections: Map<string, VariantInjection>;
  errors: string[];
} {
  const registrations: ProviderRegistrationSpec[] = [];
  const injections = new Map<string, VariantInjection>();
  const errors: string[] = [];
  const providerMap = asRecord(providers);

  for (const variant of variants) {
    const provider = providerMap?.[variant.parentProvider] as ModelsJsonProvider | undefined;
    const providerRec = asRecord(provider);
    if (!providerRec) {
      errors.push(`variant "${variant.id}": unknown provider "${variant.parentProvider}" in models.json`);
      continue;
    }

    const models = Array.isArray(providerRec.models) ? (providerRec.models as unknown[]) : [];
    const modelEntry = models.map((m) => asRecord(m)).find((m) => m?.id === variant.parentId);
    if (!modelEntry) {
      errors.push(
        `variant "${variant.id}": model "${variant.parentId}" not found under provider "${variant.parentProvider}"`,
      );
      continue;
    }

    const api =
      (typeof modelEntry.api === 'string' && modelEntry.api) ||
      (typeof providerRec.api === 'string' && providerRec.api) ||
      OAI_API;
    if (api !== OAI_API) {
      errors.push(
        `variant "${variant.id}": parent "${variant.parentProvider}/${variant.parentId}" is not ${OAI_API} (got "${api}")`,
      );
      continue;
    }

    const baseUrl =
      (typeof modelEntry.baseUrl === 'string' && modelEntry.baseUrl) ||
      (typeof providerRec.baseUrl === 'string' && providerRec.baseUrl) ||
      '';
    if (!baseUrl) {
      errors.push(`variant "${variant.id}": no baseUrl resolvable for parent "${variant.parentProvider}"`);
      continue;
    }

    const contextWindow = typeof modelEntry.contextWindow === 'number' ? modelEntry.contextWindow : undefined;
    const maxTokens = typeof modelEntry.maxTokens === 'number' ? modelEntry.maxTokens : undefined;
    if (contextWindow === undefined || maxTokens === undefined) {
      errors.push(`variant "${variant.id}": parent model missing contextWindow/maxTokens`);
      continue;
    }

    const input: ('text' | 'image')[] = Array.isArray(modelEntry.input)
      ? modelEntry.input.filter((i): i is 'text' | 'image' => i === 'text' || i === 'image')
      : ['text'];
    const cost = asRecord(modelEntry.cost) ? (modelEntry.cost as ModelRegistrationSpec['cost']) : { ...DEFAULT_COST };

    const modelSpec: ModelRegistrationSpec = {
      id: variant.id,
      name: variant.name,
      api: OAI_API,
      reasoning: modelEntry.reasoning === true,
      input: input.length ? input : ['text'],
      cost,
      contextWindow,
      maxTokens,
      compat: mergeCompat(providerRec.compat, modelEntry.compat),
      thinkingLevelMap: asRecord(modelEntry.thinkingLevelMap) ? (modelEntry.thinkingLevelMap as JsonValue) : undefined,
    };

    registrations.push({
      providerName: variant.id,
      baseUrl,
      apiKey: typeof providerRec.apiKey === 'string' ? providerRec.apiKey : undefined,
      api: OAI_API,
      headers: mergeStringRecords(asStringRecord(providerRec.headers), asStringRecord(modelEntry.headers)),
      authHeader: providerRec.authHeader === true ? true : undefined,
      models: [modelSpec],
    });

    injections.set(variant.id, { parentId: variant.parentId, samplingParams: variant.samplingParams });
  }

  return { registrations, injections, errors };
}
