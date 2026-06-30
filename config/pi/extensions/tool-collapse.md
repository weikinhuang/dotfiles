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

## Agent tool: `collapse_output`

The model can collapse tool output it is finished with by calling **`collapse_output`**, a second front door to the same
directive store as `/context-collapse` - so anything the model collapses is listed by `/context-collapse list` and
reversible with `/context-collapse restore`. It targets **tool call+result pairs only** (never user messages or
assistant text), and every call is gated by a per-call confirmation prompt.

```text
collapse_output({
  drop?: number[],     // pointed: recency ordinals among current pairs (1 = most recent), e.g. [2]
  keepRecent?: number, // batch / lump-sum: collapse every pair beyond the most recent N
  toolName?: string,   // optional filter: only consider pairs from this tool (e.g. "bash")
  reason?: string,     // why you are done; shown in the dialog + stored for audit
})
```

- **Recency-ordinal addressing.** Pairs are addressed by recency among the collapsible pairs currently in context,
  most-recent = `1`. `drop: [2]` is the pointed form; `keepRecent: N` is the batch / lump-sum form. `toolName` narrows
  the candidate set to one tool first.
- **Reversible, nothing deleted.** Same overlay as a manual collapse: the call+result are replaced by a `[TOOL CALLED]`
  marker, the transcript `.jsonl` is untouched, and `restore` brings them back.
- **Tail-guard.** The most-recent `N` pairs (default `1`, `PI_TOOL_COLLAPSE_DROP_TAIL_GUARD`) can never be collapsed; a
  `drop` ordinal inside the guard is refused and reported back, and `keepRecent` is clamped up to the guard.
- **Lump-sum framing.** The description tells the model to collapse a finished batch, not to nibble one stale result per
  turn (nibbling re-pays the prefix-cache premium every turn).

### Confirmation prompt

Each `collapse_output` call reuses the shared approval engine
([`lib/node/pi/approval-prompt.ts`](../../../lib/node/pi/approval-prompt.ts)) exactly as `bash-permissions` does, with
the same six options as [`drop_image`](./context-trim.md#confirmation-prompt) (Allow once / Allow `collapse_output` for
this session / Edit selection… / Deny / Deny with feedback… / Never allow this session). The dialog title echoes the
resolved pairs (recency ordinal + label + size) so you verify targeting before anything collapses. Session decisions are
an in-memory flag cleared on `session_shutdown`; with no UI the call falls back to `PI_CONTEXT_TRIM_DROP_DEFAULT`
(default `deny`, shared with `drop_image`).

## Environment variables

- `PI_TOOL_COLLAPSE_DISABLED=1` - skip the extension entirely.
- `PI_TOOL_COLLAPSE_DISABLE_AUTO=1` - keep manual collapse, turn off auto-collapse.
- `PI_TOOL_COLLAPSE_MIN_BYTES=N` - minimum result size offered for manual collapse (default `2048`).
- `PI_TOOL_COLLAPSE_SNIPPET_CHARS=N` - snippet width in listings (default `80`).
- `PI_TOOL_COLLAPSE_AUTO_AFTER_TURNS=N` - auto-collapse results `N` assistant-turns old (`0` = off).
- `PI_TOOL_COLLAPSE_AUTO_MIN_BYTES=N` - auto-collapse only results at least `N` bytes (default `4096`).
- `PI_TOOL_COLLAPSE_BACKGROUND_TOOLS=a,b,c` - override the background-tool name list used for the `[background]` hint
  (default `comfyui,generate_image,bg_bash`).
- `PI_TOOL_COLLAPSE_DROP_TAIL_GUARD=N` - how many of the most-recent pairs `collapse_output` refuses to collapse
  (default `1`).
- `PI_CONTEXT_TRIM_DROP_DEFAULT=allow|deny` - non-interactive fallback for the `collapse_output` confirmation when there
  is no UI (default `deny`; shared with `drop_image`).

## Config file

`minTextBytes`, `snippetChars`, `autoAfterTurns`, and `autoMinBytes` also layer through `tool-collapse.json` (project
`<cwd>/.pi/tool-collapse.json` wins over user `<piAgentDir>/tool-collapse.json`, which wins over the env knobs).

## Hot reload

Edit [`extensions/tool-collapse.ts`](./tool-collapse.ts) or the core under
[`lib/node/pi/context-edit/`](../../../lib/node/pi/context-edit) and run `/reload` in an interactive pi session.
