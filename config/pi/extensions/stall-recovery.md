# `stall-recovery.ts`

Auto-retry when an agent turn ends without producing meaningful work. Aimed at weaker local models that stop mid-task
and transport / provider failures that leave the session mid-stride. Companion to [`todo.ts`](./todo.md) — both fire on
`agent_end`, but the two handle orthogonal failure modes and never double-fire on the same turn:

|              | `stall-recovery` fires when…                                                                                      | `todo` guardrail fires when…                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Signal       | Turn produced **no** text and no tool calls, **or** the turn has an explicit error.                               | Turn produced text that reads like a "done" sign-off, **and** open todos still exist. |
| Failure mode | Model stopped silently; provider errored.                                                                         | Model claimed completion prematurely.                                                 |
| Composition  | Fresh turn triggered via `sendUserMessage`; `todo`'s `before_agent_start` injection re-anchors the plan for free. | Prompts the model to finish / `block` the open items.                                 |

## Detection

On `agent_end`, the extension extracts the last assistant message from `event.messages` and classifies it via
[`classifyAssistant()`](../../../lib/node/pi/stall-detect.ts). Detection is deliberately conservative:

1. **`empty`** — trimmed text is empty **and** no tool calls were issued in the final assistant message. This catches
   the canonical "model just stopped" case: weak locals that emit a stop token too early, reasoning models whose
   thinking phase completes without emitting content, mid-stream transport errors that leave the assistant message
   empty.
2. **`error`** — the assistant message (or event) carries an explicit error string. Covers rate limits, timeouts, and
   structured provider failures that surface via `event.messages` rather than throwing.

Hedging / punting text ("I'll look into that.") is deliberately **not** detected: the false-positive rate is too high.
If the model produces any substantive text or tool call, we trust it.

## Recovery

A follow-up user message is injected via `pi.sendUserMessage(..., { deliverAs: 'followUp' })` carrying a sentinel marker
(`⟳ [pi-stall-recovery]`). The message is short and directive — weaker models respond better to concrete instructions
than vague ones:

- **Empty stall** → "Your previous turn produced no output. The task is not complete. Continue where you left off —
  review any active todos, check the last tool result if there was one, and produce either the next tool call or the
  final answer for the user."
- **Error stall** → "Your previous turn failed with: `<error>`. Retry the same approach, or try a different one if the
  error suggests the approach was wrong."

The retry triggers a fresh agent turn; any `before_agent_start` handlers (like the todo extension's active-plan
injection) run automatically, re-anchoring the model.

## Retry budget

In-memory per-prompt counter. Default max = 2 consecutive retries per user prompt. Reset on the `input` event when the
source is **not** `extension` — i.e., a real user typed (or an RPC/API client sent) a new prompt. Synthesized messages
from this extension don't reset the counter.

When the budget is exhausted:

- `ctx.ui.notify(...)` surfaces a warning:
  `"Agent stalled N time(s) in a row (<detail>). Auto-retry paused — type to continue manually."`
- The retry status is cleared from the footer.
- The extension stops firing until the user sends a real prompt.

Loop prevention is layered: the budget alone would bound retries, but the `input` handler additionally ignores any
prompt that itself carries the stall marker (defense against replay scenarios).

## UI

While a retry is in flight, the footer shows:

```text
⟳ Auto-retrying stalled turn (1/2)…
```

Rendered by [`statusline.ts`](./statusline.md) on the third line alongside other extension statuses. Cleared when the
next turn produces meaningful work.

## Environment variables

- `PI_STALL_RECOVERY_DISABLED=1` — skip the extension entirely.
- `PI_STALL_RECOVERY_MAX_RETRIES=N` — consecutive retries allowed per user prompt (default `2`). `N=0` disables the
  retry loop (the classifier still runs and the first stall triggers a notify).
- `PI_STALL_RECOVERY_VERBOSE=1` — emit a `ctx.ui.notify` on every detection + retry decision. Useful for tuning when
  running against a noisy local model.

## Hot reload

Edit [`extensions/stall-recovery.ts`](./stall-recovery.ts) or
[`lib/node/pi/stall-detect.ts`](../../../lib/node/pi/stall-detect.ts) and run `/reload` in an interactive pi session.
