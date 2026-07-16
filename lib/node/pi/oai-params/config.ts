/**
 * Pure parsers for the `oai-params.json` config shape. Untrusted
 * `unknown` in -> validated {@link ParsedVariant}s out, dropping malformed
 * entries and collecting human-readable errors.
 *
 * No pi imports - directly unit-testable.
 */

import { RESERVED_KEYS, type JsonValue, type ParsedVariant, type SamplingParams } from './types.ts';

/**
 * Validate a `samplingParams` block: keep every JSON-typed key except the
 * reserved payload fields (see {@link RESERVED_KEYS}). Non-object input
 * yields `{}`. Dropped reserved keys are reported via `onReserved`.
 */
export function parseSamplingParams(raw: unknown, onReserved?: (key: string) => void): SamplingParams {
  const out: SamplingParams = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (RESERVED_KEYS.has(key)) {
      onReserved?.(key);
      continue;
    }
    out[key] = value as JsonValue;
  }
  return out;
}

/**
 * Split an `extends` value of the form `"provider/id"` into its parts.
 * Both sides must be non-empty; the split is on the FIRST `/` so parent
 * ids may themselves contain slashes. Returns `undefined` when malformed.
 */
export function parseExtends(raw: unknown): { provider: string; id: string } | undefined {
  if (typeof raw !== 'string') return undefined;
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash >= raw.length - 1) return undefined;
  const provider = raw.slice(0, slash).trim();
  const id = raw.slice(slash + 1).trim();
  if (!provider || !id) return undefined;
  return { provider, id };
}

/**
 * Parse an entire `oai-params.json` object (a map of new-model-id ->
 * entry) into validated variants. Malformed entries are skipped and
 * described in `errors`. Non-object entries (including a `$schema`
 * string) are ignored silently.
 */
export function parseVariants(raw: unknown): { variants: ParsedVariant[]; errors: string[] } {
  const variants: ParsedVariant[] = [];
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { variants, errors };

  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;

    const parent = parseExtends(obj.extends);
    if (!parent) {
      errors.push(`variant "${id}": "extends" must be a "provider/id" string`);
      continue;
    }

    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : id;
    const samplingParams = parseSamplingParams(obj.samplingParams, (key) => {
      errors.push(`variant "${id}": ignoring reserved sampling key "${key}"`);
    });

    variants.push({ id, name, parentProvider: parent.provider, parentId: parent.id, samplingParams });
  }

  return { variants, errors };
}
