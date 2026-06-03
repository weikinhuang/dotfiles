# `context-trim.ts`

Remove large or bulky content from the model's context, replaced by a short placeholder, to reclaim context window. One
of three extensions built on the shared context-edit core
([`lib/node/pi/context-edit/`](../../../lib/node/pi/context-edit)); the siblings are
[`message-edit.ts`](./message-edit.md) (edit a message in place) and [`tool-collapse.ts`](./tool-collapse.md) (collapse
a tool call and its result).

## Non-destructive overlay model

All three context-edit extensions apply an **overlay** in the `context` hook, which fires before every LLM call with a
deep copy of the message list. They never touch the session `.jsonl`:

- The original content stays recorded. Trimming an image in the middle of a long session keeps every later turn intact
  (pi's append-only branching would instead delete everything downstream, which is why an overlay is used).
- The overlay is reapplied every turn and reconstructed from a persisted `custom` session entry on `session_start`, so
  **trims survive `/reload` AND exit then resume**. They are persistent steering, not one-shots, until you `restore`
  them.
- `restore` brings the original back. Nothing is ever actually deleted.

Files are not a special case: pi has no PDF or document content type. The `read` tool turns an image-mimetype file into
an image part and everything else (including extracted PDF text) into a text part, so "trim a file" is always "trim an
image part or an oversized text part".

## Commands

- `/context-trim` - list trimmable candidates, heaviest first: images, tool results over a size threshold, and long
  user/assistant messages. Each carries a short handle (`img1`, `tool3`, `msg2`).
- `/context-trim <handle> [reason]` - add a trim. From the next turn the targeted content renders as `[IMAGE REMOVED]`
  or `[CONTENT TRIMMED - N lines, X KB]` with the optional reason appended. **The handles also appear directly in the
  argument autocomplete menu** (Tab / type the first character), each annotated with its size and a content snippet, so
  you can pick the right image without first reading the printed list.
- `/context-trim list` - show active trims by their directive `#id`.
- `/context-trim restore <#id>` - undo one trim.
- `/context-trim clear` - undo all trims.
- `/context-trim help` (or `--help` / `-h` / `?`) - print usage.

Handles (`img1` ...) are assigned per listing and are not stable across turns; the stored directive keys off the
content's stable target (`toolCallId`, or `role`+`timestamp`), so it keeps resolving as the conversation grows. A
directive whose target no longer resolves (e.g. compacted away) becomes a silent no-op.

## Environment variables

- `PI_CONTEXT_TRIM_DISABLED=1` - skip the extension entirely.
- `PI_CONTEXT_TRIM_MIN_BYTES=N` - minimum text-part size offered for trimming (default `2048`).
- `PI_CONTEXT_TRIM_SNIPPET_CHARS=N` - snippet width in listings (default `80`).

## Config file

Thresholds also layer through `context-trim.json` (project `<cwd>/.pi/context-trim.json` wins over user
`<piAgentDir>/context-trim.json`, which wins over the env knobs above), per the config-layering convention. Keys:
`minTextBytes`, `snippetChars`.

## Hot reload

Edit [`extensions/context-trim.ts`](./context-trim.ts) or the core under
[`lib/node/pi/context-edit/`](../../../lib/node/pi/context-edit) and run `/reload` in an interactive pi session.
