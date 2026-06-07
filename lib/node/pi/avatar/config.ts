/**
 * Pure config defaults + coercion + layering for the `avatar` extension.
 *
 * The extension shell reads JSON from disk (extension default -> user
 * global -> project local) and feeds each parsed layer through
 * {@link coerceConfigLayer} (untrusted `unknown` -> validated
 * `Partial<AvatarConfig>`) and then {@link mergeConfigLayers}. Keeping
 * validation + merge here makes it unit-testable without touching the
 * filesystem.
 */

import type { AvatarConfig, EmoteMapping, HoldDuration } from './types.ts';

/** Shipped defaults used as the lowest config layer. */
export const DEFAULT_CONFIG: AvatarConfig = {
  enabled: true,
  debug: false,
  size: 8,
  readingSpeed: 4,
  hideBelow: 40,
  emoteHoldMs: 4000,
  holdDuration: { hi: 2000, success: 1200, failure: 1200 },
  blinkInterval: [3000, 6000],
  talkTickMs: 120,
  cycleMs: 500,
  render: 'auto',
  compact: true,
  scenePlacement: 'above',
  sceneMaxRows: 12,
  emotes: [{ model: '*', 'emote-set': 'default' }],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumberPair(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const a = asFiniteNumber(value[0]);
  const b = asFiniteNumber(value[1]);
  if (a === undefined || b === undefined) return undefined;
  return [a, b];
}

function asRender(value: unknown): AvatarConfig['render'] | undefined {
  if (
    value === 'auto' ||
    value === 'kitty' ||
    value === 'iterm2' ||
    value === 'sixel' ||
    value === 'halfblock' ||
    value === 'ascii'
  ) {
    return value;
  }
  return undefined;
}

function asScenePlacement(value: unknown): AvatarConfig['scenePlacement'] | undefined {
  return value === 'above' || value === 'below' || value === 'replace' ? value : undefined;
}

function asHoldDuration(value: unknown): Partial<HoldDuration> | undefined {
  if (!isObject(value)) return undefined;
  const out: Partial<HoldDuration> = {};
  const hi = asFiniteNumber(value.hi);
  const success = asFiniteNumber(value.success);
  const failure = asFiniteNumber(value.failure);
  if (hi !== undefined) out.hi = hi;
  if (success !== undefined) out.success = success;
  if (failure !== undefined) out.failure = failure;
  return out;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === 'string');
  return out.length > 0 ? out : undefined;
}

function asEmoteMappings(value: unknown): EmoteMapping[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: EmoteMapping[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const model = asString(entry.model);
    const set = asString(entry['emote-set']);
    if (model !== undefined && set !== undefined) {
      const mapping: EmoteMapping = { model, 'emote-set': set };
      const overlays = asStringArray(entry.overlays);
      if (overlays !== undefined) mapping.overlays = overlays;
      out.push(mapping);
    }
  }
  return out;
}

/**
 * Validate an untrusted parsed JSON layer into a `Partial<AvatarConfig>`,
 * dropping any field with the wrong type. Returns an empty object for a
 * non-object input.
 */
export function coerceConfigLayer(raw: unknown): Partial<AvatarConfig> {
  if (!isObject(raw)) return {};
  const out: Partial<AvatarConfig> = {};

  const enabled = asBoolean(raw.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  const debug = asBoolean(raw.debug);
  if (debug !== undefined) out.debug = debug;
  const compact = asBoolean(raw.compact);
  if (compact !== undefined) out.compact = compact;

  const size = asFiniteNumber(raw.size);
  if (size !== undefined) out.size = size;
  const readingSpeed = asFiniteNumber(raw.readingSpeed);
  if (readingSpeed !== undefined) out.readingSpeed = readingSpeed;
  const hideBelow = asFiniteNumber(raw.hideBelow);
  if (hideBelow !== undefined) out.hideBelow = hideBelow;
  const emoteHoldMs = asFiniteNumber(raw.emoteHoldMs);
  if (emoteHoldMs !== undefined) out.emoteHoldMs = emoteHoldMs;
  const talkTickMs = asFiniteNumber(raw.talkTickMs);
  if (talkTickMs !== undefined) out.talkTickMs = talkTickMs;
  const cycleMs = asFiniteNumber(raw.cycleMs);
  if (cycleMs !== undefined) out.cycleMs = cycleMs;

  const blinkInterval = asNumberPair(raw.blinkInterval);
  if (blinkInterval !== undefined) out.blinkInterval = blinkInterval;

  const render = asRender(raw.render);
  if (render !== undefined) out.render = render;

  const scenePlacement = asScenePlacement(raw.scenePlacement);
  if (scenePlacement !== undefined) out.scenePlacement = scenePlacement;
  const sceneMaxRows = asFiniteNumber(raw.sceneMaxRows);
  if (sceneMaxRows !== undefined) out.sceneMaxRows = Math.max(1, Math.floor(sceneMaxRows));

  const holdDuration = asHoldDuration(raw.holdDuration);
  if (holdDuration !== undefined && Object.keys(holdDuration).length > 0) {
    out.holdDuration = { ...DEFAULT_CONFIG.holdDuration, ...holdDuration };
  }

  const emotes = asEmoteMappings(raw.emotes);
  if (emotes !== undefined) out.emotes = emotes;

  return out;
}

/**
 * Concatenate emote mappings across layers in priority order (lowest
 * first). Since resolution is "last match wins", appending higher
 * layers later naturally lets them override. Empty layers are skipped;
 * an all-empty result falls back to the default catch-all.
 */
export function mergeEmoteMappings(...layers: (readonly EmoteMapping[] | undefined)[]): EmoteMapping[] {
  const out: EmoteMapping[] = [];
  for (const layer of layers) {
    if (layer && layer.length > 0) out.push(...layer);
  }
  return out.length > 0 ? out : [...DEFAULT_CONFIG.emotes];
}

/**
 * Layer `overrides` over {@link DEFAULT_CONFIG} in priority order
 * (lowest first). Scalars and `blinkInterval` are replaced wholesale;
 * `holdDuration` merges field-wise; `emotes` appends across layers so
 * last-match-wins resolution sees every layer's mappings.
 */
export function mergeConfigLayers(...overrides: Partial<AvatarConfig>[]): AvatarConfig {
  const result: AvatarConfig = {
    ...DEFAULT_CONFIG,
    holdDuration: { ...DEFAULT_CONFIG.holdDuration },
    blinkInterval: [...DEFAULT_CONFIG.blinkInterval],
    emotes: [...DEFAULT_CONFIG.emotes],
  };

  for (const layer of overrides) {
    if (layer.enabled !== undefined) result.enabled = layer.enabled;
    if (layer.debug !== undefined) result.debug = layer.debug;
    if (layer.compact !== undefined) result.compact = layer.compact;
    if (layer.size !== undefined) result.size = layer.size;
    if (layer.readingSpeed !== undefined) result.readingSpeed = layer.readingSpeed;
    if (layer.hideBelow !== undefined) result.hideBelow = layer.hideBelow;
    if (layer.emoteHoldMs !== undefined) result.emoteHoldMs = layer.emoteHoldMs;
    if (layer.talkTickMs !== undefined) result.talkTickMs = layer.talkTickMs;
    if (layer.cycleMs !== undefined) result.cycleMs = layer.cycleMs;
    if (layer.render !== undefined) result.render = layer.render;
    if (layer.scenePlacement !== undefined) result.scenePlacement = layer.scenePlacement;
    if (layer.sceneMaxRows !== undefined) result.sceneMaxRows = layer.sceneMaxRows;
    if (layer.blinkInterval !== undefined) result.blinkInterval = [...layer.blinkInterval];
    if (layer.holdDuration !== undefined) result.holdDuration = { ...result.holdDuration, ...layer.holdDuration };
  }

  result.emotes = mergeEmoteMappings(DEFAULT_CONFIG.emotes, ...overrides.map((layer) => layer.emotes));
  return result;
}
