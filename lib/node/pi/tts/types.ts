/**
 * Shared types for the `tts` extension's pure helpers.
 *
 * Kept in one module so `config.ts`, `text.ts`, and `engine.ts` agree on the
 * config / voice shapes without a circular import. No pi imports - everything
 * here is plain data validated out of untrusted JSON (mirrors the comfyui
 * extension's `types.ts`).
 */

/** A single request header injected on every TTS server call. Value supports `${ENV}`. */
export interface AuthHeader {
  name: string;
  value: string;
}

/**
 * An emotion -> reference-clip bucket for a clone voice. The avatar emote bus
 * names a mood; the first bucket whose `match` list contains that mood
 * (case-insensitive) selects the reference clip used for synthesis. Clones get
 * their emotion entirely from the chosen clip (no instruct).
 */
export interface EmoteRef {
  /** Avatar emote names (case-insensitive) that select this reference clip. */
  match: string[];
  refAudio: string;
  refText: string;
}

/**
 * A named voice in the roster. Either a `preset` (a server voice-library name
 * or alias driven via /v1/audio/speech; the library entry fixes the timbre and
 * language) or a `clone` (driven via /v1/audio/voice-clone with a client-side
 * reference clip, emotion = the emote-selected clip). `kind` is explicit for
 * clarity; the `clone:` pointer prefix can force the clone path regardless.
 * gpt-sovits weight fields are carried for the legacy engine behind the `api`
 * switch.
 */
export interface VoiceConfig {
  kind: 'preset' | 'clone';
  /** Server voice-library name or alias (preset kind, /v1/audio/speech `voice`). */
  preset?: string;
  /** Default reference clip (clone kind). */
  refAudio?: string;
  refText?: string;
  /**
   * Language of the reference clip / synthesis for clone voices, sent as
   * `lang` (a code such as `en` or a name such as `english`). Unused for
   * preset voices: the server library entry sets their language.
   */
  promptLang?: string;
  /** Optional mood -> reference-clip map; the avatar emote picks the clip. */
  emotes?: EmoteRef[];
  /**
   * Optional per-voice server override. One llama.cpp instance serves both
   * clone and preset voices, so this is rarely needed; it remains for pointing
   * a voice at a different server. Falls back to the top-level
   * {@link TtsConfig.baseUrl} when unset. `${ENV}` interpolation applies. Not
   * overridden by `PI_TTS_URL` (that only overrides the top-level fallback).
   */
  baseUrl?: string;
  /**
   * Optional per-voice auth header override (a second instance may use a
   * different token). Falls back to the top-level {@link TtsConfig.authHeader}
   * when unset. `${ENV}` interpolation applies to the value.
   */
  authHeader?: AuthHeader;
  /** gpt-sovits engine weights (legacy `api: "gpt-sovits"` path only). */
  gptWeights?: string;
  sovitsWeights?: string;
}

/** Output formats the openai (llama.cpp + audio-proxy) engine accepts. `wav` is the lowest-latency default. */
export const OPENAI_FORMATS = ['wav', 'pcm', 'mp3', 'opus', 'aac', 'flac'] as const;

/**
 * Fully-resolved extension config (shipped defaults + user + project layers).
 */
export interface TtsConfig {
  /** TTS server origin, e.g. `http://127.0.0.1:4000/v1`. Trailing slash stripped on resolve. */
  baseUrl: string;
  /**
   * Which engine the shell drives. `openai` is the llama.cpp Qwen3-TTS backend
   * behind LiteLLM (OpenAI speech route plus the voice-clone pass-through);
   * `gpt-sovits` is legacy.
   */
  api: 'openai' | 'gpt-sovits';
  /** Optional auth header sent on every request; value supports `${ENV}`. */
  authHeader?: AuthHeader;
  /**
   * Audio container requested from the server. For the `openai` engine this is
   * one of {@link OPENAI_FORMATS} (anything else falls back to `wav`); the
   * legacy `gpt-sovits` engine passes it through as `media_type`.
   */
  format: string;
  /**
   * When `true`, the openai engine streams each cue (`stream_format: "audio"`)
   * and pipes the audio into {@link TtsConfig.streamPlayer}'s stdin, so
   * playback starts before synthesis finishes. Default `false` (file mode:
   * synthesize to a temp file, then run {@link TtsConfig.player} on it).
   */
  stream: boolean;
  /** Player argv for stream mode; must read audio from stdin (e.g. ffplay `-i -`). */
  streamPlayer: string[];
  /** Hard cap on a single synth request before it is aborted (ms). Generous for cold start. */
  requestTimeoutMs: number;
  /** Audio player binary, spawned detached on the resulting file (e.g. `paplay`). */
  player: string;
  /**
   * Chunking threshold for prose, applied per speaker/narrator run. `> 0` =
   * max characters per chunk; `0` = split by paragraph only; `< 0` = no split
   * (one chunk per run). The speaker/narrator split is independent of this.
   */
  maxChunkChars: number;
  /** Safety cap on how many narration chunks a single reply may produce. */
  maxNarrationChunks: number;
  /**
   * When `true`, dialogue and narration are kept in separate cues even when
   * `rpVoice` === `narrationVoice`, so each gets its own reference clip
   * (emote-selected for dialogue, neutral for narration). When `false`
   * (default) consecutive same-voice segments merge into one run for natural
   * prosody. Useful when the synth endpoint can't tell speaker from narrator.
   */
  splitSpeakerNarration: boolean;
  /** Model id sent to the server (openai engine `model` field). */
  model: string;
  /** A roster of named voices (preset or clone). */
  voices: Record<string, VoiceConfig>;
  /** RP-mode voice pointer: a `voices` key or a `clone:<key>` alias. */
  rpVoice: string;
  /** Narration-mode voice pointer: a `voices` key or a `clone:<key>` alias. */
  narrationVoice: string;
}

/**
 * A voice pointer resolved against the roster. `kind` is the effective path to
 * take: the voice's declared `kind`, unless the pointer used the `clone:`
 * prefix, which forces `clone`.
 */
export interface ResolvedVoice {
  /** The roster key (pointer prefix stripped). */
  name: string;
  /** The voice definition from the roster. */
  voice: VoiceConfig;
  /** Effective synthesis path: forced to `clone` when the pointer used `clone:`. */
  kind: 'preset' | 'clone';
}

/** A reference clip (audio + its transcript) chosen for a clone synthesis. */
export interface Reference {
  refAudio: string;
  refText: string;
}
