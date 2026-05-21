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
- `/waveform off` - hide the indicator entirely. The shimmering label still renders.
- `/waveform reset` - restore pi's default braille spinner and the default `Working...` label.

The chosen style persists to `~/.pi/waveform-indicator.json` (matching the layout of `bash-permissions.json`) so it
sticks across pi sessions. `/waveform reset` deletes the file. If the persistence write fails (read-only home,
permission denied, full disk) the extension surfaces the error via `ctx.ui.notify` and keeps running with the chosen
mode for the current session.

## Environment variables

- `PI_WAVEFORM_INDICATOR_DISABLED=1` - skip the extension entirely; pi's default indicator and label remain untouched.
  Useful inside subagent harnesses or non-interactive smoke tests where ANSI noise muddles the output.
- `PI_WAVEFORM_INDICATOR_MODE=<scroll|spectrum|off|default>` - override the persisted mode for this shell only, without
  rewriting `~/.pi/waveform-indicator.json`. An unknown value is ignored (extension falls through to the persisted file,
  then to `'scroll'`). Useful for one-off `pi --print` runs or subagents you want pinned to a specific style.
- `PI_WAVEFORM_THINKING_PULSE=off` - suppress the breathing pulse on the thinking-effort segment of the dim suffix
  without disabling the rest of the extension. The other segments (elapsed, ↑/↓ tokens) keep their static dim wrap and
  the indicator keeps rendering. Any other value (including unset) leaves the pulse on; the default is on.
- `PI_WAVEFORM_THINKING_PULSE_HZ=<float>` - override the cosine frequency in Hz. Default `0.5` (≈ 2 s period - matches
  claude-code's pulse cadence by eye). `<= 0` and non-finite values short-circuit to a static dim render (same effect as
  `PI_WAVEFORM_THINKING_PULSE=off`) so `PI_WAVEFORM_THINKING_PULSE_HZ=0` does what users expect rather than letting
  `cos(0) = 1` paint a stuck-at-peak frame forever.

## Persistence

The chosen mode is stored in `~/.pi/waveform-indicator.json`:

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

## Future hooks

The label is produced by a single `renderLabel(tick, suffix)` function inside the extension: `tick` drives the rainbow
shimmer on the head, `suffix` is the dim claude-code-style parens (or `undefined` to suppress them, as on the
`agent_end` clean-frame). To swap "Thinking..." for something more dynamic - a tiny-model–generated phrase, a verb
pulled from a local pool, a clock, anything - replace `shimmerLabel('Thinking...', tick)` with the new generator. The 80
ms ticker keeps shimmering whatever string it returns, so as long as the new generator is synchronous (or memoizes the
result and refreshes asynchronously) nothing else has to change. The dim suffix path keeps working untouched.

A reasonable shape for a tiny-model integration: kick off `runOneShotAgent` on `agent_start`, cache the returned phrase
in a closure variable, and have the head reader pull from that cache (with a fallback to `Thinking...` while the phrase
is still pending). Per [`extensions/AGENTS.md`](./AGENTS.md), the spawn site needs a disk-backed
`SessionManager.create(...)` via `resolveSubagentSessionDir` - never `SessionManager.inMemory(...)`.

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

## Pure helpers

Lives in [`../../../lib/node/pi/waveform-indicator.ts`](../../../lib/node/pi/waveform-indicator.ts). Public exports:

- `encodeBrailleColumns(leftHeight, rightHeight)` - sample-pair → braille glyph.
- `waveShape(x)` - periodic wave sample at sample-index `x`.
- `WAVE_SHAPE_PERIOD` - the wave period constant (60 today).
- `buildIndicatorFrames(opts)` - the full pre-rendered scrolling-wave animation.
- `spectrumBar(k, t)` - bar height for column `k` at frame `t`.
- `SPECTRUM_BAR_PERIOD` - the spectrum-bar period constant (120 today).
- `buildSpectrumFrames(opts)` - the full pre-rendered spectrum-bars animation.
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

## Hot reload

Edit [`extensions/waveform-indicator.ts`](./waveform-indicator.ts) and run `/reload` in an interactive pi session to
pick up changes without restarting. The label ticker is bound to `agent_start` / `agent_end` so a `/reload` mid-stream
will leave the previous timer running until the current turn ends - no leaks, just a brief overlap.

## Interaction with `titlebar-spinner.ts`

Independent. `titlebar-spinner` writes the terminal title via OSC; this extension writes the inline working-indicator
row via `setWorkingIndicator` / `setWorkingMessage`. They share the 80 ms `FRAME_INTERVAL_MS` constant by accident, not
by design - tweaking one doesn't have to touch the other.
