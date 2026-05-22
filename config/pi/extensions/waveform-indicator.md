# `waveform-indicator.ts`

Replaces pi's default braille spinner with a music-style scrolling waveform rendered in 1-dot-thick braille bars and a
rainbow shimmer that drifts across the wave. Also replaces the `Working...` label with a shimmering `Thinking...` so the
streaming row reads as one cohesive animation, and appends a dim claude-code-style suffix in parens that reports elapsed
time, tokens streamed, and live thinking-block status (e.g.
`Thinking... (5s · ↑ 185 tokens · thinking with medium effort)`).

## What it does

- **On `session_start`** - calls `ctx.ui.setWorkingIndicator({ frames, intervalMs })` with a pre-rendered 120-frame
  cycle (≈ 9.6 s at `intervalMs=80 ms`). Pi's loader auto-cycles the frames whenever it's visible.
- **On `agent_start`** - allocates a fresh `LabelSuffixState` (loop start time, zeroed token totals, `uplink` phase),
  re-applies the indicator (defensive), and starts a sibling 80 ms `setInterval` that re-calls
  `ctx.ui.setWorkingMessage(renderLabel(tick, suffix))`. The head is `shimmerLabel('Thinking...', tick)`; the suffix is
  built each tick from the current state plus a fresh read of `pi.getThinkingLevel()`. Pi doesn't expose the indicator's
  frame index, so the label has its own ticker.
- **On `turn_start`** - resets all turn-level fields of the suffix state (phase → `uplink`, `committedUsage` → zero,
  `currentUsage` → cleared, `currentMessageOutputBytes` → zero, thinking bookkeeping zeroed) so the displayed counters
  are per-turn rather than session-cumulative. Only the loop start time is preserved across turns; the elapsed segment
  keeps growing through the whole agent loop while `↑`/`↓` reflect the current turn only.
- **On `message_update`** - drives the suffix state machine off `event.assistantMessageEvent`: snapshots `partial.usage`
  (or `message.usage` / `error.usage` for `done` / `error`); flips `phase` to `downlink` on the first `text_start` /
  `thinking_start` / `toolcall_start`; opens a thinking block on `thinking_start` (always overwriting
  `activeStartedAtMs` so the 20 s "still thinking" timer restarts per block); closes it on `thinking_end`, adding the
  block duration to the per-turn `cumulativeMs`.
- **On `message_end`** - if the message has `role === 'assistant'` and a `usage` field, commits its `input` / `output`
  totals onto `committedUsage` and clears `currentUsage`. Custom agent messages without `role` / `usage` no-op.
- **On `agent_end` / `session_shutdown`** - clears the label ticker, drops the suffix state, and resets the message to
  `tick=0` with no suffix so the next turn's first paint is a clean shimmer frame, not a stale one.

The indicator and label are independent - they're started together but their frame indices drift if a turn lasts long
enough to expose the difference. That's intentional: making them line up would require either polling `setInterval`
state or ditching the pre-rendered indicator path, both of which cost more than the visual sync is worth.

## Encoding

Each braille glyph carries **two waveform samples**, one per column, with sample heights in `0..4` rendered as bars
filling from the bottom. That's 2× the horizontal resolution of chunky 2-col-thick bars (`⣀ ⣤ ⣶ ⣿`) and matches the
mixed-column look of inputs like `⠤⢴⣿⡧⣾⣿⡦`.

Bitmasks (per column, height 0..4):

| Height | Left mask | Right mask |
| -----: | --------: | ---------: |
|      0 |    `0x00` |     `0x00` |
|      1 |    `0x40` |     `0x80` |
|      2 |    `0x44` |     `0xA0` |
|      3 |    `0x46` |     `0xB0` |
|      4 |    `0x47` |     `0xB8` |

Glyph codepoint = `0x2800 + leftMask + rightMask`. So a flat mid-amplitude wave reads as `⣶⣶⣶⣶`, a downslope reads as
`⣶⣦⣤⣄⢀⠀`, etc.

## Wave shape

Sum of three commensurable sines (periods 12, 6, 4 - all divide 12) normalized into `[0, 4]`. The 12-sample period is
tuned for a default 10-glyph indicator (= 20 samples wide) so each frame shows ~1.5 wave cycles - enough peaks and
troughs to read as a music waveform without looking like noise.

For a seamless loop, `scrollSpeed * totalFrames` must be a multiple of `WAVE_SHAPE_PERIOD`. Defaults (`scrollSpeed=0.5`,
`totalFrames=120`, period 12) advance 60 samples = 5 periods → seam-free.

Right-to-left scroll: as time advances, the wave shape's peaks shift left, mimicking a real-time recording display where
new samples enter at the right edge.

## Rainbow shimmer

Per glyph, hue = `(columnIndex × hueSpread + frame × hueSpeed) mod 360` rendered as truecolor SGR (`\x1b[38;2;R;G;Bm`).
HSL→RGB at saturation 0.7, lightness 0.6 for the indicator (vivid), saturation 0.55, lightness 0.7 for the label
(softer, doesn't compete with the wave).

For a seamless **color** loop, `hueSpeed * totalFrames` must be a multiple of 360. Defaults (`hueSpeed=3`,
`totalFrames=120`) give 360° advance = exactly one rainbow rotation per loop cycle. Bumping `hueSpeed` without bumping
`totalFrames` (or vice versa) reintroduces a visible hue snap at the loop seam - the spec asserts both the positive and
negative case.

The label's shimmer uses a smaller `hueSpread` (15° vs 24°) and slower `hueSpeed` (2°/tick vs 3°/frame) so the two
animations look related but not identical.

## Commands

- `/waveform` - print the current style.
- `/waveform scroll` - scrolling waveform (default).
- `/waveform spectrum` - independent bouncing bars rendered as a green → yellow → red EQ heat-map; see
  [Spectrum bars](#spectrum-bars) below for the shape and color rules.
- `/waveform tokenrate` - live tokens-per-second bars, re-rendered each label tick from a running rate sample of the
  model's output stream. Full-spectrum magnitude palette (blue → cyan → green → yellow → red) so a tall bar reads as
  "hot" and a barely-there bar reads as "cold blue" without needing the chart in fine focus; see
  [Token-rate bars](#token-rate-bars) below for the sampling rules and the single-frame caveat.
- `/waveform off` - hide the indicator entirely. The shimmering label still renders.
- `/waveform reset` - restore pi's default braille spinner and the default `Working...` label.

The chosen style persists to `~/.pi/agent/waveform-indicator.json` (matching the layout of `bash-permissions.json`) so
it sticks across pi sessions. `/waveform reset` deletes the file. If the persistence write fails (read-only home,
permission denied, full disk) the extension surfaces the error via `ctx.ui.notify` and keeps running with the chosen
mode for the current session.

## Environment variables

- `PI_WAVEFORM_INDICATOR_DISABLED=1` - skip the extension entirely; pi's default indicator and label remain untouched.
  Useful inside subagent harnesses or non-interactive smoke tests where ANSI noise muddles the output.
- `PI_WAVEFORM_INDICATOR_MODE=<scroll|spectrum|tokenrate|off|default>` - override the persisted mode for this shell
  only, without rewriting `~/.pi/agent/waveform-indicator.json`. An unknown value is ignored (extension falls through to
  the persisted file, then to `'scroll'`). Useful for one-off `pi --print` runs or subagents you want pinned to a
  specific style.
- `PI_WAVEFORM_THINKING_PULSE=off` - suppress the breathing pulse on the thinking-effort segment of the dim suffix
  without disabling the rest of the extension. The other segments (elapsed, ↑/↓ tokens) keep their static dim wrap and
  the indicator keeps rendering. Any other value (including unset) leaves the pulse on; the default is on.
- `PI_WAVEFORM_THINKING_PULSE_HZ=<float>` - override the cosine frequency in Hz. Default `0.5` (≈ 2 s period - matches
  claude-code's pulse cadence by eye). `<= 0` and non-finite values short-circuit to a static dim render (same effect as
  `PI_WAVEFORM_THINKING_PULSE=off`) so `PI_WAVEFORM_THINKING_PULSE_HZ=0` does what users expect rather than letting
  `cos(0) = 1` paint a stuck-at-peak frame forever.

## Persistence

The chosen mode is stored in `~/.pi/agent/waveform-indicator.json`:

```json
{
  "mode": "spectrum"
}
```

Resolution order at session start (first hit wins):

1. `PI_WAVEFORM_INDICATOR_MODE` env var (must be a known mode).
2. The persisted file's `mode` field.
3. Fallback `'scroll'`.

Writes go through the shared [`atomic-write.ts`](../../../lib/node/pi/atomic-write.ts) helper so a crash mid-write can't
leave the file half-rendered. Read-side: malformed JSON, an unknown mode, or a missing file all silently fall through to
step 3 - a corrupted file never breaks startup. The pure read/write/clear helpers and the resolve order live in
[`waveform-indicator-state.ts`](../../../lib/node/pi/waveform-indicator-state.ts) and are covered by
[`tests/lib/node/pi/waveform-indicator-state.spec.ts`](../../../tests/lib/node/pi/waveform-indicator-state.spec.ts).

## Dynamic head: persona-driven tiny-model phrase

The rainbow `Thinking...` head is replaced by a short persona-flavoured present-participle phrase generated by a tiny
model. The phrase rotates as the agent moves through phases (turn start with a new prompt, thinking block opens, tool
call starts, response text starts) so the user gets a live read on what's happening. While a spawn is pending or fails,
the head falls back to the literal `Thinking...` so something always renders.

Examples (with the rainbow shimmer + breathing-glow stripped for clarity):

```text
Thinking... (5s)                            fallback - default + first paint
Plotting course... (12s · ↑ 1.2k tokens)    exusiai-buddy persona, code-review prompt
Avast! Boarding the codebase... (8s)        pirate persona, search prompt
Pondering... (3s)                           neutral system prompt, no persona configured
```

The feature is **off by default**. Opt in by adding a `dynamicLabel` block to `~/.pi/agent/waveform-indicator.json`:

```json
{
  "mode": "scroll",
  "dynamicLabel": {
    "enabled": true,
    "tinyModel": "llama-cpp/qwen3-0.6b",
    "persona": "daemon-waveform",
    "maxCallsPerSession": 20
  }
}
```

### `dynamicLabel` schema

| Field                | Default             | Notes                                                                                                                                           |
| -------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | `false`             | When `false`, the head stays as the static `Thinking...`. The whole feature is off-by-default.                                                  |
| `tinyModel`          | (required)          | `provider/model-id`. Validated via `parseModelSpec`, same helper `research-tiny.ts` uses, so any model registered in pi works on equal footing. |
| `persona`            | `"daemon-waveform"` | Name of a persona under one of the three layered `personas/` dirs. Set to `""` to opt out of any overlay (neutral system prompt only).          |
| `maxCallsPerSession` | `20`                | Per-session cap. Once hit, every subsequent trigger short-circuits without spawning. Resets at the next pi `session_start`.                     |

`tinyModel` is well-suited to local llama-cpp models in the 0.6B-9B range: the phrase is short (<=60 chars), the prompt
is tiny (<=200 chars + persona overlay), the 5 s timeout is tight, and there's no per-call USD cost. The setting lives
in `~/.pi/agent/waveform-indicator.json` (not piggy-backing on `~/.pi/agent/research-tiny.json`) - the waveform
extension owns its own model resolution.

### Two-stage `tinyModel` validation

| Stage                  | Where it runs               | Fallback rule                                                                                                                                                                                 |
| ---------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parse-fail at load     | `resolveDynamicLabelConfig` | `dynamicLabel` is treated as `enabled: false` for the session. One-shot `ctx.ui.notify` warning fires so the user knows the setting didn't take.                                              |
| Registry-miss at spawn | extension shell             | The trigger short-circuits without spawning; the previously-accepted phrase (or `Thinking...` if none yet) stays on screen; a one-shot warning fires. We do NOT substitute a different model. |

A typo in `tinyModel` therefore reads as "feature disabled, see the warning" rather than as "silently picked another
model the user didn't ask for". The same two-stage rule applies to `PI_WAVEFORM_DYNAMIC_LABEL_MODEL` (see below).

### Refresh triggers + per-`phaseTag`-per-turn dedup

The phrase rotates as the agent moves between phases. Each trigger fires a tiny-model spawn with a `phaseTag` plus a
short `contextDigest`.

| Trigger          | `phaseTag`         | `contextDigest`                                            |
| ---------------- | ------------------ | ---------------------------------------------------------- |
| `turn_start`     | `starting work on` | first 200 chars of the latest user message in the session  |
| `thinking_start` | `reasoning about`  | cached `promptDigest` captured on `turn_start`             |
| `toolcall_start` | `using <tool>`     | tool name + first 100 chars of `JSON.stringify(arguments)` |
| `text_start`     | `responding about` | cached `promptDigest`                                      |

A turn typically fires `thinking_start` → `toolcall_start` → `thinking_start` → `toolcall_start` → `text_start`
(multiple reasoning blocks interleaved with multiple tool calls). Without dedup that burns 5+ calls per turn and a
budget of 20 lasts ~3 turns. **The rule is: at most one spawn per `phaseTag` per turn.** A trigger whose tag is already
in the per-turn set is a no-op (keep last accepted phrase). With dedup the worst-case turn fires 4 spawns (one per tag),
so `maxCallsPerSession: 20` covers ~5 turns of an actively-thinking agent.

### Coalescing + reset points

Multiple triggers can fire inside one turn even with dedup. Each spawn is async, so a slow earlier call could land after
a faster later one. The coalescing reducer in
[`waveform-indicator-phrase.ts`](../../../lib/node/pi/waveform-indicator-phrase.ts) handles this with a monotonic
request id + an explicit `AbortController` wired into both the in-flight spawn AND the parent turn signal (composed via
[`abort-merge.ts`](../../../lib/node/pi/abort-merge.ts)):

1. Each spawn is issued with `requestId = ++state.nextRequestId`. State carries `controller: AbortController | null`.
   Before issuing a new spawn the reducer aborts the previous controller and stores the new one.
2. The new controller's signal is composed with `ctx.signal` so user Ctrl-C tears down the spawn along with the turn.
3. When a spawn returns, the reducer ignores the response if `requestId < state.lastAcceptedRequestId` (stale), if the
   signal is aborted (cancelled), or if the validator rejects the body outright (multi-line, ANSI, control bytes,
   literal `null`, opens on a non-letter). Phrases longer than the cap are truncated with a single `…` rather than
   dropped. Otherwise it updates `state.acceptedPhrase` and `state.lastAcceptedRequestId`.
4. Until any phrase has been accepted, the head renders the literal `Thinking...`.
5. Once a phrase is accepted, it stays on screen even while a new spawn is in flight - no flicker back to `Thinking...`
   between triggers.
6. Failure paths (timeout, validator hard-reject, `stopReason` outside `completed`/`max_turns`, budget exhausted,
   persona load failed, `tinyModel` registry-miss at spawn time) all keep the previously-accepted phrase, or render
   `Thinking...` if none.

**Reset points** - every one of these aborts the in-flight controller and clears stale spawn-in-flight bookkeeping:

1. **New trigger fires** - issue new controller, abort previous.
2. **`agent_end`** - abort, clear `state.controller`. The accepted phrase stays in state so a follow-up agent loop in
   the same session re-uses it as the seed.
3. **`session_shutdown`** - abort, drop all state. No bleed across pi sessions.
4. **`/reload` mid-stream** - pi fires `agent_end` + `session_shutdown` underneath, so this collapses onto #2 + #3.

### Persona overlay

The phrase generator runs the [`waveform-phraser`](../agents/waveform-phraser.md) subagent with a persona body appended
to its system prompt. The persona is resolved across the same three layers `lib/node/pi/persona/parse.ts` already
supports, with "first hit wins" (project highest priority):

1. `<cwd>/.pi/personas/<name>.md` (project)
2. `~/.pi/agent/personas/<name>.md` (user)
3. `<extDir>/../personas/<name>.md` (shipped catalog - where the bundled `daemon-waveform.md` lives)

The shipped [`daemon-waveform.md`](../personas/daemon-waveform.md) is the default persona, so the dynamic head works
out-of-the-box on a fresh dotfiles install without any user / project persona configured. Set `persona: "<name>"` to
swap the voice; set `persona: ""` to opt out of the overlay entirely (neutral system prompt only). For authoring a new
themed overlay, see [`../personas/waveform-overlay-authoring.md`](../personas/waveform-overlay-authoring.md) - it covers
the body skeleton, the 4B+ tiny-model floor, and the probe playbook.

**Composition mechanism**: the spawn site shallow-clones the loaded `waveform-phraser` `AgentDef` and appends the
persona body to its `appendSystemPrompt` field. This avoids a per-call hook on `runOneShotAgent`'s args; the clone is
cheap (one object spread) and the original `AgentDef` stays untouched in the agent registry.

**Tool-use guarantee, enforced at three layers**:

1. **Agent frontmatter** declares `tools: []`. The subagent loader honours this as a hard floor.
2. **Spawn site** in [`waveform-indicator.ts`](./waveform-indicator.ts) calls `runOneShotAgent` without passing any
   tools. No `tool_call` events are even possible.
3. **System prompt** explicitly forbids tool use, both in the base rule sheet and as a leading sentence the
   `buildPhrasePrompt` helper injects into every user message.

This matters because local llama-cpp models can be unpredictable about following negative instructions, and personas
like `pirate` or `exusiai-buddy` may include language that sounds permission-granting in context. The three layers make
any one regression independent of the others.

### Environment variables

- `PI_WAVEFORM_DYNAMIC_LABEL=on` / `=off` - opt in / out of dynamic labels for this shell only. Other values fall
  through to the file's `enabled` value.
- `PI_WAVEFORM_DYNAMIC_LABEL_MODEL=<provider/model-id>` - swap the configured `tinyModel` for this shell only. Same
  two-stage validation as the file value: parse-fail falls through to the file's `tinyModel`; registry-miss does NOT
  fall through (we don't silently substitute a model the user didn't pick).

`PI_WAVEFORM_INDICATOR_DISABLED=1` short-circuits the entire extension before any of these are read.

A per-persona env override is intentionally NOT shipped - personas are a configuration choice, not a smoke-test
parameter. Edit the file when you want to try a different persona.

### Spawn site + on-disk transcript

The spawn site explicitly imports `resolveSubagentSessionDir` from
[`subagent-session-dir.ts`](../../../lib/node/pi/subagent-session-dir.ts) and wraps the result with
`SessionManager.create(...)` per [`extensions/AGENTS.md`](./AGENTS.md). Never `SessionManager.inMemory(...)`. The
transcript lands under `<parentSessionDir>/<parentSid>/subagents/<ts>_<childSid>.jsonl` so `pi session-usage` /
`ai-tool-usage` can roll up the cost ("you spent $0.04 on Thinking-text rewrites this session").

## Dim suffix

The parenthesised suffix renders three optional segments separated by `·` to mirror claude-code's format:

1. **Elapsed** (always present) - `5s`, `42s`, `1m 18s`, `2h 3m`. Floors to whole seconds so the counter ticks
   monotonically. Measured from `agent_start`, not from each `turn_start`, so the timer keeps growing across multiple
   turns of the same agent loop.
2. **Tokens** (suppressed while the relevant direction is 0). Per-turn rather than session-cumulative - `committedUsage`
   is zeroed on each `turn_start`, and the ↑ segment renders the _delta_ of `ctx.getContextUsage().tokens` since the
   previous `message_end` so it shows the size of new content this turn (tool result / next user message), not the
   cumulative full context. `phase: 'uplink'` shows `↑ <input> tokens`, where input =
   `max(committedUsage.input + currentUsage.input, contextTokensDelta)` so we render an honest count from the very first
   frame even when the provider doesn't stream `partial.usage.input` mid-message; for the very first turn of a loop (no
   previous snapshot) the delta falls back to the full current context size. `phase: 'downlink'` shows
   `↓ <output> tokens`, where output =
   `committedUsage.output + max(currentUsage.output, ceil(currentMessageOutputBytes / 4))` so the counter ticks up live
   (via the byte-estimate fallback) even when the provider only emits real usage at `message_end`. Formatted as a raw
   integer below 1000, `N.Nk` from 1k to 999k, `N.NM` above (always one decimal in the `k`/`M` ranges - claude shows
   `2.0k`, not `2k`).
3. **Thinking** (suppressed when `getThinkingLevel()` is `off` / `minimal`, or when no thinking block has started this
   turn). The state machine:

   | State                                      | Trigger                                                                            | Suffix segment                                                                                                                                                         |
   | ------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | not yet thinking                           | initial / post-`turn_start`                                                        | (omitted)                                                                                                                                                              |
   | currently thinking, in-block < 20 s        | `thinking_start` arrived                                                           | `thinking with <level> effort`                                                                                                                                         |
   | currently thinking, in-block ≥ 20 s        | 20 s elapsed since the **most recent** `thinking_start`                            | `still thinking with <level> effort`                                                                                                                                   |
   | thinking ended, no text/toolcall yet       | `thinking_end` arrived (brief window before first `text_start` / `toolcall_start`) | `thought for Ns` (cumulative across all blocks this turn, clamped to ≥ 1 s)                                                                                            |
   | non-thinking content streaming             | `text_start` / `toolcall_start` fired this turn                                    | (omitted) - the segment is suppressed once the model starts producing the actual response                                                                              |
   | new block opens after a previous one ended | next `thinking_start` (interleaved thinking)                                       | back to `thinking with <level> effort`; the 20 s timer restarts at zero, and `activeStartedAtMs` takes precedence over the `hasStreamedNonThinkingContent` suppression |

The whole suffix is wrapped in `\x1b[2;38;5;245m…\x1b[0m` (faint + 256-color grey-245, full reset at the close) so it
reads as visually subordinate to the rainbow head.

### Breathing pulse on the thinking-effort segment

When the suffix carries a thinking-effort segment (`thinking with <level> effort`, `still thinking with <level> effort`,
or `thought for Ns`), that segment renders with a slow truecolor cosine pulse around the same grey-245 baseline -
claude-code's "Thinking..." line breathing transposed onto the suffix. The other segments (elapsed, ↑/↓ tokens, the
parens, the `·` separators) keep the static `\x1b[2;38;5;245m…\x1b[0m` wrap so only the thinking text breathes.

Mechanics:

- Centre RGB `(138, 138, 138)` matches xterm-256 grey-245 so the pulse stays in the dim band visually subordinate to the
  rainbow head.
- Channel value = `centre + breatheDepth * cos(2π * tick * breatheSpeed / FRAMES_PER_SECOND)`. Defaults are
  `breatheSpeed = 0.5` Hz (≈ 2 s period) and `breatheDepth = 15` (peak 153, trough 123). `tick = 0` lands on
  `cos(0) = 1` so a freshly-opened thinking block first appears at the peak, not the trough.
- Each SGR is `\x1b[2;38;2;v;v;vm…\x1b[0m` (faint + truecolor + full reset). The truecolor channel is the primary
  signal: some `tmux` / `screen` passthrough configs drop one attribute when faint is combined with truecolor, but the
  channel value still drives a visible pulse on its own - the pulse degrades to a colour-only effect, not a static
  segment.
- The suffix renderer suppresses the pulse SGR entirely when the thinking-effort segment is not present
  (`getThinkingLevel()` is `off` / `minimal`, no thinking block has started this turn, or the segment is suppressed once
  `text_start` / `toolcall_start` fired). In those states the suffix renders with today's single static dim wrap.

Override knobs (shell-local; no persisted setting):

- `PI_WAVEFORM_THINKING_PULSE=off` - opt out of the pulse without disabling the whole extension. The suffix still
  renders, just without the breathing effect.
- `PI_WAVEFORM_THINKING_PULSE_HZ=<float>` - override the default 0.5 Hz cadence. `<= 0` and non-finite values are
  treated as `off`.

### `NO_COLOR` and non-TTY behaviour

Both `dimText` and `pulseDimText` short-circuit to plain unstyled text when `NO_COLOR` is set to any non-empty value or
`process.stdout.isTTY === false`. That diverges from the pre-pulse `dimText` (which emitted SGR unconditionally) - the
gate was folded into both helpers in lockstep so the two-pass pulse render and the static fallback render stay
consistent under piped or `NO_COLOR=1` invocations. Inside an interactive terminal nothing changes; the suffix only
loses its dim colour when something downstream has already opted out of colour.

## Spectrum bars

Alternate pattern selected by `/waveform spectrum`. Twenty independent bars (10 glyphs × 2 columns) bounce on their own
phases, like a music spectrum analyzer rather than one continuous wave. Each bar is a sum of four commensurable sines
(periods 120, 60, 40, 30 - all divide 120) with hand-picked per-column phase offsets so neighbours don't lock-step.
After `SPECTRUM_BAR_PERIOD` (= 120) frames every bar returns to its starting height, so the loop is seamless at the
default `totalFrames=120`.

**Color: heat-map, not rainbow.** Each glyph picks its hue from the taller of its two bars on a 120° → 0° gradient -
short bars glow green, mid-height yellow, tall red - which gives the classic EQ-display look. A slow `hueSpeed=3`°
rainbow drift is layered on top so held bars don't look static; the same `hueSpeed * totalFrames = 360°` constraint that
makes the waveform's color loop seamless applies here too. The spec asserts both the positive and negative case.

**Why a different color treatment for spectrum vs scroll:** the scrolling wave already uses a per-glyph rainbow, so
coloring the spectrum the same way would make the two modes blur visually. The heat-map is iconic for spectrum displays
and reads as a different visual language at a glance.

## Token-rate bars

Alternate pattern selected by `/waveform tokenrate`. The bars graph the model's output rate (tokens/sec) sampled live
from the same byte-accumulator the suffix uses for its `↓` segment, so the bars and the dim counter agree on what
they're measuring. Recently-streamed output appears at the right edge; older samples scroll left as fresh ones land.
Idle = flat zero. Bursts of fast output spike the rightmost bars and those spikes drift left as they age.

**Sampling rules.** The state machine lives in
[`waveform-indicator-rate.ts`](../../../lib/node/pi/waveform-indicator-rate.ts) so it's covered by its own focused unit
tests. On each label tick:

1. Compute `currentTokens = committedUsage.output + max(currentUsage.output, ceil(currentMessageOutputBytes / 4))`
   - the same "live ↓ estimate" formula the suffix uses, so both readouts agree.
2. Step the rate machine with `(currentTokens, now)`. Returned rate is `Δ tokens / Δ seconds` with these guards:
   - **Negative delta** (post-`message_end` byte counter reset, OR pi compaction shrinking `committedUsage` mid-turn) →
     re-baseline, emit `rate = 0`. Without the re-baseline the buffer would stay stuck at zero until the cumulative
     count caught up to the pre-shrink snapshot, which could be tens of seconds.
   - **`dt < 1 ms`** → skip the sample without touching the baseline. Catches two ticks landing in the same millisecond
     (or a sub-ms `Date.now()` wobble) so we never divide by ~zero.
   - **First sample after `message_start`** → skip emission but anchor the baseline at message-start time. Without this,
     the rightmost bar would paint full-saturated indigo for one frame as the byte accumulator races up from zero
     against an artificially small `dt`.
3. Push the rate (when defined) onto the right side of the 20-slot FIFO buffer; the oldest sample falls off the left.
   The 20-slot length is a 10×2 geometry parity match - 10 braille glyphs × 2 columns. An odd-length buffer would leave
   a half-glyph at the leading edge.
4. Map each buffered rate to a `0..4` bar height with an autoscale: `height = round(4 * min(rate / scale, 1))` where
   `scale = max(TOKEN_RATE_MIN_SCALE, max(rateBuffer))` and the floor is 30 tok/s. The floor keeps a single low-rate
   sample from maxing the bars; the running max lifts the ceiling so sustained-fast streams stay readable.
5. Encode pairs of heights into braille glyphs and apply the cool heat-map color (see below).
6. Re-apply `setWorkingIndicator({ frames: [frame, frame], intervalMs })` with two copies of the same frame.

**Single-frame caveat.** Pi's loader is built for static frame arrays it auto-cycles; pushing a one-element array risks
the loader short-circuiting to "static spinner, no further refresh". The two-copies workaround makes the frame list look
like a normal animation to pi while the per-tick re-apply does the actual driving. Cheap (one extra string ref per
push), unambiguous, and easy to reason about - if a future pi version starts honouring single-frame arrays the
workaround is a one-line revert.

**Color: full-spectrum magnitude heat-map (blue → cyan → green → yellow → red).** Each glyph's hue is picked off the
taller of its two bars and mapped linearly across `240° → 0°` - spanning the cool half of the wheel as well as the warm
half. Low bars glow blue, near-low cyan, mid green, near-tall yellow, tall red. The wider hue range makes a 1-bar sample
(cold blue) visually obvious next to a 2-bar sample (green), where a green-only-to-red gradient would render those two
as nearly-the-same green and force the eye onto the bar height alone.

Direction (uplink vs downlink) is already conveyed by the `↑` / `↓` arrow in the dim suffix, so the hue channel is free
to carry intensity instead.

**Why not the spectrum mode's green-to-red.** An earlier iteration used the spectrum mode's `120° → 0°` heat-map, but a
freshly-streaming model produces a lot of mid-low bars that all rendered as nearly-identical green-yellow. Stretching
the gradient across the full wheel gives each bar height its own clearly distinguishable colour.

**Default behaviour.** `tokenrate` is opt-in via `/waveform tokenrate` (or `PI_WAVEFORM_INDICATOR_MODE=tokenrate`)
rather than the default mode. `scroll` is decorative and works even before streaming starts; `tokenrate` has nothing to
render until tokens flow, so it would look broken as a default. The persisted-state file picks it up the same way as the
other modes, and an older binary that doesn't know about `tokenrate` silently falls through to its default - the file
isn't corrupted, just ignored.

## Pure helpers

Lives in [`../../../lib/node/pi/waveform-indicator.ts`](../../../lib/node/pi/waveform-indicator.ts). Public exports:

- `encodeBrailleColumns(leftHeight, rightHeight)` - sample-pair → braille glyph.
- `waveShape(x)` - periodic wave sample at sample-index `x`.
- `WAVE_SHAPE_PERIOD` - the wave period constant (60 today).
- `buildIndicatorFrames(opts)` - the full pre-rendered scrolling-wave animation.
- `spectrumBar(k, t)` - bar height for column `k` at frame `t`.
- `SPECTRUM_BAR_PERIOD` - the spectrum-bar period constant (120 today).
- `buildSpectrumFrames(opts)` - the full pre-rendered spectrum-bars animation.
- `pushTokenRateSample(buffer, rate)` - FIFO push for the tokenrate buffer; clamps non-finite / negative rates to 0.
- `tokenRateBarsToHeights(buffer, opts)` - autoscale + clamp to `0..4`; returns the bar-height array.
- `buildTokenRateFrame(heights, opts)` - encode height pairs into braille glyphs and apply the full-spectrum magnitude
  heat-map color (blue → cyan → green → yellow → red).
- `TOKEN_RATE_BUFFER_SIZE`, `TOKEN_RATE_MIN_SCALE`, `TOKEN_RATE_HUE_LOW`, `TOKEN_RATE_HUE_HIGH` - constants exported for
  testability and so the extension shell doesn't redefine the magic numbers.
- `shimmerLabel(text, tick, opts)` - per-codepoint truecolor wrap.
- `hslToRgb(h, s, l)`, `colorize(text, rgb)` - building blocks for callers that want to render their own variants.

Specs in [`tests/lib/node/pi/waveform-indicator.spec.ts`](../../../tests/lib/node/pi/waveform-indicator.spec.ts) cover
encoding edge cases (clamp, NaN, fractional rounding), HSL→RGB primaries, periodicity / dynamic range of the wave shape,
frame structure (right glyph count, every glyph is in U+2800..U+28FF, every glyph is colorized), animation liveness (no
two consecutive frames identical), seamless looping, and label shimmer (no whitespace coloring, codepoint-aware
iteration).

The dim suffix machinery lives in a sibling module
[`../../../lib/node/pi/waveform-indicator-suffix.ts`](../../../lib/node/pi/waveform-indicator-suffix.ts). Public
exports:

- `LabelSuffixState`, `ThinkingLevel` - serializable state shape + the local mirror of pi's thinking-level union.
- `STILL_THINKING_THRESHOLD_MS` - the 20 s in-block cutoff for `still thinking`.
- `newLabelSuffixState(nowMs)` - allocate a fresh state for an agent loop.
- `resetTurnState(state)` - clear per-turn fields without losing loop-level token totals.
- `formatElapsed(ms)`, `formatTokens(n)` - the deterministic formatters used by the suffix.
- `formatThinkingEffort(state, level, nowMs)` - state-machine renderer for the thinking segment.
- `formatSuffix(state, level, nowMs, opts?)` - assembles the final `(…)` string. `opts.inputDeltaTokens` carries the
  per-turn ↑ floor (today's `liveInputTokens`, moved into the opts bag); when `opts.tick` is supplied the renderer emits
  a two-pass styled output that wraps the thinking-effort segment in `pulseDimText` and the rest in `dimText` - one call
  replaces the old `dimText(formatSuffix(…))` wrap at the call site. When `opts.tick` is omitted the return value stays
  an unstyled `(…)` string for the caller to wrap.
- `dimText(text)` - wraps the suffix in faint + grey-245 SGR. Short-circuits to plain `text` when `NO_COLOR` is set (any
  non-empty value) or `process.stdout.isTTY === false`.
- `pulseDimText(text, tick, opts?)` - wraps `text` in `\x1b[2;38;2;v;v;vm…\x1b[0m` whose channel value breathes with a
  cosine of `tick`. `opts.breatheSpeed` (Hz, default 0.5), `opts.breatheDepth` (channels, default 15); `<= 0` or
  non-finite `breatheSpeed` and `breatheDepth = 0` both short-circuit to a static `dimText` render. Same `NO_COLOR` /
  non-TTY gate as `dimText`.

Specs in
[`tests/lib/node/pi/waveform-indicator-suffix.spec.ts`](../../../tests/lib/node/pi/waveform-indicator-suffix.spec.ts)
exercise every transition with plain object literals (no fake timers / fake streams), including the
`thinking → still thinking` 20 s threshold, the per-block timer restart, cumulative `thought for Ns` across interleaved
blocks, and the full claude-code shapes seen in the wild (`(1m 18s · ↑ 3.6k tokens)`,
`(42s · ↑ 1.7k tokens · thought for 4s)`, etc.).

The token-rate sample machine lives in a sibling module
[`../../../lib/node/pi/waveform-indicator-rate.ts`](../../../lib/node/pi/waveform-indicator-rate.ts). Public exports:

- `TokenRateState` - serialisable state shape (`lastSampleAtMs`, `lastSampleTokens`, `skipNextSample`).
- `MIN_SAMPLE_DT_MS` - the 1 ms sub-millisecond skip threshold.
- `newTokenRateState()` - allocate a fresh state on `agent_start`.
- `markMessageStart(state, nowMs, currentTokens)` - prime a skip on the next tick so the first computed rate aligns to
  "tokens since text actually started flowing" rather than to the previous idle gap.
- `markMessageEnd(state)` - clear the baseline so the next message re-baselines cleanly.
- `stepTokenRate(state, currentTokens, nowMs)` - returns `{ rate, rebaselined }`. `rate` is `undefined` when the step
  was a baseline-only step (cold start, sub-ms `dt`, first-sample-after-`message_start` skip), or `0` on a
  negative-delta re-baseline, otherwise tokens/sec.

Specs in
[`tests/lib/node/pi/waveform-indicator-rate.spec.ts`](../../../tests/lib/node/pi/waveform-indicator-rate.spec.ts)
exercise each rule in isolation and one end-to-end integration walk through a full message lifecycle, again with plain
inputs - no fake timers required.

## Hot reload

Edit [`extensions/waveform-indicator.ts`](./waveform-indicator.ts) and run `/reload` in an interactive pi session to
pick up changes without restarting. The label ticker is bound to `agent_start` / `agent_end` so a `/reload` mid-stream
will leave the previous timer running until the current turn ends - no leaks, just a brief overlap.

## Interaction with `titlebar-spinner.ts`

Independent. `titlebar-spinner` writes the terminal title via OSC; this extension writes the inline working-indicator
row via `setWorkingIndicator` / `setWorkingMessage`. They share the 80 ms `FRAME_INTERVAL_MS` constant by accident, not
by design - tweaking one doesn't have to touch the other.
