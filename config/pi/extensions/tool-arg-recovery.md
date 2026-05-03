# `tool-arg-recovery.ts`

Targeted recovery block for TypeBox validation failures — the `edit-recovery`-style pattern applied to every tool call,
not just `edit`.

When the LLM emits a tool call whose arguments don’t match the tool’s TypeBox schema, pi-ai’s `validateToolArguments`
throws a canonical message (`Validation failed for tool "X":\n  - <path>: <message>\n\nReceived arguments: {...}`),
which pi wraps via `createErrorToolResult(error.message)`. Small self-hosted models read that raw error, guess at a fix,
and retry with the same wrong shape — because the error tells them WHAT’s wrong but not what a working payload looks
like.

This extension intercepts `tool_result` on validation failures, cross-references the tool’s schema via
`pi.getAllTools()`, and appends a second text part with:

- each failed argument path (e.g. `` `items.0.body` ``)
- the rule that was violated (e.g. `Expected string`)
- a short description of the expected type (`number`, `"list" | "add" | "start"`, `object[]`, …)
- a short description of what was received (`` `"1"` (string)``, `` `{…}` (object)``)
- a concrete corrected-example JSON payload when a schema is available (placeholders like `<string>` / `0` where the
  model still has to supply real values)
- a “do not retry with the same arguments” footer

Pi’s original error stays intact at index 0; the recovery block is appended as a second text part, matching
[`extensions/edit-recovery.ts`](./edit-recovery.ts)’s composition pattern. No auto-retry — surfacing the mistake keeps
[`verify-before-claim`](./verify-before-claim.md), [`loop-breaker`](./loop-breaker.ts), and
[`stall-recovery`](./stall-recovery.md) honest.

Example output for a `todo` call with `id: "1"` (string instead of number):

```text
⚠ [pi-tool-arg-recovery] tool=todo

Problems with the arguments:
  - `id`: Expected number. expected number. got `"1"` (string).
```

Corrected example (replace placeholders, then retry):

```json
{
  "action": "start",
  "id": 0
}
```

Do NOT retry with the same arguments. Fix the types/fields above, then call the tool again with a corrected payload.

## Environment variables

- `PI_TOOL_ARG_RECOVERY_DISABLED=1` — skip the extension entirely.
- `PI_TOOL_ARG_RECOVERY_DEBUG=1` — `ctx.ui.notify` on every decision.
- `PI_TOOL_ARG_RECOVERY_TRACE=<path>` — append one line per decision to `<path>` (useful in `-p` / RPC mode).
- `PI_TOOL_ARG_RECOVERY_MAX_EXAMPLE_CHARS=N` — cap on the serialized corrected example (default `1500`). Past the cap
  the fenced block is omitted; the diagnosis still renders.

## Hot reload

Edit [`extensions/tool-arg-recovery.ts`](./tool-arg-recovery.ts) or
[`lib/node/pi/tool-arg-recovery.ts`](../../../lib/node/pi/tool-arg-recovery.ts) and run `/reload` in an interactive pi
session.
