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
- `/context-trim <handle> [reason]` - add a trim. From the next turn the targeted content renders as
  `[IMAGE REMOVED · …]` or `[CONTENT TRIMMED - N lines, X KB]` with the optional reason appended. **The handles also
  appear directly in the argument autocomplete menu** (Tab / type the first character), each annotated with its size and
  a content snippet, so you can pick the right image without first reading the printed list.
- `/context-trim list` - show active trims by their directive `#id`.
- `/context-trim restore <#id>` - undo one trim.
- `/context-trim clear` - undo all trims.
- `/context-trim help` (or `--help` / `-h` / `?`) - print usage.

Handles (`img1` ...) are assigned per listing and are not stable across turns; the stored directive keys off the
content's stable target (`toolCallId`, or `role`+`timestamp`), so it keeps resolving as the conversation grows. A
directive whose target no longer resolves (e.g. compacted away) becomes a silent no-op.

## Image descriptions

Trimming an image is **lossy compression, not deletion**: the placeholder keeps a short caption of what the image
depicted so the model still has the "it" referent ("make it bluer") and never re-runs an image tool just to look again.
The placeholder is byte-stable and embeds dimensions + size + the caption inside the brackets:

```text
⟨pi-context-edit⟩ [IMAGE REMOVED · 1024×1024 · ~1.20MB · "a red fox in snow, cinematic lighting"]
```

The caption is computed **once, at trim time**, and persisted in the directive so it is stamped into the placeholder
every turn without ever recomputing. Recomputing inside the `context` hook would fire a vision call per turn and produce
non-deterministic bytes that permanently break prefix caching, so it is never done there. The caption is sourced in
priority order:

1. **Agent-supplied summary** - when an agent-driven drop hands over a summary (a future `drop_image({ summary })` seam;
   unused today). Free and accurate.
2. **Generation prompt** - for `comfyui` / `generate_image` results, the positive prompt that produced the image is
   reused as the caption. Free, covers most of this repo's image traffic.
3. **Auto-caption** - a single vision pass via the [`image-captioner`](../agents/image-captioner.md) subagent
   (`runOneShotAgent`, disk-backed transcript), used only when sources 1 and 2 are both empty (e.g. a `read` of an image
   file). The captioning model is the **active model if it is vision-capable**, else the `captionModel` config override
   below; if neither is available the description is **skipped** (size-only placeholder). The caption is length-capped
   (~150 tokens) - lossy, not a transcript.

## Environment variables

- `PI_CONTEXT_TRIM_DISABLED=1` - skip the extension entirely.
- `PI_CONTEXT_TRIM_MIN_BYTES=N` - minimum text-part size offered for trimming (default `2048`).
- `PI_CONTEXT_TRIM_SNIPPET_CHARS=N` - snippet width in listings (default `80`).
- `PI_CONTEXT_TRIM_CAPTION_MODEL=provider/id` - vision model used to auto-caption a trimmed image when the active model
  is text-only (lowest-priority layer; the `captionModel` config key below overrides it).

## Config file

Thresholds and the caption model layer through `context-trim.json` (project `<cwd>/.pi/context-trim.json` wins over user
`<piAgentDir>/context-trim.json`, which wins over the env knobs above), per the config-layering convention. Keys:
`minTextBytes`, `snippetChars`, `captionModel`.

```jsonc
// <cwd>/.pi/context-trim.json
{
  "minTextBytes": 2048,
  "snippetChars": 80,
  // provider/id of a vision model to caption dropped images when the
  // active model can't see images; omit to use the active model (when
  // vision-capable) or skip the caption entirely.
  "captionModel": "anthropic/claude-haiku-4-5",
}
```

## Hot reload

Edit [`extensions/context-trim.ts`](./context-trim.ts) or the core under
[`lib/node/pi/context-edit/`](../../../lib/node/pi/context-edit) and run `/reload` in an interactive pi session.
