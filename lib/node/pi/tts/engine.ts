/**
 * HTTP engine client for the `tts` extension.
 *
 * Drives one of two backends behind the config `api` switch:
 *
 *  - `openai` (primary): the qwen3-tts OpenAI-compatible server.
 *      * preset voice -> `POST {baseUrl}/audio/speech` with
 *        `{ model, input, voice, response_format, language, instruct? }`.
 *        Emotion for presets = the `instruct` string.
 *      * clone voice -> `POST {baseUrl}/audio/voice-clone` with
 *        `{ input, ref_audio (base64), ref_text?, x_vector_only_mode,
 *           language, response_format }`. Emotion = the emote-selected
 *        reference clip (no instruct). ICL mode (better quality) needs a
 *        `ref_text`; without one we fall back to x-vector-only mode.
 *  - `gpt-sovits` (legacy): the GPT-SoVITS `api_v2` server reached over GET
 *    (`/set_gpt_weights`, `/set_sovits_weights`, `/tts`), unchanged from the
 *    original `rp-tts.ts`.
 *
 * Both server responses are raw audio bytes, written to a temp file whose path
 * is returned. Any failure throws; the shell treats a throw as a silent no-op
 * (TTS is never load-bearing). The request carries a generous
 * `requestTimeoutMs` so a scale-from-zero cold start does not abort.
 *
 * Pure body/URL builders are exported separately so they can be unit-tested
 * without a network or filesystem. No pi imports.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { pickReference, resolveVoiceBaseUrl, resolveVoiceAuthHeaders } from './config.ts';
import type { Reference, ResolvedVoice, TtsConfig, VoiceConfig } from './types.ts';

// ──────────────────────────────────────────────────────────────────────
// Language mapping (server wants a name like "English" or "Auto", not a code)
// ──────────────────────────────────────────────────────────────────────

const LANG_CODE_TO_NAME: Record<string, string> = {
  en: 'English',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  ru: 'Russian',
  pt: 'Portuguese',
  it: 'Italian',
};

const LANG_NAMES = new Set(Object.values(LANG_CODE_TO_NAME).map((n) => n.toLowerCase()));

/**
 * Map a configured `promptLang` to the server's `language` field. A bare code
 * (`en`) maps to its name (`English`); an already-spelled name passes through;
 * anything unknown (or undefined) becomes `"Auto"` so the server auto-detects.
 */
export function languageForServer(promptLang: string | undefined): string {
  if (promptLang === undefined) return 'Auto';
  const trimmed = promptLang.trim();
  if (trimmed.length === 0) return 'Auto';
  const lower = trimmed.toLowerCase();
  if (lower === 'auto') return 'Auto';
  if (LANG_CODE_TO_NAME[lower] !== undefined) return LANG_CODE_TO_NAME[lower];
  if (LANG_NAMES.has(lower)) return trimmed;
  return 'Auto';
}

// ──────────────────────────────────────────────────────────────────────
// Pure request-body builders (openai engine)
// ──────────────────────────────────────────────────────────────────────

export interface SpeechBody {
  model: string;
  input: string;
  voice: string;
  response_format: string;
  language: string;
  instruct?: string;
}

export interface CloneBody {
  input: string;
  ref_audio: string;
  ref_text?: string;
  x_vector_only_mode: boolean;
  language: string;
  response_format: string;
}

/**
 * Build the `/audio/speech` JSON body for a preset voice. The server voice id
 * is the voice's `preset` field, falling back to the roster key. A configured
 * `instruct` carries the emotion/style; omitted when unset.
 */
export function buildSpeechBody(config: TtsConfig, resolved: ResolvedVoice, text: string): SpeechBody {
  const body: SpeechBody = {
    model: config.model,
    input: text,
    voice: resolved.voice.preset ?? resolved.name,
    response_format: config.format,
    language: languageForServer(resolved.voice.promptLang),
  };
  if (resolved.voice.instruct !== undefined && resolved.voice.instruct.length > 0) {
    body.instruct = resolved.voice.instruct;
  }
  return body;
}

/**
 * Build the `/audio/voice-clone` JSON body for a clone voice. `refAudioB64` is
 * the base64 of the reference clip's raw file bytes (the caller reads it). When
 * a `ref_text` transcript is present we use ICL mode (`x_vector_only_mode:
 * false`, higher quality); without one we fall back to x-vector-only mode so
 * the server does not reject the request.
 */
export function buildCloneBody(
  config: TtsConfig,
  voice: VoiceConfig,
  ref: Reference,
  refAudioB64: string,
  text: string,
): CloneBody {
  const hasRefText = ref.refText.trim().length > 0;
  const body: CloneBody = {
    input: text,
    ref_audio: refAudioB64,
    x_vector_only_mode: !hasRefText,
    language: languageForServer(voice.promptLang),
    response_format: config.format,
  };
  if (hasRefText) body.ref_text = ref.refText;
  return body;
}

// ──────────────────────────────────────────────────────────────────────
// HTTP plumbing
// ──────────────────────────────────────────────────────────────────────

interface Conn {
  base: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

function connFor(config: TtsConfig, voice: VoiceConfig | undefined, env: NodeJS.ProcessEnv = process.env): Conn {
  return {
    base: resolveVoiceBaseUrl(config, voice, env),
    headers: resolveVoiceAuthHeaders(config, voice, env),
    timeoutMs: config.requestTimeoutMs,
  };
}

/** Write raw audio bytes to a fresh temp file and return its path. */
function writeTemp(bytes: ArrayBuffer, format: string): string {
  const file = join(tmpdir(), `tts-${Date.now()}-${randomUUID().slice(0, 8)}.${format}`);
  writeFileSync(file, Buffer.from(bytes));
  return file;
}

/** Transient HTTP statuses worth retrying (scale-up / rate-limit / gateway). A
 *  400/404/500 is a real misconfig (e.g. preset voice on a Base model) and is
 *  NOT retried - it fails fast so the reason surfaces immediately. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_TRIES = 3;
const BASE_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a short, single-line snippet of an error response body for diagnostics. */
async function errorSnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 200 ? `${flat.slice(0, 200)}\u2026` : flat;
  } catch {
    return '';
  }
}

/**
 * POST JSON and return raw audio bytes, with a bounded retry on transient
 * failures (network error, or a {@link RETRY_STATUSES} HTTP status) so a synth
 * fired the instant a scale-to-zero instance is spinning up rides out the
 * cold start instead of silently dropping. Each attempt gets its own
 * `conn.timeoutMs` abort; the request's own timeout is NOT retried (repeating a
 * 180s wait is pointless and the turn is long gone). A non-retryable status
 * (4xx / 500) fails fast. The thrown error carries the status + a body snippet
 * so the caller's debug log shows *why* it failed.
 */
async function postForAudio(conn: Conn, path: string, body: unknown): Promise<ArrayBuffer> {
  let lastReason = `${path} failed`;
  // oxlint-disable no-await-in-loop -- retry loop: each attempt awaits the previous (backoff is sequential by design)
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), conn.timeoutMs);
    let retryable = false;
    try {
      const res = await fetch(`${conn.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...conn.headers },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (res.ok) return await res.arrayBuffer();
      const snippet = await errorSnippet(res);
      lastReason = `${path} -> ${res.status}${snippet ? `: ${snippet}` : ''}`;
      retryable = RETRY_STATUSES.has(res.status);
    } catch (e) {
      // Network error or our own timeout abort. Retry the former (transient,
      // e.g. a briefly-down port-forward) but not the latter.
      const timedOut = ctl.signal.aborted;
      lastReason = `${path} -> ${timedOut ? `timeout after ${conn.timeoutMs}ms` : e instanceof Error ? e.message : String(e)}`;
      retryable = !timedOut;
    } finally {
      clearTimeout(timer);
    }
    if (!retryable || attempt === MAX_TRIES) break;
    await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1)); // 500ms, 1000ms, ...
  }
  // oxlint-enable no-await-in-loop
  throw new Error(lastReason);
}

/** GET with auth headers + timeout (gpt-sovits legacy uses GET endpoints). */
async function getRequest(conn: Conn, url: string): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), conn.timeoutMs);
  try {
    return await fetch(url, { headers: conn.headers, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────────────────────────────
// openai engine paths
// ──────────────────────────────────────────────────────────────────────

async function synthPreset(config: TtsConfig, conn: Conn, resolved: ResolvedVoice, text: string): Promise<string> {
  const body = buildSpeechBody(config, resolved, text);
  const bytes = await postForAudio(conn, '/audio/speech', body);
  return writeTemp(bytes, config.format);
}

async function synthClone(
  config: TtsConfig,
  conn: Conn,
  resolved: ResolvedVoice,
  text: string,
  emote: string | undefined,
): Promise<string> {
  const ref = pickReference(resolved.voice, emote);
  if (ref === undefined) throw new Error(`clone voice "${resolved.name}" has no reference clip`);
  const refAudioB64 = readFileSync(ref.refAudio).toString('base64');
  const body = buildCloneBody(config, resolved.voice, ref, refAudioB64, text);
  const bytes = await postForAudio(conn, '/audio/voice-clone', body);
  return writeTemp(bytes, config.format);
}

// ──────────────────────────────────────────────────────────────────────
// gpt-sovits legacy path (GET-based, ported from rp-tts.ts)
// ──────────────────────────────────────────────────────────────────────

/**
 * Point the gpt-sovits server at this voice's weights (lazy; the shell calls
 * this once per voice change). No-op when the voice declares no weights.
 */
export async function setGptSovitsWeights(
  config: TtsConfig,
  voice: VoiceConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const conn = connFor(config, voice, env);
  const setOne = async (path: string, value?: string): Promise<void> => {
    if (value === undefined) return;
    const url = `${conn.base}${path}?${new URLSearchParams({ weights_path: value }).toString()}`;
    const res = await getRequest(conn, url);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  };
  await setOne('/set_gpt_weights', voice.gptWeights);
  await setOne('/set_sovits_weights', voice.sovitsWeights);
}

async function synthGptSovits(
  config: TtsConfig,
  conn: Conn,
  resolved: ResolvedVoice,
  text: string,
  emote: string | undefined,
): Promise<string> {
  const ref = pickReference(resolved.voice, emote);
  if (ref === undefined) throw new Error(`gpt-sovits voice "${resolved.name}" has no reference clip`);
  const params = new URLSearchParams({
    text,
    text_lang: resolved.voice.promptLang ?? 'en',
    ref_audio_path: ref.refAudio,
    prompt_text: ref.refText,
    prompt_lang: resolved.voice.promptLang ?? 'en',
    media_type: config.format,
  });
  const res = await getRequest(conn, `${conn.base}/tts?${params.toString()}`);
  if (!res.ok) throw new Error(`/tts -> ${res.status}`);
  return writeTemp(await res.arrayBuffer(), config.format);
}

// ──────────────────────────────────────────────────────────────────────
// Public synth entry point
// ──────────────────────────────────────────────────────────────────────

/**
 * Synthesize `text` in the resolved voice and return a temp file path. Picks
 * the engine path from `config.api` and (for openai) the voice's effective
 * `kind`. `emote` selects the clone reference clip; ignored for presets. Reads
 * the reference clip from disk for clone synthesis. Throws on any failure.
 */
export async function synthesize(
  config: TtsConfig,
  resolved: ResolvedVoice,
  text: string,
  emote: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const conn = connFor(config, resolved.voice, env);
  if (config.api === 'gpt-sovits') {
    return synthGptSovits(config, conn, resolved, text, emote);
  }
  // openai engine: clone vs preset by effective kind.
  return resolved.kind === 'clone'
    ? synthClone(config, conn, resolved, text, emote)
    : synthPreset(config, conn, resolved, text);
}

/**
/** Outcome of a reachability probe. */
export interface ProbeResult {
  /** HTTP status when the server answered (any code), else undefined. */
  status?: number;
  /** True when the probe aborted on its own timeout (server slow / cold-starting). */
  timedOut: boolean;
}

/**
 * Best-effort reachability probe for `/tts status`. GETs `{baseUrl}/models`
 * (the OpenAI-style model list) and reports the outcome. When a `voice` is
 * given its per-voice endpoint (URL + auth) is probed, else the top-level
 * fallback. Uses a short fixed timeout, not `requestTimeoutMs`, so a status
 * check never hangs for minutes behind a cold start - and distinguishes a
 * timeout (likely a cold-starting / loading instance, which synth's 180s
 * timeout would still ride out) from a connection refusal (server down).
 */
export async function probeReachable(
  config: TtsConfig,
  voice?: VoiceConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 3000,
): Promise<ProbeResult> {
  const base = resolveVoiceBaseUrl(config, voice, env);
  const headers = resolveVoiceAuthHeaders(config, voice, env);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/models`, { headers, signal: ctl.signal });
    return { status: res.status, timedOut: false };
  } catch {
    return { status: undefined, timedOut: ctl.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

/** Clone/preset capability of a server instance, from `/audio/voice-clone/capabilities`. */
export interface CloneCapabilities {
  /** True when the instance can clone (Base model); false on CustomVoice. */
  cloneSupported?: boolean;
  /** Reported model type, e.g. "base" or "customvoice". */
  modelType?: string;
}

/**
 * Probe a server instance's clone/preset capability so `/tts status` can warn
 * about a voice/instance mismatch *before* it silently 500s at synth time: a
 * `preset` voice on a Base model, or a `clone` voice on a CustomVoice model.
 * Returns undefined when the endpoint is unreachable or shaped unexpectedly
 * (so the caller simply skips the hint rather than guessing).
 */
export async function probeCapabilities(
  config: TtsConfig,
  voice?: VoiceConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 3000,
): Promise<CloneCapabilities | undefined> {
  const base = resolveVoiceBaseUrl(config, voice, env);
  const headers = resolveVoiceAuthHeaders(config, voice, env);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/audio/voice-clone/capabilities`, { headers, signal: ctl.signal });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { supported?: unknown; model_type?: unknown };
    return {
      cloneSupported: typeof j.supported === 'boolean' ? j.supported : undefined,
      modelType: typeof j.model_type === 'string' ? j.model_type : undefined,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
