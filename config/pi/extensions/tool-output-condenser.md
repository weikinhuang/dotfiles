# `tool-output-condenser.ts`

Tighter head+tail truncation for noisy tool results so large outputs don’t eat the session. Pi’s built-in `bash` tool
already caps at 50KB / 2000 lines to keep processes sane; this extension applies a tighter head+tail budget on top
(default 12KB / 400 lines, 80 head + 80 tail) so the model sees the useful part of each command’s output — invocation
banner and first errors on top, summary / exit banner / final error on the bottom — without the boilerplate middle.

The full output is stashed to a tempfile via `mkdtemp` + `writeFile`; the condensed text ends with a breadcrumb:

```text
⟨ [pi-tool-output-condenser] ⟩ bash output was condensed: kept 161 of 5000 lines (11.9KB of 210.4KB); omitted 4839
lines (198.5KB). Full output saved to: /tmp/pi-bash-condensed-XXXX/output.txt — re-read with the `read` tool
(`offset` / `limit`) if you need specific lines.
```

## Why it compounds

Smaller session ⇒ less frequent compaction ⇒ the [`todo`](./todo.md) / [`scratchpad`](./scratchpad.md) auto-injection
stays visible across more turns; the [`context-budget`](./context-budget.md) line stays in the neutral band longer. For
weak models chained across many bash calls this is one of the biggest per-turn wins available.

## Design notes

- Hooks `tool_result`, not `tool_call` — the command still executes with full output; only the **session-stored** copy
  is condensed.
- Only text content parts are touched; image parts pass through unchanged.
- Reuses pi’s existing `fullOutputPath` when the built-in bash tool already wrote one, so the model never sees two
  competing breadcrumbs.
- Records condenser metadata on `details.condenser` (`truncated`, `originalBytes`, `originalLines`, `outputBytes`,
  `outputLines`, `fullOutputPath`) for downstream renderers / debugging.
- Errors writing the tempfile log a `ctx.ui.notify` warning but **do not** block the result — the extension returns the
  condensed text without a breadcrumb rather than failing the tool call.

## Environment variables

- `PI_CONDENSER_DISABLED=1` — skip the extension entirely.
- `PI_CONDENSER_TOOLS=t1,t2,...` — comma list of tool names to condense (default `bash`; case-insensitive). Add `rg`,
  `grep`, or any custom tool that produces large text output.
- `PI_CONDENSER_MAX_BYTES=N` — byte cap on the condensed body (default `12288` = 12 KB; floor `512`).
- `PI_CONDENSER_MAX_LINES=N` — line cap on the condensed body (default `400`; floor `20`).
- `PI_CONDENSER_HEAD_LINES=N` — lines kept from the head (default `80`; floor `1`).
- `PI_CONDENSER_TAIL_LINES=N` — lines kept from the tail (default `80`; floor `1`).

## Hot reload

Edit [`extensions/tool-output-condenser.ts`](./tool-output-condenser.ts) or
[`lib/node/pi/output-condense.ts`](../../../lib/node/pi/output-condense.ts) and run `/reload` in an interactive pi
session.
