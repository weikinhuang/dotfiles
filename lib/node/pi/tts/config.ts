/**
 * Pure config defaults + coercion + layering for the `tts` extension.
 *
 * The extension shell reads JSONC from disk (shipped default -> user-global
 * `~/.pi/agent/tts.json` -> project-local `<cwd>/.pi/tts.json`), feeds each
 * parsed layer through {@link coerceConfigLayer} (untrusted `unknown` ->
 * validated `Partial<TtsConfig>`), then {@link mergeConfigLayers}. Keeping
 * validation + merge + env interpolation + voice resolution here makes the
 * core logic unit-testable without touching the network or a player.
 *
 * {@link loadTtsConfig} additionally does the disk wiring (read + coerce +
 * merge the user/project JSONC files) through {@link readJsoncOrUndefined} so
 * a missing / malformed file degrades to an empty layer rather than throwing.
 * Comments and trailing commas in the JSONC config are tolerated.
 *
 * Mirrors the comfyui extension's `config.ts`. No pi imports.
 *
 * NOTE (dev-only seam, plan decision 4): the three dotfiles libs are imported
 * by ABSOLUTE path while this lives in the project repo. On promotion to
 * dotfiles these flip to relative (`../fs-safe.ts`, `../pi-paths.ts`).
 */

import { readJsoncOrUndefined } from '../fs-safe.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';

import type { AuthHeader, EmoteRef, Reference, ResolvedVoice, TtsConfig, VoiceConfig } from './types.ts';

/** Pointer prefix that forces a voice down the clone path (plan decision 6). */
export const CLONE_PREFIX = 'clone:';

/** Shipped defaults used as the lowest config layer. */
export const DEFAULT_CONFIG: TtsConfig = {
  baseUrl: 'http://127.0.0.1:8880/v1',
  api: 'openai',
  format: 'wav',
  requestTimeoutMs: 180000, // generous: survives scale-from-zero cold start
  player: 'paplay',
  maxChunkChars: 240,
  maxNarrationChunks: 40,
  model: 'qwen3-tts',
  voices: {},
  rpVoice: '',
  narrationVoice: '',
};

// ──────────────────────────────────────────────────────────────────────
// Scalar coercion primitives (mirror comfyui/config.ts)
// ──────────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  const s = asString(value);
  return s !== undefined && s.length > 0 ? s : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    const s = asString(raw);
    if (s !== undefined) out.push(s);
  }
  return out.length > 0 ? out : undefined;
}

function asAuthHeader(value: unknown): AuthHeader | undefined {
  if (!isObject(value)) return undefined;
  const name = asString(value.name);
  const headerValue = asString(value.value);
  if (name === undefined || headerValue === undefined || name.length === 0) return undefined;
  return { name, value: headerValue };
}

// ──────────────────────────────────────────────────────────────────────
// Voice coercion
// ──────────────────────────────────────────────────────────────────────

/**
 * Validate one emote bucket. Requires a non-empty `match` list plus a
 * reference clip (audio + text); drops the bucket otherwise so a malformed
 * entry can never be selected.
 */
function asEmoteRef(value: unknown): EmoteRef | undefined {
  if (!isObject(value)) return undefined;
  const match = asStringArray(value.match);
  const refAudio = asNonEmptyString(value.refAudio);
  const refText = asString(value.refText);
  if (match === undefined || refAudio === undefined || refText === undefined) return undefined;
  return { match, refAudio, refText };
}

function asEmoteRefs(value: unknown): EmoteRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: EmoteRef[] = [];
  for (const raw of value) {
    const bucket = asEmoteRef(raw);
    if (bucket !== undefined) out.push(bucket);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate one roster voice. `kind` is taken literally when valid, else
 * inferred: a voice with `refAudio` is a clone, otherwise a preset. Optional
 * fields are carried through only when well-typed; everything else is dropped.
 */
function asVoiceConfig(value: unknown): VoiceConfig | undefined {
  if (!isObject(value)) return undefined;

  const refAudio = asNonEmptyString(value.refAudio);
  const declared = asString(value.kind);
  const kind: 'preset' | 'clone' =
    declared === 'preset' || declared === 'clone' ? declared : refAudio !== undefined ? 'clone' : 'preset';

  const out: VoiceConfig = { kind };

  const preset = asNonEmptyString(value.preset);
  if (preset !== undefined) out.preset = preset;
  const instruct = asString(value.instruct);
  if (instruct !== undefined) out.instruct = instruct;
  if (refAudio !== undefined) out.refAudio = refAudio;
  const refText = asString(value.refText);
  if (refText !== undefined) out.refText = refText;
  const promptLang = asNonEmptyString(value.promptLang);
  if (promptLang !== undefined) out.promptLang = promptLang;
  const emotes = asEmoteRefs(value.emotes);
  if (emotes !== undefined) out.emotes = emotes;
  const voiceBaseUrl = asNonEmptyString(value.baseUrl);
  if (voiceBaseUrl !== undefined) out.baseUrl = voiceBaseUrl;
  const voiceAuthHeader = asAuthHeader(value.authHeader);
  if (voiceAuthHeader !== undefined) out.authHeader = voiceAuthHeader;
  const gptWeights = asNonEmptyString(value.gptWeights);
  if (gptWeights !== undefined) out.gptWeights = gptWeights;
  const sovitsWeights = asNonEmptyString(value.sovitsWeights);
  if (sovitsWeights !== undefined) out.sovitsWeights = sovitsWeights;

  return out;
}

function asVoices(value: unknown): Record<string, VoiceConfig> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, VoiceConfig> = {};
  for (const [name, raw] of Object.entries(value)) {
    const voice = asVoiceConfig(raw);
    if (voice !== undefined) out[name] = voice;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Layer coercion + merge
// ──────────────────────────────────────────────────────────────────────

/**
 * Validate an untrusted parsed JSON layer into a `Partial<TtsConfig>`,
 * dropping any field with the wrong type. Returns an empty object for a
 * non-object input.
 */
export function coerceConfigLayer(raw: unknown): Partial<TtsConfig> {
  if (!isObject(raw)) return {};
  const out: Partial<TtsConfig> = {};

  const baseUrl = asNonEmptyString(raw.baseUrl);
  if (baseUrl !== undefined) out.baseUrl = baseUrl;

  const api = asString(raw.api);
  if (api === 'openai' || api === 'gpt-sovits') out.api = api;

  const format = asNonEmptyString(raw.format);
  if (format !== undefined) out.format = format;

  const requestTimeoutMs = asPositiveNumber(raw.requestTimeoutMs);
  if (requestTimeoutMs !== undefined) out.requestTimeoutMs = requestTimeoutMs;

  const player = asNonEmptyString(raw.player);
  if (player !== undefined) out.player = player;

  const maxChunkChars = asPositiveNumber(raw.maxChunkChars);
  if (maxChunkChars !== undefined) out.maxChunkChars = maxChunkChars;

  const maxNarrationChunks = asPositiveNumber(raw.maxNarrationChunks);
  if (maxNarrationChunks !== undefined) out.maxNarrationChunks = maxNarrationChunks;

  const model = asNonEmptyString(raw.model);
  if (model !== undefined) out.model = model;

  const authHeader = asAuthHeader(raw.authHeader);
  if (authHeader !== undefined) out.authHeader = authHeader;

  const voices = asVoices(raw.voices);
  if (voices !== undefined) out.voices = voices;

  const rpVoice = asNonEmptyString(raw.rpVoice);
  if (rpVoice !== undefined) out.rpVoice = rpVoice;

  const narrationVoice = asNonEmptyString(raw.narrationVoice);
  if (narrationVoice !== undefined) out.narrationVoice = narrationVoice;

  return out;
}

/**
 * Layer `overrides` over {@link DEFAULT_CONFIG} in priority order (lowest
 * first). Scalars are replaced wholesale; `authHeader` is replaced wholesale
 * by any layer that sets it; `voices` merge by key so a higher layer can add a
 * voice or replace one by name without dropping the others.
 */
export function mergeConfigLayers(...overrides: Partial<TtsConfig>[]): TtsConfig {
  const result: TtsConfig = { ...DEFAULT_CONFIG, voices: { ...DEFAULT_CONFIG.voices } };

  for (const layer of overrides) {
    if (layer.baseUrl !== undefined) result.baseUrl = layer.baseUrl;
    if (layer.api !== undefined) result.api = layer.api;
    if (layer.format !== undefined) result.format = layer.format;
    if (layer.requestTimeoutMs !== undefined) result.requestTimeoutMs = layer.requestTimeoutMs;
    if (layer.player !== undefined) result.player = layer.player;
    if (layer.maxChunkChars !== undefined) result.maxChunkChars = layer.maxChunkChars;
    if (layer.maxNarrationChunks !== undefined) result.maxNarrationChunks = layer.maxNarrationChunks;
    if (layer.model !== undefined) result.model = layer.model;
    if (layer.authHeader !== undefined) result.authHeader = { ...layer.authHeader };
    if (layer.voices !== undefined) result.voices = { ...result.voices, ...layer.voices };
    if (layer.rpVoice !== undefined) result.rpVoice = layer.rpVoice;
    if (layer.narrationVoice !== undefined) result.narrationVoice = layer.narrationVoice;
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Env interpolation + URL / header resolution (mirror comfyui/config.ts)
// ──────────────────────────────────────────────────────────────────────

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Expand `${VAR}` references in `value` from `env`. An undefined or missing
 * variable expands to the empty string, so a configured-but-unset token yields
 * no credential rather than leaking the literal `${VAR}`.
 */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_REF, (_match, name: string) => env[name] ?? '');
}

/**
 * Resolve the effective base URL: `PI_TTS_URL` wins over the config value,
 * then `${ENV}` interpolation is applied and any trailing slash is dropped so
 * URL joining stays predictable.
 */
export function resolveBaseUrl(config: TtsConfig, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_TTS_URL?.trim();
  const raw = override !== undefined && override.length > 0 ? override : config.baseUrl;
  return interpolateEnv(raw, env).replace(/\/+$/, '');
}

/**
 * Build the request-header object from the configured auth header, with
 * `${ENV}` interpolation applied. Returns an empty object when no auth header
 * is configured or the interpolated value is empty.
 */
export function resolveAuthHeaders(config: TtsConfig, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (config.authHeader === undefined) return {};
  const value = interpolateEnv(config.authHeader.value, env);
  if (value.length === 0) return {};
  return { [config.authHeader.name]: value };
}

/**
 * Resolve the effective base URL for a specific voice: the voice's own
 * `baseUrl` (the instance hosting its checkpoint) when set, else the top-level
 * {@link resolveBaseUrl} fallback (which honors `PI_TTS_URL`). A voice-specific
 * URL is NOT overridden by `PI_TTS_URL` - the env override only swaps the
 * shared fallback. `${ENV}` interpolation + trailing-slash stripping apply.
 */
export function resolveVoiceBaseUrl(
  config: TtsConfig,
  voice: VoiceConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const own = voice?.baseUrl;
  if (own !== undefined && own.trim().length > 0) {
    return interpolateEnv(own, env).replace(/\/+$/, '');
  }
  return resolveBaseUrl(config, env);
}

/**
 * Resolve the auth headers for a specific voice: the voice's own `authHeader`
 * when set, else the top-level {@link resolveAuthHeaders} fallback. `${ENV}`
 * interpolation applies; an interpolated-empty value yields no header.
 */
export function resolveVoiceAuthHeaders(
  config: TtsConfig,
  voice: VoiceConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const header = voice?.authHeader;
  if (header === undefined) return resolveAuthHeaders(config, env);
  const value = interpolateEnv(header.value, env);
  if (value.length === 0) return {};
  return { [header.name]: value };
}

// ──────────────────────────────────────────────────────────────────────
// Voice pointer resolution + emote -> reference selection
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a voice pointer against the roster. A pointer of `clone:<key>` forces
 * the clone path (plan decision 6) even when the voice declares `kind: preset`;
 * a bare `<key>` uses the voice's declared kind. Returns `undefined` when the
 * pointer is empty or names a voice not in the roster.
 */
export function resolveVoice(config: TtsConfig, pointer: string | undefined): ResolvedVoice | undefined {
  if (pointer === undefined) return undefined;
  const trimmed = pointer.trim();
  if (trimmed.length === 0) return undefined;
  const forceClone = trimmed.toLowerCase().startsWith(CLONE_PREFIX);
  const name = forceClone ? trimmed.slice(CLONE_PREFIX.length).trim() : trimmed;
  if (name.length === 0) return undefined;
  // Exact key match first, then a case-insensitive fallback so `/tts voice
  // Exusiai` resolves `exusiai`. The canonical roster key is returned as `name`.
  let key: string | undefined = config.voices[name] !== undefined ? name : undefined;
  if (key === undefined) {
    const lower = name.toLowerCase();
    key = Object.keys(config.voices).find((k) => k.toLowerCase() === lower);
  }
  if (key === undefined) return undefined;
  const voice = config.voices[key];
  return { name: key, voice, kind: forceClone ? 'clone' : voice.kind };
}

/**
 * Pick the reference clip for an emote: the first `voice.emotes` bucket whose
 * `match` list contains the emote name (case-insensitive), else the voice's
 * default ref. Pure + emote-name tolerant (undefined / unknown -> default).
 * Returns `undefined` only when the voice has no usable default clip.
 */
export function pickReference(voice: VoiceConfig, emote: string | undefined): Reference | undefined {
  if (emote !== undefined && voice.emotes !== undefined) {
    const e = emote.toLowerCase();
    for (const bucket of voice.emotes) {
      if (bucket.match.some((m) => m.toLowerCase() === e)) {
        return { refAudio: bucket.refAudio, refText: bucket.refText };
      }
    }
  }
  if (voice.refAudio === undefined) return undefined;
  return { refAudio: voice.refAudio, refText: voice.refText ?? '' };
}

// ──────────────────────────────────────────────────────────────────────
// Disk wiring
// ──────────────────────────────────────────────────────────────────────

/**
 * Load the fully-resolved config for `cwd`, layering the shipped defaults
 * (lowest) under the user-global `<piAgentDir>/tts.json` and the project-local
 * `<cwd>/.pi/tts.json`. Each disk layer is read JSONC-tolerant and coerced;
 * a missing / malformed file contributes an empty layer.
 *
 * The project layer is the caller's responsibility to gate on
 * `ctx.isProjectTrusted()`: pass `includeProject: false` to skip it.
 */
export function loadTtsConfig(cwd: string, includeProject = true): TtsConfig {
  const userLayer = coerceConfigLayer(readJsoncOrUndefined(piAgentPath('tts.json')));
  const projectLayer = includeProject ? coerceConfigLayer(readJsoncOrUndefined(piProjectPath(cwd, 'tts.json'))) : {};
  return mergeConfigLayers(userLayer, projectLayer);
}
