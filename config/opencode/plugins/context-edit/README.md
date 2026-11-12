# `context-edit`

Reclaim context window in opencode by collapsing finished tool output and dropping images, without touching the session
history. Ports the pi [`tool-collapse`](../../../pi/extensions/tool-collapse.md) and
[`context-trim`](../../../pi/extensions/context-trim.md) extensions into one plugin with three parts:
[`server.ts`](./server.ts) (overlay, model tools, RPC handlers), [`tui.tsx`](./tui.tsx) (the `/context-edit` picker),
and [`rpc.ts`](./rpc.ts) (the contract between them). Logic lives in
[`lib/node/opencode/context-edit.ts`](../../../../lib/node/opencode/context-edit.ts) and
[`context-edit-store.ts`](../../../../lib/node/opencode/context-edit-store.ts), on top of the shared pi core in
[`lib/node/pi/context-edit/`](../../../../lib/node/pi/context-edit/).

## Overlay model

Each edit is a directive stored per session in the plugin's `ctx.storage`. On every agent-loop request the session
`context` hook applies the directives to the outgoing messages only; the stored history, the transcript in the TUI, and
the files on disk are unchanged, so every edit is reversible. Directives survive opencode restarts.

- **Collapse** (tool pairs): the tool result becomes
  `⟨context-edit⟩ [TOOL CALLED <tool>] - ran; output removed from context[: reason]`. The call stays, so the provider
  still sees one result per call; its input is kept when it is at most 512 bytes (so the model knows what ran) and
  blanked to `{}` otherwise.
- **Trim** (images): the image part becomes `⟨context-edit⟩ [IMAGE REMOVED · ~size · "caption"]`. Covers images in tool
  results (for example `read` on a PNG) and images attached to user messages.
- Targets key on opencode's stable ids: the tool-call id (plus the index in the result content for an image) or the user
  message id (plus the Nth media part). A directive whose target left the context, for example after compaction, is a
  silent no-op and is listed as `[not in context]`.
- Placeholders depend only on the directive and the original content, so the same overlay renders the same bytes on
  every request and the prompt cache stays warm after the first changed request.

Provider-executed (hosted) tool calls are never collapsed, because their provider data replays with the call.

## `/context-edit`

One slash command (also in the command palette) opens a select dialog for the current session with three groups:

- **Active edits**, by directive `#id`. Selecting one restores it. `ctrl+r` restores all of them.
- **Collapse tool output**: tool pairs of at least `minBytes`, heaviest first, labelled with tool, lines, size, and a
  snippet.
- **Drop image**: every image in context, heaviest first.

Selecting a candidate edits it from the next request on, and a toast confirms. One command rather than pi's separate
`/context-collapse` and `/context-trim` because both edit kinds share one store, so listing, restoring, and clearing are
naturally one view, and a single heaviest-first list shows where the context actually went.

## Model tools

Two direct tools (`codemode: false`), the model-facing front door to the same store, so anything they change shows up in
`/context-edit`:

```text
collapse_output({ drop?: number[], keepRecent?: number, toolName?: string, reason?: string })
drop_image({ drop?: number[], keepRecent?: number, summary?: string, reason?: string })
```

- Targets are recency ordinals among the current candidates, most recent = `1`: `drop: [2]` is pointed, `keepRecent: N`
  drops everything older than the N newest. `toolName` narrows `collapse_output` to one tool; the plugin's own tools are
  never candidates.
- The most recent `tailGuard` candidates (default 1) are protected; a guarded ordinal is refused and reported.
- `drop_image`'s `summary` becomes the placeholder caption, so the model keeps a referent for the image.
- Each call runs `ctx.permission.assert` with action `context_edit` and the tool name as the resource (and saved
  pattern), so native permission rules apply. opencode's base policy (`* * allow`) would let a custom action through, so
  the plugin inserts `context_edit * ask` right after that base rule in every agent; configured rules and saved "Allow
  always" approvals still win. opencode's prompt for a custom action shows only `Call tool context_edit`, so the TUI
  part also shows a toast listing the resolved items while the prompt is open.

To skip the prompt for one tool:

```jsonc
{
  "permissions": [{ "action": "context_edit", "resource": "drop_image", "effect": "allow" }],
}
```

A `deny` rule for `context_edit` on `*` hides both tools.

## Options

Set options with a plugin entry in `opencode.jsonc` (see [Install](../README.md#install)). Every option also has an
`OPENCODE_CONTEXT_EDIT_*` environment override, which wins over the option. The TUI part has no options.

| Option         | Env override                          | Default | Effect                                                         |
| -------------- | ------------------------------------- | ------- | -------------------------------------------------------------- |
| `enabled`      | `OPENCODE_CONTEXT_EDIT_ENABLED`       | `true`  | `false` disables the plugin (stored edits stop applying).      |
| `tools`        | `OPENCODE_CONTEXT_EDIT_TOOLS`         | `true`  | Register `collapse_output` and `drop_image`.                   |
| `minBytes`     | `OPENCODE_CONTEXT_EDIT_MIN_BYTES`     | `2048`  | Smallest tool pair listed in `/context-edit`.                  |
| `snippetChars` | `OPENCODE_CONTEXT_EDIT_SNIPPET_CHARS` | `80`    | Snippet width in labels.                                       |
| `tailGuard`    | `OPENCODE_CONTEXT_EDIT_TAIL_GUARD`    | `1`     | Newest candidates the model tools refuse to drop.              |
| `debugFile`    | `OPENCODE_CONTEXT_EDIT_DEBUG_FILE`    | unset   | Log each request's overlay; dump it to `<debugFile>.last.txt`. |

With `debugFile` set, every agent-loop request appends one JSON line (`bytesBefore`, `bytesAfter`, `applied`, `stale`)
and rewrites `<debugFile>.last.txt` with one line per outgoing part, which shows exactly what the model received.

## Limitations

- Only the agent-loop `context` request is edited; compaction still summarizes the original content.
- No auto-collapse, no vision captioning of dropped images (the caption is the model's `summary` or nothing), and no
  message editing (pi's `message-edit`).
- Large text pasted into a user message is not a candidate; only tool output and images are.
- Two identical image attachments with the same mention in one message are deduplicated by opencode, which can shift the
  media ordinal of later images in that message.
- opencode watches only the plugin entry files; restart opencode after editing the `lib/node/` helpers.

## Live test

```bash
D="$(./dev/opencode-plugin-smoke.sh dir ce)"
./dev/opencode-plugin-smoke.sh start -n ce --size 140x40 -o "context-edit={\"debugFile\":\"$D/debug.log\"}" context-edit
./dev/opencode-plugin-smoke.sh send ce 'Run the bash command: seq 1 3000 | sed s/^/ZEBRA-/ and then reply DONE1'
./dev/opencode-plugin-smoke.sh wait ce '^ +DONE1'
./dev/opencode-plugin-smoke.sh send ce /context-edit   # then Enter on the shell result
./dev/opencode-plugin-smoke.sh keys ce Enter
./dev/opencode-plugin-smoke.sh send ce 'Reply DONE2'
tail -1 "$D/debug.log"; grep -c ZEBRA "$D/debug.log.last.txt"   # bytesAfter drops; 1 match (the prompt)
./dev/opencode-plugin-smoke.sh stop ce
```

For `collapse_output` / `drop_image`, ask the model to call the tool with `drop: [2]` after two tool calls (or two
`read`s of image files). The permission prompt appears by default.
