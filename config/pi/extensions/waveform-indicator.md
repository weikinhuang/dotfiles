# `waveform-indicator.ts`

Replaces pi's default braille spinner with a music-style scrolling waveform rendered in 1-dot-thick braille bars and a
rainbow shimmer that drifts across the wave. Also replaces the `Working...` label with a shimmering `Thinking...` so the
streaming row reads as one cohesive animation.

## What it does

- **On `session_start`** - calls `ctx.ui.setWorkingIndicator({ frames, intervalMs })` with a pre-rendered 120-frame
  cycle (≈ 9.6 s at `intervalMs=80 ms`). Pi's loader auto-cycles the frames whenever it's visible.
- **On `agent_start`** - re-applies the indicator (defensive) and starts a sibling 80 ms `setInterval` that re-calls
  `ctx.ui.setWorkingMessage(shimmerLabel('Thinking...', tick))` so the label hue drifts in time with the wave. Pi
  doesn't expose the indicator's frame index, so the label has its own ticker.
- **On `agent_end` / `session_shutdown`** - clears the label ticker and resets the message to `tick=0` so the next
  turn's first paint is a clean shimmer frame, not a stale one.

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

The label is produced by a single `renderLabel(tick)` function inside the extension. To swap "Thinking..." for something
more dynamic - a tiny-model–generated phrase, a verb pulled from a local pool, a clock, anything - replace that one
function. The 80 ms ticker keeps shimmering whatever string it returns, so as long as the new generator is synchronous
(or memoizes the result and refreshes asynchronously) nothing else has to change.

A reasonable shape for a tiny-model integration: kick off `runOneShotAgent` on `agent_start`, cache the returned phrase
in a closure variable, and have `renderLabel(tick)` read from that cache (with a fallback to `Thinking...` while the
phrase is still pending). Per [`extensions/AGENTS.md`](./AGENTS.md), the spawn site needs a disk-backed
`SessionManager.create(...)` via `resolveSubagentSessionDir` - never `SessionManager.inMemory(...)`.

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

## Hot reload

Edit [`extensions/waveform-indicator.ts`](./waveform-indicator.ts) and run `/reload` in an interactive pi session to
pick up changes without restarting. The label ticker is bound to `agent_start` / `agent_end` so a `/reload` mid-stream
will leave the previous timer running until the current turn ends - no leaks, just a brief overlap.

## Interaction with `titlebar-spinner.ts`

Independent. `titlebar-spinner` writes the terminal title via OSC; this extension writes the inline working-indicator
row via `setWorkingIndicator` / `setWorkingMessage`. They share the 80 ms `FRAME_INTERVAL_MS` constant by accident, not
by design - tweaking one doesn't have to touch the other.
