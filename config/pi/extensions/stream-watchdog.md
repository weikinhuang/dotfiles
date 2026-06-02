# `stream-watchdog.ts`

Abort the turn when the model's response stream goes silent. Companion to [`stall-recovery.ts`](./stall-recovery.md) -
both handle "pi is stuck waiting on the model" but from opposite sides:

- **`stream-watchdog` fires mid-stream**: after `message_start` and before `message_end`, when no `message_update` has
  arrived for N seconds. The provider / local inference server has the HTTP connection open but has stopped emitting
  tokens. Action: `ctx.abort()` - programmatic Esc - then, on the following `agent_end`, inject a synthetic
  user-equivalent follow-up nudge (custom message) so the next turn actually runs without the user having to type.
- **`stall-recovery` fires post-stream**: after a stream has already ended cleanly but with no text and no tool calls
  (empty turn). Action: inject a follow-up nudge via `pi.sendMessage({ customType: 'stall-recovery-nudge', ... })`.
- **Composition**: a watchdog-aborted turn is classified `aborted` by pi, and `stall-recovery`'s classifier explicitly
  ignores `aborted` - which is what we want. The watchdog owns the follow-up for its own aborts so `stall-recovery` can
  keep its "don't second-guess a user Esc" invariant; the two extensions never double-fire a retry.

## Detection

On `message_start` (role=assistant) the extension records the start time, starts a `setInterval` poll (default every 5
s), and hands control to the pure helper [`stream-watchdog.ts`](../../../lib/node/pi/stream-watchdog.ts).

Every `message_update` bumps the state's `lastHeartbeat`. When the poll sees `now - lastHeartbeat >= stallMs`, the
stream is considered stalled and the entry is flagged. The notification latch lives inside the pure state so the poll
only fires **once per stream** - if the stream resumes and goes silent again, a fresh heartbeat clears the latch and the
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
4. Model streams normally → heartbeats keep it healthy; 300 s of silence aborts.

So the watchdog fundamentally can't fire while a tool is running, regardless of how long the tool takes.

## Recovery

When `autoAbort` is on (default), the poll calls `ctx.abort()` - the programmatic equivalent of pressing Esc. The
provider stream terminates, pi emits `agent_end` with `stopReason === 'aborted'`, and the agent loop yields back.

Because pi-agent-core's abort path `return`s from `runAgent` **before** the outer loop's follow-up drain, calling
`pi.sendMessage` synchronously from the poll timer would queue a follow-up that never actually runs. The watchdog
therefore latches a `pendingNudge` during the poll and delivers it from the subsequent `agent_end` handler. Pi 0.75.4
moved `agent_end` into the awaited agent lifecycle, so the handler now runs while the runtime still sees
`isStreaming === true`; the watchdog defers the actual `pi.sendMessage` to the next event-loop tick via `setImmediate`
and then uses `ctx.isIdle()` to pick between `{ triggerTurn: true }` (the common case, which actually fires a new turn)
and `{ deliverAs: 'followUp' }` (defensive fallback if the user typed during the defer window). The nudge is delivered
as a `custom` message (`customType: 'stream-watchdog-nudge'`) carrying the watchdog marker in content - pi's
convertToLlm serializes it as a synthetic `user` turn so the model sees identical content but the nudge does NOT pollute
the editor's up-arrow history. Sanity check: if the abort raced with a clean stream end (`toolUse` / `stop`), the nudge
is dropped rather than injected after a healthy turn.

Retries are capped per user prompt by `PI_STREAM_WATCHDOG_MAX_RETRIES` (default 2). On budget exhaustion the watchdog
still aborts the hung stream (so the UI unfreezes) but skips the auto-retry and surfaces a one-shot warning so you know
to intervene. The counter resets on a genuinely fresh idle user prompt and on any `agent_end` whose last assistant
message closed cleanly. Mid-stream user steers and queued follow-ups (pi >= 0.77.0, surfaced as
`InputEvent.streamingBehavior` of `"steer"` / `"followUp"`) do NOT reset the watchdog: the user is course-correcting the
same in-flight turn the watchdog is supposed to be watching, so tearing down the poll there would defeat its job. The
shared predicate is [`isFreshUserPrompt`](../../../lib/node/pi/input-event.ts).

With `PI_STREAM_WATCHDOG_ABORT=0` the watchdog surfaces a `ctx.ui.notify` warning but leaves the abort to you. Useful
while tuning `PI_STREAM_WATCHDOG_STALL_MS` against a noisy model - you can see how often the threshold would trigger
before committing to auto-abort.

## UI

While a stream is actively being watched:

- Healthy stream: no status line. The poll is running silently.
- Stall detected, `autoAbort` with retry budget available: `⟳ stream-watchdog: aborted after Ns of silence` on the
  footer, plus a `warning` notify with silent and total elapsed durations. On the subsequent `agent_end` the status
  flips to `⟳ stream-watchdog: retrying stalled turn (K/N)…` while the injected follow-up runs.
- Stall detected, `autoAbort` with budget exhausted:
  `⟳ stream-watchdog: aborted after Ns of silence (retry budget exhausted)` plus a one-shot `warning` notify asking the
  user to intervene.
- Stall detected, notify-only: `⟳ stream-watchdog: stream silent Ns` plus the equivalent notify.

Status is cleared on `message_end`, on a clean (non-aborted/non-error) `agent_end`, on real user input, and on session
boundaries.

## Environment variables

- `PI_STREAM_WATCHDOG_DISABLED=1` - skip the extension entirely.
- `PI_STREAM_WATCHDOG_STALL_MS=N` - silence threshold, ms. Default `300000` (5 min). Bump for genuinely slow
  local-inference setups if you see false positives; drop to `30000` for quick feedback during tuning.
- `PI_STREAM_WATCHDOG_POLL_MS=N` - poll interval, ms. Default `5000` (5 s). Trade-off: lower values catch hangs sooner
  but burn more timer ticks. 5 s is a reasonable compromise; there's no reason to go below 1 s.
- `PI_STREAM_WATCHDOG_ABORT=0` - notify only, don't auto-abort. Default is to auto-abort.
- `PI_STREAM_WATCHDOG_MAX_RETRIES=N` - consecutive auto-retries per user prompt after aborting a stalled stream. Default
  `2`. Set to `0` to disable the follow-up entirely (abort + notify only, like `stall-recovery`'s budget-exhausted
  state).
- `PI_STREAM_WATCHDOG_DEBUG=1` - emit a `ctx.ui.notify` on every `message_start` / `message_end` and on every stall
  decision. Useful for tuning; leave off in normal use.

## Hot reload

Edit [`extensions/stream-watchdog.ts`](./stream-watchdog.ts) or
[`lib/node/pi/stream-watchdog.ts`](../../../lib/node/pi/stream-watchdog.ts) and run `/reload` in an interactive pi
session.
