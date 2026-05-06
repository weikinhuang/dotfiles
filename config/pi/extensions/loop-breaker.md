# `loop-breaker.ts`

Detects when the model calls the same `(toolName, input)` repeatedly inside a short rolling window and nudges it off the
loop via a steering message. Primarily a safety net for small self-hosted models (qwen3-30B-A3B, gpt-oss-20B, …) that
re-run the same failing `bash` or re-`read` the same `(path, offset)` for 3+ consecutive turns before giving up or
asking the user.

## What it does

1. On every `tool_call`, compute a stable key for `(toolName, input)` via
   [`makeKey`](../../../lib/node/pi/loop-breaker.ts) and push it onto an in-memory ring buffer of recent calls.
2. [`pushAndCheck`](../../../lib/node/pi/loop-breaker.ts) returns `{ kind: 'repeat', count }` as soon as the same key
   has occurred `threshold` times inside the last `window` calls.
3. On trigger, the extension sends a synthesized steering message via
   `pi.sendMessage({ customType: 'loop-breaker-nudge', content: <nudge>, display: true }, { deliverAs: 'steer' })`. The
   `<nudge>` text is built by [`buildNudge`](../../../lib/node/pi/loop-breaker.ts) and tells the model to change
   approach — e.g. "read the file first", "grep for the symbol instead", "check the error message".
4. The ring buffer is cleared on trigger so call `N+1` while the model is pivoting doesn't retrigger the nudge.
5. The statusline footer shows `⟳ loop-breaker: steered (N repeats)` until the next reset.

Detection is strictly additive — the tool call itself is **not** blocked. Blocking interacts badly with
[`verify-before-claim.ts`](./verify-before-claim.md) / [`todo.ts`](./todo.md) guardrails and removes the "one more try
with different inputs" escape hatch.

## Reset triggers

The history clears (and the statusline key unsets) on:

- `session_start` — fresh session, fresh window.
- `input` where `event.source !== 'extension'` — a real user typed (or an RPC/API client sent) a new prompt. Messages
  synthesized by this extension don't reset the counter, to prevent replay scenarios from masking a real loop.
- `session_shutdown` — tidy on exit.

## Environment variables

- `PI_LOOP_BREAKER_DISABLED=1` — skip the extension entirely.
- `PI_LOOP_BREAKER_THRESHOLD=N` — repeats required to trigger (default `3`).
- `PI_LOOP_BREAKER_WINDOW=N` — rolling window size (default `6`). `threshold > window` is effectively "never fire".
- `PI_LOOP_BREAKER_DEBUG=1` — `ctx.ui.notify` every decision. Noisy; use while tuning.
- `PI_LOOP_BREAKER_TRACE=<path>` — append one line per decision to `<path>`. Useful in `-p` / RPC mode where `notify` is
  a no-op.

## Hot reload

Edit [`extensions/loop-breaker.ts`](./loop-breaker.ts) or
[`lib/node/pi/loop-breaker.ts`](../../../lib/node/pi/loop-breaker.ts) and run `/reload` in an interactive pi session to
pick up changes without restarting.
