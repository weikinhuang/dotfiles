# `stream-watchdog.ts`

Abort the turn when the model's response stream goes silent. Companion to [`stall-recovery.ts`](./stall-recovery.md) —
both handle "pi is stuck waiting on the model" but from opposite sides:

- **`stream-watchdog` fires mid-stream**: after `message_start` and before `message_end`, when no `message_update` has
  arrived for N seconds. The provider / local inference server has the HTTP connection open but has stopped emitting
  tokens. Action: `ctx.abort()` — programmatic Esc. Pi exits the hung turn so the next turn can proceed.
- **`stall-recovery` fires post-stream**: after a stream has already ended cleanly but with no text and no tool calls
  (empty turn). Action: inject a follow-up user message via `pi.sendUserMessage` with a retry nudge.
- **Composition**: a watchdog-aborted turn is classified `aborted` by pi, and `stall-recovery`'s classifier explicitly
  ignores `aborted` — so no double-fire. If the provider adapter surfaces the abort as a generic `error` instead of
  `aborted`, `stall-recovery` WILL retry the turn, which is the desired behaviour for "stream hung → abort → re-issue".

## Detection

On `message_start` (role=assistant) the extension records the start time, starts a `setInterval` poll (default every 5
s), and hands control to the pure helper [`stream-watchdog.ts`](../../../lib/node/pi/stream-watchdog.ts).

Every `message_update` bumps the state's `lastHeartbeat`. When the poll sees `now - lastHeartbeat >= stallMs`, the
stream is considered stalled and the entry is flagged. The notification latch lives inside the pure state so the poll
only fires **once per stream** — if the stream resumes and goes silent again, a fresh heartbeat clears the latch and the
watchdog can re-fire.

`message_end` drops the entry and stops the poll. No wall-clock thread runs when no assistant stream is in flight.

## Scope: stream only

The extension deliberately does **not** watch tool execution. Long-running `bash` test suites, `research` subagents, and
network-bound tools legitimately run minutes-to-hours without partial output, so a tool watchdog would either cry wolf
or need per-tool thresholds that are impossible to get right.

Pi's tool phase and assistant-stream phase don't overlap in the event model:

1. Model emits a `toolCall` → `message_end` fires → watchdog state is empty.
2. Tool executes for N minutes → no `message_*` events → watchdog does nothing.
3. Tool returns → model starts the next turn → `message_start` fires → watchdog re-arms.
4. Model streams normally → heartbeats keep it healthy; 60 s of silence aborts.

So the watchdog fundamentally can't fire while a tool is running, regardless of how long the tool takes.

## Recovery

When `autoAbort` is on (default), the poll calls `ctx.abort()` — the programmatic equivalent of pressing Esc. The
provider stream terminates, pi emits `agent_end` with `stopReason === 'aborted'` (or `'error'` depending on the
adapter), and the agent loop yields back to the user. No manual intervention required.

With `PI_STREAM_WATCHDOG_ABORT=0` the watchdog surfaces a `ctx.ui.notify` warning but leaves the abort to you. Useful
while tuning `PI_STREAM_WATCHDOG_STALL_MS` against a noisy model — you can see how often the threshold would trigger
before committing to auto-abort.

## UI

While a stream is actively being watched:

- Healthy stream: no status line. The poll is running silently.
- Stall detected, `autoAbort`: `⟳ stream-watchdog: aborted after Ns of silence` on the footer third line, plus a
  `warning`-level notify with silent and total elapsed durations.
- Stall detected, notify-only: `⟳ stream-watchdog: stream silent Ns` plus the equivalent notify.

Status is cleared on `message_end`, on real user input, and on session boundaries.

## Environment variables

- `PI_STREAM_WATCHDOG_DISABLED=1` — skip the extension entirely.
- `PI_STREAM_WATCHDOG_STALL_MS=N` — silence threshold, ms. Default `60000` (60 s). Bump for genuinely slow
  local-inference setups if you see false positives; drop to `30000` for quick feedback during tuning.
- `PI_STREAM_WATCHDOG_POLL_MS=N` — poll interval, ms. Default `5000` (5 s). Trade-off: lower values catch hangs sooner
  but burn more timer ticks. 5 s is a reasonable compromise; there's no reason to go below 1 s.
- `PI_STREAM_WATCHDOG_ABORT=0` — notify only, don't auto-abort. Default is to auto-abort.
- `PI_STREAM_WATCHDOG_VERBOSE=1` — emit a `ctx.ui.notify` on every `message_start` / `message_end` and on every stall
  decision. Useful for tuning; leave off in normal use.

## Hot reload

Edit [`extensions/stream-watchdog.ts`](./stream-watchdog.ts) or
[`lib/node/pi/stream-watchdog.ts`](../../../lib/node/pi/stream-watchdog.ts) and run `/reload` in an interactive pi
session.
