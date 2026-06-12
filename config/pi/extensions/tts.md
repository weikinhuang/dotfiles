# tts - two-mode TTS narration for pi

Speaks finalized assistant output aloud after each turn, without blocking the turn. The extension is a thin pi shell
(`tts.ts`) over three pure, unit-tested modules under `tts/` (`config.ts`, `text.ts`, `engine.ts`, plus `types.ts`).

It drives an OpenAI-compatible `qwen3-tts` server (the
[groxaxo Qwen3-TTS-Openai-Fastapi](https://github.com/groxaxo/Qwen3-TTS-Openai-Fastapi) backend). It is **never
load-bearing**: any failure (server down, no audio player, synth error) degrades to a silent no-op and the turn always
completes.

## Two modes

| Mode          | Gate                                                                    | Speaks                   | Voice                                                         |
| ------------- | ----------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| **RP**        | `PI_RP_TTS=1` (or `/tts on`) **and** an active `roleplay: true` persona | quoted `"dialogue"` only | `rpVoice` (a clone voice with emote-selected reference clips) |
| **Narration** | `PI_TTS_NARRATE=1` (or `/tts narrate on`) in a **non-RP** session       | assistant prose, chunked | `narrationVoice` (typically a preset voice)                   |

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
the same queue pipeline so the clone and narrator voices interleave - and, with the dual-instance setup, dialogue hits
the Base instance while narration hits the CustomVoice instance. If no narration voice resolves, narration cues are
skipped and it degrades to dialogue-only. Long spans are chunked and the total is capped at `maxNarrationChunks`.

When `rpVoice` and `narrationVoice` are the **same** voice, consecutive same-voice segments are coalesced into one run,
so the whole reply is spoken as continuous prose (one synth call per chunk, natural prosody across quote boundaries)
instead of a separate request per segment. The turn's emote applies to any run that contains dialogue.

### OOC pause / resume

An `[OOC: PAUSE]` marker in any message stops narration until `[OOC: RESUME]`. Resume wins if both appear. `[OOC: ...]`
blocks are also stripped from spoken text so meta-asides are never read aloud.

## Environment variables

| Var                | Effect                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `PI_RP_TTS=1`      | enable RP dialogue narration (same as `/tts on`)                                                                |
| `PI_TTS_NARRATE=1` | enable agent-output narration (same as `/tts narrate on`)                                                       |
| `PI_TTS_URL=...`   | override the configured top-level `baseUrl` (only swaps the shared fallback URL, not a voice that pins its own) |
| `PI_TTS_DEBUG=1`   | append a per-turn diagnostic trace to `/tmp/tts-debug.log` (see Debugging)                                      |

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

It also warns on a **voice/instance mismatch** before it 500s at synth time: a `preset` voice pointed at a Base model,
or a `clone` voice pointed at a CustomVoice model.

## Configuration

JSONC config, layered lowest to highest:

1. shipped defaults
2. `<piAgentDir>/tts.json` (global layer)
3. `<cwd>/.pi/tts.json` (project layer; applied **only when the project is trusted**)

`PI_TTS_URL` overrides the resolved top-level `baseUrl`.

### Top-level keys

| Key                  | Meaning                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `baseUrl`            | fallback server URL (include the `/v1` suffix). A voice without its own `baseUrl` inherits this. |
| `api`                | engine preset: `openai` (qwen3-tts) or the legacy `gpt-sovits` GET path.                         |
| `model`              | model name sent in the speech body (e.g. `qwen3-tts`).                                           |
| `format`             | response audio format (`wav`, `mp3`, ...).                                                       |
| `player`             | local playback command (e.g. `paplay`, `afplay`, `ffplay`).                                      |
| `requestTimeoutMs`   | synth request timeout. Keep generous (e.g. `180000`) to survive a scale-from-zero cold start.    |
| `maxChunkChars`      | narration chunk size (sentence/paragraph-bounded).                                               |
| `maxNarrationChunks` | cap on chunks spoken per narration turn.                                                         |
| `authHeader`         | optional `{ "name": ..., "value": ... }`; `value` supports `${ENV}` interpolation.               |
| `voices`             | the voice roster (below).                                                                        |
| `rpVoice`            | roster name used in RP mode.                                                                     |
| `narrationVoice`     | roster name used in narration mode.                                                              |

### Voice entries

```jsonc
"voices": {
  "exusiai": {
    "kind": "clone",                       // "clone" or "preset"
    "baseUrl": "http://127.0.0.1:8880/v1", // optional per-voice endpoint override
    "promptLang": "en",
    "refAudio": "/abs/path/on/THIS/machine.wav", // read client-side, base64'd
    "refText": "transcript of the reference clip", // enables ICL (higher quality)
    "emotes": [                            // optional emote-keyed reference clips
      { "match": ["excited", "cheer"], "refAudio": "...", "refText": "..." }
    ]
  },
  "narrator": {
    "kind": "preset",
    "preset": "ryan"                       // a voice the server lists
  }
}
```

- A voice may override `baseUrl` and/or `authHeader`; the endpoint travels with the voice. `PI_TTS_URL` only swaps the
  shared fallback, never a pinned voice.
- Voice names resolve case-insensitively (exact match first, then lowercase).
- `clone:Name` as an `rpVoice` / `narrationVoice` value forces clone treatment.
- `refAudio` is read on the client and base64-encoded, so it must be a path on **this** machine, not the server's
  filesystem.
- Emotes: the avatar bus emote for the turn selects a matching reference clip; the first `match` array containing the
  emote wins, else the voice's default `refAudio` is used.

## Dual-instance recipe (qwen3-tts)

The qwen3-tts checkpoints split capability, so a clone voice and a preset voice cannot share one instance:

- **Base** checkpoint - zero-shot voice **cloning** only (presets 500 with "does not support generate_custom_voice").
- **CustomVoice** checkpoint - **preset** voices only (no cloning).

Run both and pin each voice to the right one:

```jsonc
{
  "baseUrl": "http://127.0.0.1:8881/v1",   // CustomVoice (presets) - the fallback
  "voices": {
    "exusiai":  { "kind": "clone",  "baseUrl": "http://127.0.0.1:8880/v1", ... }, // Base
    "narrator": { "kind": "preset", "preset": "ryan" }                            // inherits :8881
  },
  "rpVoice": "exusiai",
  "narrationVoice": "narrator"
}
```

Because `rpVoice` and `narrationVoice` resolve their endpoints independently, this also gives per-mode routing for free.
`/tts status` will flag it if a voice ends up on the wrong checkpoint.

## Resilience

- **Cold start:** `requestTimeoutMs` is generous, so a synth fired while a scale-to-zero instance is spinning up waits
  rather than failing.
- **Bounded retry:** transient failures (network error, or HTTP `429/502/503/504`) are retried up to 3 times with 500 ms
  -> 1 s backoff. A non-retryable status (`4xx` / `500`, e.g. preset-on-Base) fails fast. The request's own timeout is
  not retried.
- **Visible failures:** a failed synth carries the HTTP status plus a truncated response-body snippet, surfaced in the
  `PI_TTS_DEBUG` trace.

## Debugging

Set `PI_TTS_DEBUG=1` and the extension appends one line per relevant event to `/tmp/tts-debug.log`:

- `message_end role=... rpEnabled=... narrate=... roleplay=... paused=...` - the gate state for the turn.
- `RP branch: dialogueLen=... sample="..."` - whether `extractDialogue` found quoted text.
- `RP branch: resolved=exusiai/clone` - voice resolution.
- `RP branch: speaking gen=... emote=...` - reached playback.
- `playSeq chunk i/n synth=ok|NULL stale=... paused=...` and `playSeq playing chunk i via <player>` - synth + play per
  chunk.
- `synth FAILED voice=...: <status>: <body>` - synth threw, with the server's reason.

This makes a silent session diagnosable without a UI: a quick `/tts say hello` (which bypasses gating) isolates
engine/player from gating, and the trace shows exactly which branch a real turn took and why.
