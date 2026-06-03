# `image-ref.ts`

Mark an image path with `&` in an interactive message and have the model actually _see_ it - no "please read this file"
prompting. Write `&./mock.png` (any path that resolves to a real image) and the extension attaches the pixels to the
turn, the way Codex and Claude Code do.

Attachment is **opt-in**: only the `&` marker triggers it, so mentioning a bare path in prose ("let's rename
`Example.jpg`") never accidentally base64s a file you only wanted to talk about.

## Why

Pi attaches image bytes to a turn in only two places: the CLI `@file` argument
([`cli/file-processor.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/cli/file-processor.ts))
and clipboard paste (Ctrl+V, which just inserts the file path as text). An image _path_ typed mid-session is sent to the
model as a plain string - `getUserInput()` calls `session.prompt(text)` with no images - so a vision model never gets
the pixels, and a small self-hosted model flails trying to "read" a binary file. This extension closes that gap by
hooking the `input` event, which supports a `transform` action that can inject `images`.

It is the _input_ counterpart to [`comfyui.ts`](./comfyui.md)'s _output_ (`generate_image` returns rendered images
inline). Both resolve a path to an image; once the model can see a referenced image it can pass that same path into
comfyui's `inputImage` for an img2img run itself.

## What it does

On every `input` event (a typed message, an RPC prompt, or a queued steer / follow-up):

1. Skip immediately if there is no text, or if the active model positively lacks image input
   ([`modelAcceptsImages`](../../../lib/node/pi/image-ref/vision.ts)) - a text-only model would only waste tokens on a
   base64 payload, so the path is left as typed.
2. Extract `&`-marked path tokens ([`extractPathTokens`](../../../lib/node/pi/image-ref/extract.ts)): whitespace-split
   tokens that begin with `&`, marker- quote- and punctuation-cleaned. Unmarked tokens are ignored entirely. Duplicates
   collapse to one; order is preserved.
3. For each token (up to `maxImages`), resolve `~` and relative paths against `ctx.cwd`, `stat` it (must be a non-empty
   regular file within `maxFileBytes`), read it, and **MIME-sniff the bytes**
   ([`sniffImageMime`](../../../lib/node/pi/image-ref/detect.ts)). Because the marker is the explicit intent signal, the
   byte sniff is the _only_ image test (no extension allowlist) - it mirrors pi's own sniffer (rejects animated PNG and
   the CMYK/lossless JPEG variant providers choke on). Any failure (not found, not an image, too big, unreadable)
   silently degrades to "leave it as text"; this feature never blocks a turn.
4. Resize each confirmed image through pi's own `resizeImage` (2000x2000, <4.5MB base64) unless `autoResize` is off,
   attach it as `ImageContent`, and rewrite the marked path into a stable `<image name="basename">WxH</image>` tag
   ([`rewriteWithRefs`](../../../lib/node/pi/image-ref/extract.ts)) - the `&` marker is dropped - so the model has a
   durable handle instead of a path string it might try to read.
5. Return `{ action: 'transform', text, images }`. Existing `event.images` (e.g. from a CLI `@file`) are preserved and
   the new attachments appended.

The pure logic - byte sniffing, marked-path extraction, text rewrite, config layering, the vision gate - lives under
[`lib/node/pi/image-ref/`](../../../lib/node/pi/image-ref) and is unit-tested; the extension shell is just the `input`
transform, the filesystem reads, and the `resizeImage` call.

## Config

User config lives at `~/.pi/agent/image-ref.json` or project `.pi/image-ref.json`; project wins over user wins over the
shipped defaults. See [`image-ref-example.json`](../image-ref-example.json).

```json
{
  "maxImages": 6,
  "autoResize": true,
  "maxFileBytes": 67108864
}
```

- `maxImages: number` (default `6`) - cap on images attached from one message; a paste with more path-like tokens leaves
  the excess as plain text.
- `autoResize: boolean` (default `true`) - resize to pi's inline limit before sending. Turn off only when every
  referenced image is already small.
- `maxFileBytes: number` (default `67108864`, i.e. 64 MiB) - the largest file the extension will read for one image;
  anything bigger is skipped so a stray huge token can't stall a turn.

## Environment variables

- `PI_IMAGE_REF_DISABLED=1` - skip the extension entirely.
- `PI_IMAGE_REF_DEBUG=1` - `ctx.ui.notify` once per decision (attached N image(s) with names, or skipped because the
  model has no image input).

## Marker notes

Only the `&` marker opts a token in - there is no auto-detection, so discussing a file by name is always safe. The
marker accepts any path shape (`&./rel.png`, `&/abs/x.jpg`, `&~/pics/y.webp`, `&"name with spaces.png"`, even an
extensionless `&screenshot`); the byte sniff, not the filename, decides whether it is really an image. A marked token
that doesn't resolve to a supported image is silently left as text (with the marker intact), never an error. `&` was
chosen because pi's editor already claims `@` (file completion), `#` (autocomplete), `!` (bash), and `/` (commands).

## Hot reload

Edit [`extensions/image-ref.ts`](./image-ref.ts) or anything under
[`lib/node/pi/image-ref/`](../../../lib/node/pi/image-ref) and run `/reload` in an interactive pi session to pick up
changes without restarting. Config files are read per message, so editing the JSON needs no reload at all.
