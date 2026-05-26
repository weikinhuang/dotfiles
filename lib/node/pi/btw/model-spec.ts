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
export { parseModelSpec, type ParsedModelSpec } from '../model-spec.ts';
