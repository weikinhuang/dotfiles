# `titlebar-spinner.ts`

Terminal title-bar spinner so backgrounded pi sessions (tiled WMs, tmux, iTerm tabs) are glanceable. The title format is
always `<indicator> - <cwd-basename>`, where `<indicator>` is an animated braille frame while an agent turn runs and a
static `π` when pi is idle. Mirrors the behaviour of Claude Code, Aider, and similar TUIs.

## What it does

- **Idle** - title shows `π - <cwd-basename>`. Seeded on `session_start` so the tab updates the moment pi launches, not
  after the first turn.
- **Running** - on `agent_start` the extension spins up a 80 ms `setInterval` that cycles through 10 braille frames
  (`⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`) with the same `- <cwd-basename>` suffix.
- **Stops** - `agent_end` and `session_shutdown` clear the interval, reset the frame index, and restore the idle title.
  Stale timers are also cleared at the start of each new `agent_start` as a belt-and-braces guard against a missed
  `agent_end`.

The spinner polls `process.cwd()` every tick while running, so a `bash cd …` inside a turn surfaces quickly. When idle,
the title only refreshes on the next `agent_start` / `agent_end` boundary - pi doesn't emit a cwd-change event, and the
statusline footer already shows the live cwd, so the coarser behaviour is fine.

This is a fork of pi's `examples/extensions/titlebar-spinner.ts` with two tweaks: the idle title keeps the `π` indicator
(the upstream example drops it) and the session name is omitted in favour of the cwd basename - a more reliable "which
project am I in?" signal.

## Environment variables

- `PI_TITLEBAR_SPINNER_DISABLED=1` - skip the extension entirely; pi's default title remains untouched.

## Hot reload

Edit [`extensions/titlebar-spinner.ts`](./titlebar-spinner.ts) and run `/reload` in an interactive pi session to pick up
changes without restarting.
