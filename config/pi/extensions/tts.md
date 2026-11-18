# tts - two-mode TTS narration for pi

Speaks finalized assistant output aloud after each turn, without blocking the turn. The extension is a thin pi shell
(`tts.ts`) over pure, unit-tested modules under `lib/node/pi/tts/` (`config.ts`, `text.ts`, `engine.ts`, `status.ts`,
`wav.ts`, plus `types.ts`).

It drives Qwen3-TTS (1.7B Base) on stock `llama-server`, reached through LiteLLM and an `audio-proxy` shim that adds a
server-side voice library, ffmpeg transcoding, and `speed` (see [Server](#server-llamacpp-via-litellm)). It is **never
load-bearing**: any failure (server down, no audio player, synth error) degrades to a silent no-op and the turn always
completes.

## Two modes

| Mode          | Gate                                                                    | Speaks                   | Voice                                                         |
| ------------- | ----------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| **RP**        | `PI_RP_TTS=1` (or `/tts on`) **and** an active `roleplay: true` persona | quoted `"dialogue"` only | `rpVoice` (a clone voice with emote-selected reference clips) |
| **Narration** | `PI_TTS_NARRATE=1` (or `/tts narrate on`) in a **non-RP** session       | assistant prose, chunked | `narrationVoice` (typically a library preset voice)           |

RP **wins** when both gates are active **and narration is off**, in which case RP speaks quoted dialogue only - a single
synth request per turn. When **both** RP and narration are enabled in a roleplay session, the reply is spoken as
**narrated roleplay** (see below): quoted dialogue in `rpVoice` and the surrounding prose in `narrationVoice`,
interleaved in reading order. Narration runs prose through a chunk/queue pipeline (synth chunk N+1 while chunk N plays);
RP-only is the degenerate single-chunk case of the same pipeline.

Both modes share one player handle, one OOC pause flag, and barge-in: a new turn (or new user input) cancels the
in-flight playback and any queued synths.

### Narrated roleplay (RP + narration together)

With **both** `PI_RP_TTS` and `PI_TTS_NARRATE` on in a roleplay session, the reply is segmented in reading order: each
double-quoted span becomes a `dialogue` cue (spoken in `rpVoice`, the clone, carrying the turn's emote) and the prose
between/around quotes becomes a `narration` cue (spoken in `narrationVoice`, typically a preset). Cues stream through
the same queue pipeline so the clone and narrator voices interleave. If no narration voice resolves, narration cues are
skipped and it degrades to dialogue-only. Long spans are chunked and the total is capped at `maxNarrationChunks`.

When `rpVoice` and `narrationVoice` are the **same** voice, consecutive same-voice segments are coalesced into one run,
so the whole reply is spoken as continuous prose (one synth call per chunk, natural prosody across quote boundaries)
instead of a separate request per segment. The turn's emote applies to any run that contains dialogue.

### OOC pause / resume

An `[OOC: PAUSE]` marker in any message stops narration until `[OOC: RESUME]`. Resume wins if both appear. `[OOC: ...]`
blocks are also stripped from spoken text so meta-asides are never read aloud.

## Environment variables

| Var                   | Effect                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `PI_TTS_DISABLED=1`   | skip the whole extension (no event wiring, no `/tts` command)                                                   |
| `PI_RP_TTS=1`         | enable RP dialogue narration (same as `/tts on`)                                                                |
| `PI_TTS_NARRATE=1`    | enable agent-output narration (same as `/tts narrate on`)                                                       |
| `PI_TTS_URL=...`      | override the configured top-level `baseUrl` (only swaps the shared fallback URL, not a voice that pins its own) |
| `PI_TTS_TRACE=<path>` | append one diagnostic line per relevant event to the file at `<path>` (see Debugging)                           |

## `/tts` command

| Subcommand                             | Action                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `/tts on` / `/tts off`                 | toggle RP narration                                                       |
| `/tts narrate on` / `/tts narrate off` | toggle agent-output narration                                             |
| `/tts voice <name>`                    | override the RP voice for this session                                    |
| `/tts narration-voice <name>`          | override the narration voice for this session                             |
| `/tts say <text>`                      | synth + play literal text now, bypassing all gating (engine smoke test)   |
| `/tts status`                          | show mode/persona/engine + probe the resolved rp + narration voices       |
| `/tts status <name>`                   | show + probe one configured voice's endpoint, URL source, and auth source |

Voice names autocomplete from the configured roster.

`/tts status` reports each voice's URL and reachability, distinguishing:

- `reachable (200)` - server answered.
- `no response yet (starting / cold?)` - probe timed out; the instance is likely cold-starting / loading a model
  (synth's long timeout would still ride it out).
- `UNREACHABLE` - connection refused; the server is down.

It also lists the server voice library (`GET /audio/voices`: ids, language, aliases, the default) and warns about:

- a `preset` voice whose name is neither a library id nor an alias (the server silently uses its default voice);
- a clone reference clip (default or emote) that the client cannot read (every clone synth would fail);
- a WAV reference clip longer than 30 s (ICL will fall back to the speaker embedding). Non-WAV clips are not measured.

## Configuration

JSONC config, layered lowest to highest:

1. shipped defaults
2. `<piAgentDir>/tts.json` (global layer)
3. `<cwd>/.pi/tts.json` (project layer; applied **only when the project is trusted**)

`PI_TTS_URL` overrides the resolved top-level `baseUrl`. See [`../tts-example.json`](../tts-example.json) for a complete
starting config (LiteLLM endpoint with auth, clone + library voice, emotes).

### Top-level keys

| Key                     | Meaning                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `baseUrl`               | fallback server URL (include the `/v1` suffix). A voice without its own `baseUrl` inherits this.            |
| `api`                   | engine preset: `openai` (llama.cpp via LiteLLM) or the legacy `gpt-sovits` GET path.                        |
| `model`                 | model name sent in every body (default `tts`; `qwen3-tts` is a server alias).                               |
| `format`                | `wav` (default, lowest latency), `pcm`, `mp3`, `opus`, `aac`, or `flac`; anything else falls back to `wav`. |
| `player`                | file-mode playback command, run as `<player> <file>` (e.g. `paplay`, `afplay`).                             |
| `stream`                | `true` = stream each cue into `streamPlayer` (playback starts in about 2 s). Default `false`.               |
| `streamPlayer`          | argv for stream mode; must read audio from stdin. Default `ffplay -nodisp -autoexit -loglevel error -i -`.  |
| `requestTimeoutMs`      | synth request timeout. Keep generous (e.g. `180000`) to survive a scale-from-zero cold start.               |
| `maxChunkChars`         | chunk size per speaker/narrator run: `>0` = max chars/chunk, `0` = split by paragraph, `<0` = no split.     |
| `maxNarrationChunks`    | cap on chunks spoken per turn (the overall audio-segment ceiling).                                          |
| `splitSpeakerNarration` | keep dialogue and narration in separate cues even when `rpVoice` == `narrationVoice` (default `false`).     |
| `authHeader`            | optional `{ "name": ..., "value": ... }`; `value` supports `${ENV}` interpolation.                          |
| `voices`                | the voice roster (below).                                                                                   |
| `rpVoice`               | roster name used in RP mode.                                                                                |
| `narrationVoice`        | roster name used in narration mode.                                                                         |

### Voice entries

```jsonc
"voices": {
  "exusiai": {
    "kind": "clone",                       // "clone" or "preset"
    "promptLang": "en",                    // sent as `lang` (code or name); unknown values are omitted
    "refAudio": "/abs/path/on/THIS/machine.wav", // read client-side, base64'd; keep it <= 30 s
    "refText": "transcript of the reference clip", // sent as speaker_ref_text (ICL, once live)
    "emotes": [                            // optional emote-keyed reference clips
      { "match": ["excited", "cheer"], "refAudio": "...", "refText": "..." }
    ]
  },
  "narrator": {
    "kind": "preset",
    "preset": "alloy"                      // a server library name or alias
  }
}
```

- `preset` names a server voice-library entry or alias (see `/tts status`); an unknown name falls back to the library
  default. The library entry sets the language, so `promptLang` is unused for presets.
- A voice may still override `baseUrl` and/or `authHeader` (e.g. to point at another server); the endpoint travels with
  the voice. One instance serves both kinds, so this is rarely needed. `PI_TTS_URL` only swaps the shared fallback,
  never a pinned voice.
- Voice names resolve case-insensitively (exact match first, then lowercase).
- `clone:Name` as an `rpVoice` / `narrationVoice` value forces clone treatment.
- `refAudio` is read on the client and base64-encoded, so it must be a path on **this** machine, not the server's
  filesystem. A relative path resolves against the project root for a project file (`<cwd>/`) and against the global
  config's directory for the global file (`<piAgentDir>/`); a leading `~` / `~/` expands to your home directory.
  (Resolution applies to the `openai` clone path; `gpt-sovits` ref paths are sent to the server as-is.)
- Emotes: the avatar bus emote for the turn selects a matching reference clip; the first `match` array containing the
  emote wins, else the voice's default `refAudio` is used.

## Server (llama.cpp via LiteLLM)

All requests go to one LiteLLM base URL (e.g. `https://llm.<domain>/v1`) with an `Authorization: Bearer <key>` header
from `authHeader`. Bodies are JSON.

| Voice / mode   | Route                          | Body                                                                                    |
| -------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| preset, file   | `POST /audio/speech`           | `{ model, input, voice, response_format }`                                              |
| preset, stream | `POST /audio/speech/stream`    | same plus `stream_format: "audio"` (raw pass-through; the model route drops that field) |
| clone          | `POST /audio/voice-clone`      | `{ model, input, speaker_ref_b64, speaker_ref_text?, lang?, response_format }`          |
| clone, stream  | `POST /audio/voice-clone`      | same plus `stream_format: "audio"`                                                      |
| status         | `GET /models`, `/audio/voices` | reachability probe and the voice library                                                |

- The CustomVoice preset speakers (`ryan`, `vivian`, `serena`, ...) are gone: llama.cpp only runs the Base model.
  Presets are now entries in the server's voice library (a clip plus transcript each), with OpenAI names such as `alloy`
  aliased server-side. To bring back a voice, record or generate a reference clip and add it to the library.
- The server picks the clone mode: with `speaker_ref_text` it uses ICL (prosody carried from the reference), without it
  the speaker embedding. ICL needs a clip of 30 s or less and an updated server mmproj; until then the transcript is
  accepted and ignored, so keep `refText` accurate now and it takes effect without client changes.
- `mp3`, `opus` (Ogg Opus), `aac`, and `flac` are encoded by the shim, also when streaming. Streamed WAV carries an
  unknown (`0xFFFFFFFF`) data size, which ffmpeg-based players handle.
- The backend scales to zero: the first request after idle can take about 60 s, hence `requestTimeoutMs: 180000`.

### Streaming playback

With `stream: true` each cue's response is piped into `streamPlayer` as it arrives, so playback starts after the first
audio bytes (about 2 s warm) rather than after the whole clip. The pipeline is unchanged: the next cue's request starts
while the current one plays and its audio is buffered in memory until its turn. Barge-in kills the player and aborts the
in-flight requests. `streamPlayer` must read from stdin; `afplay` and `paplay` cannot, while `ffplay` and `mpv -` can.

## Resilience

- **Cold start:** `requestTimeoutMs` is generous, so a synth fired while a scale-to-zero instance is spinning up waits
  rather than failing.
- **Bounded retry:** transient failures (network error, or HTTP `429/502/503/504`) are retried up to 3 times with 500 ms
  -> 1 s backoff. A non-retryable status (`4xx` / `500`, e.g. an unsupported format) fails fast. The request's own
  timeout is not retried.
- **Visible failures:** a failed synth carries the HTTP status plus a truncated response-body snippet, surfaced in the
  `PI_TTS_TRACE` trace.

## Debugging

Set `PI_TTS_TRACE=<path>` (e.g. `PI_TTS_TRACE=/tmp/tts-trace.log`) and the extension appends one `[tts] ...` line per
relevant event to that file:

- `message_end role=... rpEnabled=... narrate=... roleplay=... paused=...` - the gate state for the turn.
- `RP branch: dialogueLen=... sample="..."` - whether `extractDialogue` found quoted text.
- `RP branch: resolved=exusiai/clone` - voice resolution.
- `RP branch: speaking gen=... emote=...` - reached playback.
- `playSeq cue i/n voice=... synth=file|stream|NULL stale=... paused=...` and `playSeq playing cue i via <player>` -
  synth + play per cue.
- `synth stream voice=... server-voice=...` - a streamed cue started; `server-voice` is the library voice the server
  resolved (`x-tts-voice`), `?` for clones.
- `playStream pipe ended: ...` - the stream to the player ended early (barge-in or a mid-stream failure).
- `synth FAILED voice=...: <status>: <body>` - synth threw, with the server's reason.

This makes a silent session diagnosable without a UI: a quick `/tts say hello` (which bypasses gating) isolates
engine/player from gating, and the trace shows exactly which branch a real turn took and why.

## Troubleshooting: choppy / stuttering playback on WSL2 (WSLg)

If speech plays back **choppy / stuttering with periodic pauses** under WSL2, the cause is almost certainly NOT the TTS
server or this extension - the synthesized audio file is fine. It is a WSLg audio-pipeline bug: with `systemd=true` in
`/etc/wsl.conf`, `systemd-timesyncd` runs alongside WSL's own host time sync and the two fight, stepping the clock every
~30s. Each step resets PulseAudio's timer-based scheduler and drops audio (microsoft/wslg#1257).

Confirm it: a _pure tone_ stutters too
(`ffmpeg -f lavfi -i sine=frequency=440:duration=5:sample_rate=44100 -ac 2 t.wav && paplay t.wav`), and
`journalctl -u systemd-resolved -b | grep -c "Clock change"` returns hundreds (one per ~33s). Neither a bigger buffer
(`PULSE_LATENCY_MSEC=2000`), a native-rate file (44.1kHz/stereo), nor switching player (`mpv`) helps - they all still
stutter, which is the tell that it is the clock, not the audio path.

Fix (WSL already syncs time from the Windows host, so timesyncd is redundant here):

```bash
sudo systemctl disable --now systemd-timesyncd
sudo systemctl mask systemd-timesyncd   # keep it from coming back
```

After this, `Clock change detected` events stop and playback is smooth. Resampling (24kHz mono -> the sink's 44.1kHz
stereo) and `paplay` itself are NOT the problem despite looking suspicious.
