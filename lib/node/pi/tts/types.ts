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
 * A named voice in the roster. Either a `preset` (server-registered voice
 * driven via /v1/audio/speech, emotion = an instruct string) or a `clone`
 * (driven via /v1/audio/voice-clone with a reference clip, emotion = the
 * emote-selected clip). `kind` is explicit for clarity; the `clone:` pointer
 * prefix can force the clone path regardless. gpt-sovits weight fields are
 * carried for the legacy engine behind the `api` switch.
 */
export interface VoiceConfig {
  kind: 'preset' | 'clone';
  /** Preset voice name on the server (preset kind, /v1/audio/speech `voice`). */
  preset?: string;
  /** Optional fixed instruct string applied to a preset voice (emotion for presets). */
  instruct?: string;
  /** Default reference clip (clone kind). */
  refAudio?: string;
  refText?: string;
  /** Language hint for the reference text / synthesis (defaults applied by the engine). */
  promptLang?: string;
  /** Optional mood -> reference-clip map; the avatar emote picks the clip. */
  emotes?: EmoteRef[];
  /**
   * Optional per-voice server override - the instance that actually hosts this
   * voice's checkpoint (e.g. a Base instance for a clone, a standard instance
   * for presets). Falls back to the top-level {@link TtsConfig.baseUrl} when
   * unset. `${ENV}` interpolation applies. Not overridden by `PI_TTS_URL`
   * (that only overrides the top-level fallback).
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

/**
 * Fully-resolved extension config (shipped defaults + user + project layers).
 */
export interface TtsConfig {
  /** TTS server origin, e.g. `http://127.0.0.1:8880/v1`. Trailing slash stripped on resolve. */
  baseUrl: string;
  /** Which engine the shell drives. `openai` is primary; `gpt-sovits` is legacy. */
  api: 'openai' | 'gpt-sovits';
  /** Optional auth header sent on every request; value supports `${ENV}`. */
  authHeader?: AuthHeader;
  /** Audio container requested from the server (e.g. `wav`). */
  format: string;
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
