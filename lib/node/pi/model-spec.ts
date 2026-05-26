/**
 * Shared `provider/modelId` parser.
 *
 * Pi model specs use the first slash as the provider/model boundary;
 * model ids may themselves contain slashes. Callers choose either the
 * permissive env/config style (trim the whole input and each component)
 * or the strict slash-command style (reject component whitespace).
 */

import { trimOrUndefined } from './shared.ts';

export interface ParsedModelSpec {
  provider: string;
  modelId: string;
}

export type ModelSpecParseFailure = 'empty' | 'missing-slash' | 'empty-component' | 'component-whitespace';

export type ModelSpecParseResult = { ok: true; value: ParsedModelSpec } | { ok: false; failure: ModelSpecParseFailure };

export function parseModelSpecCore(
  spec: string | undefined,
  opts: { trimInput?: boolean; trimComponents?: boolean; rejectComponentWhitespace?: boolean } = {},
): ModelSpecParseResult {
  const raw = opts.trimInput ? trimOrUndefined(spec) : spec;
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, failure: 'empty' };
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return { ok: false, failure: 'missing-slash' };

  const rawProvider = raw.slice(0, slash);
  const rawModelId = raw.slice(slash + 1);
  if (opts.rejectComponentWhitespace && (rawProvider.trim() !== rawProvider || rawModelId.trim() !== rawModelId)) {
    return { ok: false, failure: 'component-whitespace' };
  }

  const provider = opts.trimComponents ? rawProvider.trim() : rawProvider;
  const modelId = opts.trimComponents ? rawModelId.trim() : rawModelId;
  if (!provider || !modelId) return { ok: false, failure: 'empty-component' };
  return { ok: true, value: { provider, modelId } };
}

export function parseModelSpec(spec: string | undefined): ParsedModelSpec | undefined {
  const parsed = parseModelSpecCore(spec, { trimInput: true, trimComponents: true });
  return parsed.ok ? parsed.value : undefined;
}

export function parseStrictModelSpec(spec: string): ParsedModelSpec | { error: string } {
  const parsed = parseModelSpecCore(spec, { rejectComponentWhitespace: true });
  if (parsed.ok) return parsed.value;
  if (parsed.failure === 'empty') {
    return { error: 'model override must be a non-empty "provider/id" string' };
  }
  if (parsed.failure === 'component-whitespace') {
    return {
      error: `invalid model override "${spec}" - provider / id must not have leading or trailing whitespace`,
    };
  }
  return { error: `invalid model override "${spec}" - expected "provider/id"` };
}
