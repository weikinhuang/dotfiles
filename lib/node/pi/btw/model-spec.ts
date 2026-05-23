/**
 * `provider/modelId` parser for `PI_BTW_MODEL` overrides.
 *
 * Pure module - no pi runtime - so the strict-vs-fuzzy decision and
 * whitespace handling are unit-testable.
 */

import { trimOrUndefined } from '../shared.ts';

export interface ParsedModelSpec {
  provider: string;
  modelId: string;
}

/**
 * Parse a `PI_BTW_MODEL` value of the form `provider/modelId` into its
 * two parts. Returns `undefined` for empty input, missing slash, or an
 * empty provider / modelId. Trims each component so `"anthropic / foo"`
 * still parses.
 *
 * pi's own `--model` flag accepts a richer grammar (globs, fuzzy match,
 * optional `:thinking` suffix); this helper is deliberately strict
 * because PI_BTW_MODEL is for unattended use and ambiguity on a
 * cost-bearing model switch is worse than a clear parse failure.
 */
export function parseModelSpec(spec: string | undefined): ParsedModelSpec | undefined {
  const raw = trimOrUndefined(spec);
  if (!raw) return undefined;
  const slash = raw.indexOf('/');
  if (slash <= 0) return undefined;
  const provider = raw.slice(0, slash).trim();
  const modelId = raw.slice(slash + 1).trim();
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}
