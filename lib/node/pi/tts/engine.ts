/**
 * HTTP engine client for the `tts` extension.
 *
 * Drives one of two backends behind the config `api` switch:
 *
 *  - `openai` (primary): Qwen3-TTS on llama.cpp behind LiteLLM and the
 *    audio-proxy shim. One instance serves both voice kinds.
 *      * preset voice -> `POST {baseUrl}/audio/speech` with the standard
 *        OpenAI body `{ model, input, voice, response_format }`. `voice` is a
 *        server voice-library name or alias; the library entry fixes the
 *        timbre and language. Streaming uses `/audio/speech/stream` (a raw
 *        pass-through, so `stream_format: "audio"` survives LiteLLM).
 *      * clone voice -> `POST {baseUrl}/audio/voice-clone` with
 *        `{ model, input, speaker_ref_b64, speaker_ref_text?, lang?,
 *           response_format, stream_format? }`. Emotion = the emote-selected
 *        reference clip. The server picks the cloning mode: ICL when a
 *        transcript is present (once its mmproj supports it), else the speaker
 *        embedding.
 *  - `gpt-sovits` (legacy): the GPT-SoVITS `api_v2` server reached over GET
 *    (`/set_gpt_weights`, `/set_sovits_weights`, `/tts`), unchanged from the
 *    original `rp-tts.ts`.
 *
 * File mode writes the response bytes to a temp file whose path is returned;
 * stream mode ({@link synthesizeStream}) returns a buffered readable that the
 * shell pipes into a player. Any failure throws; the shell treats a throw as a
 * silent no-op (TTS is never load-bearing). The request carries a generous
 * `requestTimeoutMs` so a scale-from-zero cold start does not abort.
 *
 * Pure body/URL builders are exported separately so they can be unit-tested
 * without a network or filesystem. No pi imports.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import { pickReference, resolveVoiceBaseUrl, resolveVoiceAuthHeaders } from './config.ts';
import type { Reference, ResolvedVoice, TtsConfig, VoiceConfig } from './types.ts';

// ──────────────────────────────────────────────────────────────────────
// Language mapping (server `lang`: a code like "en" or a name like "english")
// ──────────────────────────────────────────────────────────────────────

const LANG_CODE_TO_NAME: Record<string, string> = {
  en: 'english',
  zh: 'chinese',
  ja: 'japanese',
  ko: 'korean',
  de: 'german',
  fr: 'french',
  es: 'spanish',
  ru: 'russian',
  pt: 'portuguese',
  it: 'italian',
};

const LANG_NAMES = new Set(Object.values(LANG_CODE_TO_NAME));

/**
 * Map a configured `promptLang` to the clone body's `lang` field. A known code
 * (`en`, `JA`) or name (`English`) passes through lowercased; anything else
 * (undefined, blank, `auto`, unknown) returns `undefined` so the field is
 * omitted and the server uses its default. llama.cpp rejects `auto` with a
 * 500, so it must never be sent.
 */
export function langForServer(promptLang: string | undefined): string | undefined {
  if (promptLang === undefined) return undefined;
  const lower = promptLang.trim().toLowerCase();
  if (LANG_CODE_TO_NAME[lower] !== undefined || LANG_NAMES.has(lower)) return lower;
  return undefined;
}

// ──────────────────────────────────────────────────────────────────────
// Pure request-body builders (openai engine)
// ──────────────────────────────────────────────────────────────────────

/** Named-voice route; the `/stream` pass-through keeps `stream_format` intact. */
export const SPEECH_PATH = '/audio/speech';
export const SPEECH_STREAM_PATH = '/audio/speech/stream';
/** Clone pass-through; streams when the body carries `stream_format: "audio"`. */
export const CLONE_PATH = '/audio/voice-clone';

export interface SpeechBody {
  model: string;
  input: string;
  voice: string;
  response_format: string;
  stream_format?: 'audio';
}

export interface CloneBody {
  model: string;
  input: string;
  speaker_ref_b64: string;
  speaker_ref_text?: string;
  lang?: string;
  response_format: string;
  stream_format?: 'audio';
}

/**
 * Build the speech JSON body for a preset (library) voice. The server voice is
 * the voice's `preset` field, falling back to the roster key. Only OpenAI
 * fields are sent (LiteLLM's model route drops everything else); `stream`
 * adds `stream_format: "audio"` for the `/audio/speech/stream` pass-through.
 */
export function buildSpeechBody(config: TtsConfig, resolved: ResolvedVoice, text: string, stream = false): SpeechBody {
  const body: SpeechBody = {
    model: config.model,
    input: text,
    voice: resolved.voice.preset ?? resolved.name,
    response_format: config.format,
  };
  if (stream) body.stream_format = 'audio';
  return body;
}

/**
 * Build the `/audio/voice-clone` JSON body for a clone voice. `refAudioB64` is
 * the base64 of the reference clip's raw file bytes (the caller reads it). The
 * transcript is sent whenever it is non-blank so ICL takes effect as soon as
 * the server supports it; `lang` is omitted when `promptLang` is unknown.
 */
export function buildCloneBody(
  config: TtsConfig,
  voice: VoiceConfig,
  ref: Reference,
  refAudioB64: string,
  text: string,
  stream = false,
): CloneBody {
  const body: CloneBody = {
    model: config.model,
    input: text,
    speaker_ref_b64: refAudioB64,
    response_format: config.format,
  };
  if (ref.refText.trim().length > 0) body.speaker_ref_text = ref.refText;
  const lang = langForServer(voice.promptLang);
  if (lang !== undefined) body.lang = lang;
  if (stream) body.stream_format = 'audio';
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
 *  400/404/500 is a real misconfig (e.g. an unsupported format or language)
 *  and is NOT retried - it fails fast so the reason surfaces immediately. */
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
    return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
  } catch {
    return '';
  }
}

/** A successful response whose body is still guarded by the request timeout. */
interface OpenResponse {
  res: Response;
  /** Abort the request (and its body). */
  abort: () => void;
  /** Disarm the request timeout once the body is fully consumed. */
  done: () => void;
}

/**
 * POST JSON and return the successful response, with a bounded retry on
 * transient failures (network error, or a {@link RETRY_STATUSES} HTTP status)
 * so a synth fired the instant a scale-to-zero instance is spinning up rides
 * out the cold start instead of silently dropping. Each attempt gets its own
 * `conn.timeoutMs` abort, which stays armed through the body read until the
 * caller calls `done()`; the request's own timeout is NOT retried (repeating a
 * 180s wait is pointless and the turn is long gone). A non-retryable status
 * (4xx / 500) fails fast. The thrown error carries the status + a body snippet
 * so the caller's debug log shows *why* it failed.
 */
async function postJson(conn: Conn, path: string, body: unknown): Promise<OpenResponse> {
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
      if (res.ok) {
        return { res, abort: () => ctl.abort(), done: () => clearTimeout(timer) };
      }
      const snippet = await errorSnippet(res);
      lastReason = `${path} -> ${res.status}${snippet ? `: ${snippet}` : ''}`;
      retryable = RETRY_STATUSES.has(res.status);
    } catch (e) {
      // Network error or our own timeout abort. Retry the former (transient,
      // e.g. a briefly-down port-forward) but not the latter.
      const timedOut = ctl.signal.aborted;
      lastReason = `${path} -> ${timedOut ? `timeout after ${conn.timeoutMs}ms` : e instanceof Error ? e.message : String(e)}`;
      retryable = !timedOut;
    }
    clearTimeout(timer);
    if (!retryable || attempt === MAX_TRIES) break;
    await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1)); // 500ms, 1000ms, ...
  }
  // oxlint-enable no-await-in-loop
  throw new Error(lastReason);
}

/** POST JSON and return the complete audio body (file mode). */
async function postForAudio(conn: Conn, path: string, body: unknown): Promise<ArrayBuffer> {
  const open = await postJson(conn, path, body);
  try {
    return await open.res.arrayBuffer();
  } catch (e) {
    throw new Error(`${path} -> body read failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  } finally {
    open.done();
  }
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

/** Path + body for one openai synth, shared by file and stream mode. */
function openaiRequest(
  config: TtsConfig,
  resolved: ResolvedVoice,
  text: string,
  emote: string | undefined,
  stream: boolean,
): { path: string; body: SpeechBody | CloneBody } {
  if (resolved.kind !== 'clone') {
    return { path: stream ? SPEECH_STREAM_PATH : SPEECH_PATH, body: buildSpeechBody(config, resolved, text, stream) };
  }
  const ref = pickReference(resolved.voice, emote);
  if (ref === undefined) throw new Error(`clone voice "${resolved.name}" has no reference clip`);
  const refAudioB64 = readFileSync(ref.refAudio).toString('base64');
  return { path: CLONE_PATH, body: buildCloneBody(config, resolved.voice, ref, refAudioB64, text, stream) };
}

/**
 * Buffer cap for a streamed cue that is prefetched while the previous one
 * plays. A 240-char chunk is about 1 MB of 24 kHz WAV, so this never applies
 * backpressure in practice; it only bounds a runaway response.
 */
const STREAM_BUFFER_BYTES = 32 * 1024 * 1024;

/** A streamed cue: audio bytes as they arrive, plus a cancel hook. */
export interface AudioStream {
  /** Audio bytes; ends when the server finishes, errors on abort / timeout. */
  readable: Readable;
  /** The library voice the server resolved (`x-tts-voice`), when reported. */
  serverVoice?: string;
  /** Abort the request and destroy the readable (barge-in / stale cue). */
  cancel: () => void;
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
// Public synth entry points
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
  const { path, body } = openaiRequest(config, resolved, text, emote, false);
  return writeTemp(await postForAudio(conn, path, body), config.format);
}

/**
 * Start a streamed synth (openai engine only) and resolve once the server has
 * answered with a success status. The body is read eagerly into a buffer, so
 * a cue prefetched while the previous one plays keeps downloading instead of
 * stalling the server on TCP backpressure. The request timeout stays armed
 * until the body ends. Throws on a failed request; a mid-stream failure
 * surfaces as an `error` on the readable.
 */
export async function synthesizeStream(
  config: TtsConfig,
  resolved: ResolvedVoice,
  text: string,
  emote: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AudioStream> {
  if (config.api !== 'openai') throw new Error(`streaming is not supported for api "${config.api}"`);
  const conn = connFor(config, resolved.voice, env);
  const { path, body } = openaiRequest(config, resolved, text, emote, true);
  const open = await postJson(conn, path, body);
  if (open.res.body === null) {
    open.done();
    throw new Error(`${path} -> empty body`);
  }
  const source = Readable.fromWeb(open.res.body as NodeWebReadableStream<Uint8Array>);
  const readable = new PassThrough({ highWaterMark: STREAM_BUFFER_BYTES });
  source.on('error', (e) => readable.destroy(e));
  source.on('close', open.done);
  source.pipe(readable);
  return {
    readable,
    serverVoice: open.res.headers.get('x-tts-voice') ?? undefined,
    cancel: () => {
      open.done();
      open.abort();
      source.destroy();
      readable.destroy();
    },
  };
}

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
  voice?: VoiceConfig,
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

/** One entry of the server voice library (`GET /audio/voices`). */
export interface LibraryVoice {
  id: string;
  lang?: string;
  hasTranscript?: boolean;
  aliases: string[];
}

/** The server voice library: its entries plus the fallback default. */
export interface VoiceLibrary {
  default?: string;
  voices: LibraryVoice[];
}

/**
 * Validate an untrusted `GET /audio/voices` payload
 * (`{ default, data: [{ id, lang, has_transcript, aliases }] }`). Entries
 * without a string `id` are dropped; returns undefined when `data` is not an
 * array (not a voice library response).
 */
export function parseVoiceLibrary(raw: unknown): VoiceLibrary | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { default: def, data } = raw as { default?: unknown; data?: unknown };
  if (!Array.isArray(data)) return undefined;
  const voices: LibraryVoice[] = [];
  for (const entry of data as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { id?: unknown; lang?: unknown; has_transcript?: unknown; aliases?: unknown };
    if (typeof e.id !== 'string' || e.id.length === 0) continue;
    const voice: LibraryVoice = {
      id: e.id,
      aliases: Array.isArray(e.aliases) ? e.aliases.filter((a): a is string => typeof a === 'string') : [],
    };
    if (typeof e.lang === 'string') voice.lang = e.lang;
    if (typeof e.has_transcript === 'boolean') voice.hasTranscript = e.has_transcript;
    voices.push(voice);
  }
  return typeof def === 'string' && def.length > 0 ? { default: def, voices } : { voices };
}

/**
 * Fetch the server voice library for `/tts status` (short fixed timeout, like
 * {@link probeReachable}). Returns undefined when the endpoint is unreachable,
 * non-2xx, or shaped unexpectedly, so the caller simply skips the listing.
 */
export async function probeVoices(
  config: TtsConfig,
  voice?: VoiceConfig,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 3000,
): Promise<VoiceLibrary | undefined> {
  const base = resolveVoiceBaseUrl(config, voice, env);
  const headers = resolveVoiceAuthHeaders(config, voice, env);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/audio/voices`, { headers, signal: ctl.signal });
    if (!res.ok) return undefined;
    return parseVoiceLibrary(await res.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
