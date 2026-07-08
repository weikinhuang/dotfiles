/**
 * Pure `provider/id` model-spec parser for the persona extension.
 *
 * Both `applyModelAndThinking` (activation) and `clearPersona`
 * (restore) in `config/pi/extensions/persona.ts` split a
 * `"<provider>/<modelId>"` string the same way before handing the parts
 * to `ctx.modelRegistry.find`. Extracted here so the split rule lives in
 * one unit-tested place. The shell keeps the registry lookup + the
 * `pi.setModel` call + the warning notifications.
 */

export interface ModelSpec {
  provider: string;
  modelId: string;
}

/**
 * Parse a `"<provider>/<modelId>"` spec. Returns `null` when there is no
 * `/` or it is the first character (no provider), matching the original
 * `indexOf('/') > 0` guard so the callers' invalid / skip branches fire
 * exactly as before.
 */
export function parseModelSpec(model: string): ModelSpec | null {
  const slash = model.indexOf('/');
  if (slash > 0) {
    return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
  }
  return null;
}
