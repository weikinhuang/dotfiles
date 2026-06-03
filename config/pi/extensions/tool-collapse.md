# `tool-collapse.ts`

Collapse a finished or fire-and-forget tool call and its result down to a `[TOOL CALLED - reason]` marker, to reclaim
context (the canonical case: a background comfyui job whose result the agent never needed). One of three extensions on
the shared context-edit core ([`lib/node/pi/context-edit/`](../../../lib/node/pi/context-edit)); siblings are
[`context-trim.ts`](./context-trim.md) (remove bulky content) and [`message-edit.ts`](./message-edit.md) (edit a message
in place). See [`context-trim.md`](./context-trim.md) for the shared non-destructive overlay model.

Collapsing blanks the call's `arguments` AND replaces the paired tool result with the marker, keeping the call/result
pairing valid for the provider. Manual collapses are persisted and survive `/reload` and exit then resume; `restore`
brings the original back.

## Commands

- `/context-collapse` - list collapsible tool calls, heaviest first, with a `[background]` hint for fire-and-forget
  tools. Each carries a handle (`call2`, `tool3`).
- `/context-collapse <handle> [reason]` - collapse that call and its result. **The handles also appear in the argument
  autocomplete menu** (annotated with size, snippet, and the `[background]` hint), so you can pick the call directly.
- `/context-collapse list` - show active manual collapses by directive `#id`.
- `/context-collapse restore <#id>` - undo one collapse.
- `/context-collapse clear` - undo all manual collapses.
- `/context-collapse help` (or `--help` / `-h` / `?`) - print usage.

## Optional auto-collapse

Off by default. When `PI_TOOL_COLLAPSE_AUTO_AFTER_TURNS` (or the config file) is greater than `0`, tool results that are
both that many assistant-turns old **and** at least `autoMinBytes` in size are collapsed **transiently** on every turn.

Auto-collapse is a policy, not a user decision, so it is derived fresh each turn and **never persisted**: there is
nothing to `restore`. To stop it, lower `PI_TOOL_COLLAPSE_AUTO_AFTER_TURNS` back to `0` (or set
`PI_TOOL_COLLAPSE_DISABLE_AUTO=1`). Manual collapses always take precedence and are never double-applied.

## Environment variables

- `PI_TOOL_COLLAPSE_DISABLED=1` - skip the extension entirely.
- `PI_TOOL_COLLAPSE_DISABLE_AUTO=1` - keep manual collapse, turn off auto-collapse.
- `PI_TOOL_COLLAPSE_MIN_BYTES=N` - minimum result size offered for manual collapse (default `2048`).
- `PI_TOOL_COLLAPSE_SNIPPET_CHARS=N` - snippet width in listings (default `80`).
- `PI_TOOL_COLLAPSE_AUTO_AFTER_TURNS=N` - auto-collapse results `N` assistant-turns old (`0` = off).
- `PI_TOOL_COLLAPSE_AUTO_MIN_BYTES=N` - auto-collapse only results at least `N` bytes (default `4096`).
- `PI_TOOL_COLLAPSE_BACKGROUND_TOOLS=a,b,c` - override the background-tool name list used for the `[background]` hint
  (default `comfyui,generate_image,bg_bash`).

## Config file

`minTextBytes`, `snippetChars`, `autoAfterTurns`, and `autoMinBytes` also layer through `tool-collapse.json` (project
`<cwd>/.pi/tool-collapse.json` wins over user `<piAgentDir>/tool-collapse.json`, which wins over the env knobs).

## Hot reload

Edit [`extensions/tool-collapse.ts`](./tool-collapse.ts) or the core under
[`lib/node/pi/context-edit/`](../../../lib/node/pi/context-edit) and run `/reload` in an interactive pi session.
