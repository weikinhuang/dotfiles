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

1. **Agent-supplied summary** - when an agent-driven drop hands over a summary (the `drop_image({ summary })` arg). Free
   and accurate.
2. **Generation prompt** - for `comfyui` / `generate_image` results, the positive prompt that produced the image is
   reused as the caption. Free, covers most of this repo's image traffic.
3. **Auto-caption** - a single vision pass via the [`image-captioner`](../agents/image-captioner.md) subagent
   (`runOneShotAgent`, disk-backed transcript), used only when sources 1 and 2 are both empty (e.g. a `read` of an image
   file). The captioning model is the **active model if it is vision-capable**, else the `captionModel` config override
   below; if neither is available the description is **skipped** (size-only placeholder). The caption is length-capped
   (~150 tokens) - lossy, not a transcript.

## Non-vision image strip (derived policy)

When the **active model is text-only** (`isVisionCapable(model)` is false -
`(model.input ?? ["text"]).includes("image")` is the only signal, read straight from pi's model registry, no oracle
table), every image in context is pure dead weight: the model cannot read it, so it is wasted tokens at best and a
provider error at worst. So context-trim blanks **all** images to the same `[IMAGE REMOVED · …]` placeholder.

This is a **derived policy**, like `tool-collapse`'s `auto-collapse`, not a persisted directive:

- It is recomputed **fresh every turn** in the `context` hook from the active model's vision capability and **never
  persisted** - there is nothing to `restore`.
- Vision capability is tracked from `ctx.model` on `session_start` / `session_tree` and from `event.model` on
  `model_select`. Switching **to** a text-only model strips images next turn; switching **back** to a vision model stops
  deriving the strip, so the images **reappear** automatically (non-destructive, matching `auto-collapse`'s semantics).
- It runs as a second pass **on top of** the manual persisted trims, on the already-overlaid message list. An image a
  human already `/context-trim`med is already a placeholder, so it is naturally skipped - the manual directive and the
  derived strip stack cleanly and produce the same placeholder.
- Descriptions use the **free** subset of the sourcing above: generated images (`comfyui` / `generate_image`) keep their
  generation prompt as the caption; an un-described observed image strips to a **size-only** placeholder. There is no
  vision auto-caption on this path - it would fire a vision call per turn and break prefix caching, and the active model
  is text-only anyway.

Disable with `PI_CONTEXT_TRIM_DISABLE_STRIP=1` (keeps manual `/context-trim` and `drop_image`).

## Agent tool: `drop_image`

The model can shed images it is finished with by calling **`drop_image`**, a second front door to the same directive
store as `/context-trim` - so anything the model drops is listed by `/context-trim list` and reversible with
`/context-trim restore`. It targets **images only** (never user messages or assistant text), and every call is gated by
a per-call confirmation prompt.

```text
drop_image({
  drop?: number[],     // pointed: recency ordinals among current images (1 = most recent), e.g. [2]
  keepRecent?: number, // batch / lump-sum: drop every image beyond the most recent N
  summary?: string,    // one-line description of what the image showed -> placeholder caption (source 1)
  reason?: string,     // why you are done; shown in the dialog + stored for audit
})
```

- **Recency-ordinal addressing.** Images are addressed by recency among the images currently in context, most-recent =
  `1`. `drop: [2]` is the pointed form ("two images this turn, keep the one I am iterating on"); `keepRecent: N` is the
  batch / lump-sum form (drop everything older than the most recent N). The two combine (union).
- **Reversible, nothing deleted.** The drop is the same overlay as a manual trim: the transcript `.jsonl` and the image
  file on disk are untouched, and the tool description says so. The `summary` flows in as **source 1** of the image
  caption (see above), so the placeholder stays informative.
- **Tail-guard.** The most-recent `N` images (default `1`, `PI_CONTEXT_TRIM_DROP_TAIL_GUARD`) can never be dropped - the
  model is likely still working with them, and dropping near the tail is the only cache-cheap drop, so a large guard
  would force cache-hostile long-suffix drops. A `drop` ordinal inside the guard is refused and reported back to the
  model; `keepRecent` is clamped up to the guard.
- **Lump-sum framing.** The description tells the model to drop a batch when it is done, not to tidy one stale image per
  turn (nibbling re-pays the prefix-cache premium every turn).

### Confirmation prompt

Each `drop_image` call reuses the shared approval engine
([`lib/node/pi/approval-prompt.ts`](../../../lib/node/pi/approval-prompt.ts)) exactly as `bash-permissions` does. The
dialog title echoes the **resolved** items (recency ordinal + label + size + the `summary`) so you verify targeting
before anything drops, plus any tail-guarded / out-of-range ordinals. Options:

- **Allow once** - drop this selection, ask again next time.
- **Allow `drop_image` for this session** - auto-allow for the rest of the session.
- **Edit selection…** - open a checkbox multi-select of the resolved images (every row pre-checked = will drop); uncheck
  the keeper before confirming. Built on the reusable [`MultiSelectList`](../../../lib/node/pi/ext/multi-select-list.ts)
  component.
- **Deny** - do not drop, ask again.
- **Deny with feedback…** - do not drop; the feedback text is returned to the model so it can adjust.
- **Never allow this session** - auto-deny for the rest of the session.

Session decisions (`allow` / `never` for the session) are an in-memory flag in the extension closure, cleared on
`session_shutdown` (so `/reload` and a real session end both force re-confirmation). In a **non-interactive** context
(print / RPC / autonomous, no UI) there is no dialog, so the call falls back to `PI_CONTEXT_TRIM_DROP_DEFAULT` (default
`deny`).

## Environment variables

- `PI_CONTEXT_TRIM_DISABLED=1` - skip the extension entirely.
- `PI_CONTEXT_TRIM_DISABLE_STRIP=1` - keep manual trim + `drop_image`, disable the derived non-vision image strip.
- `PI_CONTEXT_TRIM_MIN_BYTES=N` - minimum text-part size offered for trimming (default `2048`).
- `PI_CONTEXT_TRIM_SNIPPET_CHARS=N` - snippet width in listings (default `80`).
- `PI_CONTEXT_TRIM_CAPTION_MODEL=provider/id` - vision model used to auto-caption a trimmed image when the active model
  is text-only (lowest-priority layer; the `captionModel` config key below overrides it).
- `PI_CONTEXT_TRIM_DROP_DEFAULT=allow|deny` - non-interactive fallback for the `drop_image` confirmation when there is
  no UI (default `deny`, matching `bash-permissions`). Drops are reversible, which lowers the stakes of `allow` for
  autonomous runs.
- `PI_CONTEXT_TRIM_DROP_TAIL_GUARD=N` - how many of the most-recent images `drop_image` refuses to drop (default `1`).

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
