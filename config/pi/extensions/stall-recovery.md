# `stall-recovery.ts`

Auto-retry when an agent turn ends without producing meaningful work. Aimed at weaker local models that stop mid-task
and transport / provider failures that leave the session mid-stride. Companion to [`todo.ts`](./todo.md) - both fire on
`agent_end`, but the two handle orthogonal failure modes and never double-fire on the same turn:

|              | `stall-recovery` fires when…                                                                                      | `todo` guardrail fires when…                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Signal       | Turn produced **no** text and no tool calls, **or** the turn has an explicit error.                               | Turn produced text that reads like a "done" sign-off, **and** open todos still exist. |
| Failure mode | Model stopped silently; provider errored.                                                                         | Model claimed completion prematurely.                                                 |
| Composition  | Fresh turn triggered via `sendUserMessage`; `todo`'s `before_agent_start` injection re-anchors the plan for free. | Prompts the model to finish / `block` the open items.                                 |

## Detection

On `agent_end`, the extension extracts the last assistant message from `event.messages` and classifies it via
[`classifyAssistant()`](../../../lib/node/pi/stall-detect.ts). Detection is deliberately conservative:

1. **`empty`** - trimmed text is empty **and** no tool calls were issued in the final assistant message. This catches
   the canonical "model just stopped" case: weak locals that emit a stop token too early, reasoning models whose
   thinking phase completes without emitting content, mid-stream transport errors that leave the assistant message
   empty.
2. **`error`** - the assistant message (or event) carries an explicit error string. Covers rate limits, timeouts, and
   structured provider failures that surface via `event.messages` rather than throwing.

Hedging / punting text ("I'll look into that.") is deliberately **not** detected: the false-positive rate is too high.
If the model produces any substantive text or tool call, we trust it.

## Recovery

A follow-up user message is injected via `pi.sendUserMessage(..., { deliverAs: 'followUp' })` carrying a sentinel marker
(`⟳ [pi-stall-recovery]`). The message is short and directive - weaker models respond better to concrete instructions
than vague ones - and escalates in tone on the final allowed attempt (see "Retry prompt escalation" below).

The retry triggers a fresh agent turn; any `before_agent_start` handlers (like the todo extension's active-plan
injection) run automatically, re-anchoring the model. If the retry happens to be the call that fires
`stripThinkingFromStalledTurns` (see "Thinking-strip on retry" below), the provider receives a conversation with the
stalled turn's `thinking` blocks removed - forcing a fresh reasoning pass on the imperative prompt.

## Retry budget

Stateless, derived from the message history on every `agent_end`. The pure helper
[`countTrailingStalls()`](../../../lib/node/pi/stall-detect.ts) walks `event.messages` backwards from the end and counts
consecutive stalled assistant turns, using these rules:

- An `assistant` turn that classifies as a stall → `count++`, keep walking.
- An `assistant` turn that is healthy (text or tool call) → **stop**. Any intermediate successful turn in a multi-step
  agent loop resets the budget automatically.
- A `user` message carrying our sentinel (`⟳ [pi-stall-recovery]`) → our own nudge; transparent, keep walking.
- A `user` message **without** the sentinel → a real user prompt; **stop**. This scopes the counter to the current
  prompt without any in-memory state.
- `toolResult` and other roles → transparent; keep walking.

The retry fires while `1 ≤ count ≤ maxRetries` (default `maxRetries=2`, i.e., two retries per prompt). When
`count > maxRetries` the budget is exhausted:

- `ctx.ui.notify(...)` surfaces a one-shot warning:
  `"Agent stalled N time(s) in a row (<detail>). Auto-retry paused - type to continue manually."`
- The retry status is cleared from the footer.
- The extension stops firing until a real user prompt arrives (tracked by a single boolean, cleared in the `input`
  handler).

The previous in-memory counter lost track of intermediate successes within an agent loop (those don't fire `agent_end`),
which caused false "budget exhausted" notifications when a multi-step run happened to end with its first stall. The
stateless counter fixes this - and makes reload-mid-stall correct for free, since it's reconstructed from the session
history instead of volatile memory.

Loop prevention is layered: the sentinel alone would bound retries (any `user` carrying it is transparent to the walk,
so the count can never exceed the number of actual stalls), and the `input` handler additionally ignores any real prompt
that echoes the sentinel - defense against replay scenarios.

## Retry prompt escalation

The nudge tone escalates with the attempt number:

- **Attempt 1 (gentle).** "Your previous turn produced no output. The task is not complete. Continue where you left off
  - review any active todos, check the last tool result if there was one, and produce either the next tool call or the
    final answer for the user."
- **Final attempt (imperative).** "Your previous N turn(s) produced ZERO output - no text, no tool calls. You MUST emit
  content this turn: either a concrete tool_use block or a final text answer for the user. Do NOT return another empty
  response. Do NOT spend the whole turn in extended thinking. If you have genuinely nothing to do, say so explicitly in
  a short text block - silence is not an acceptable answer."

Reasoning models that stalled on the gentle prompt will often re-enter the same rumination when asked the same way; the
imperative wording is different enough to shift the strategy.

## Thinking-strip on retry

Registered on the `context` event, which fires before every LLM call. When the pending request ends with one of our
retry nudges (detected via `STALL_MARKER`), [`stripThinkingFromStalledTurns()`](../../../lib/node/pi/stall-detect.ts)
removes `thinking` content blocks from every trailing stalled assistant turn in the window. Runs as a no-op on every
other call (healthy turns, normal prompts, tool-result round-trips).

Rationale: extended-thinking providers (Claude w/ `thinkingSignature`, local Qwen3, etc.) replay the prior assistant's
`thinking` blocks verbatim. If the last turn stalled because the model spent its whole output budget on rumination, the
replay re-seeds the same rumination on the retry and it stalls again. Dropping the `thinking` blocks forces a fresh
reasoning pass over the (now imperative) user nudge.

Safety:

- Only trailing **stalled** assistants are touched. Healthy assistants inside the window are a hard boundary and their
  `thinking` is preserved verbatim - it's legitimate reasoning attached to successful output.
- Stalled turns by definition emitted no text and no tool calls. Dropping their `thinking` blocks removes nothing the
  conversation depends on - Anthropic's `thinkingSignature` continuity is only required when the next turn responds to a
  `tool_use`, which an empty stall never has.
- If stripping would leave an assistant message with zero content blocks, a single empty-text block is substituted so
  the conversation structure stays provider-valid.

## UI

While a retry is in flight, the footer shows:

```text
⟳ Auto-retrying stalled turn (1/2)…
```

Rendered by [`statusline.ts`](./statusline.md) on the third line alongside other extension statuses. Cleared when the
next turn produces meaningful work.

## Environment variables

- `PI_STALL_RECOVERY_DISABLED=1` - skip the extension entirely.
- `PI_STALL_RECOVERY_MAX_RETRIES=N` - consecutive retries allowed per user prompt (default `2`). `N=0` disables the
  retry loop (the classifier still runs and the first stall triggers a notify).
- `PI_STALL_RECOVERY_VERBOSE=1` - emit a `ctx.ui.notify` on every detection + retry decision. Useful for tuning when
  running against a noisy local model.

## Hot reload

Edit [`extensions/stall-recovery.ts`](./stall-recovery.ts) or
[`lib/node/pi/stall-detect.ts`](../../../lib/node/pi/stall-detect.ts) and run `/reload` in an interactive pi session.
