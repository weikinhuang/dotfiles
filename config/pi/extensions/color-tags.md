# `color-tags.ts`

Inline color-tag rewriter for assistant prose. Lets the LLM color short runs of its own output by emitting
`[c:NAME]content[/c]` tags, which this extension rewrites into ANSI SGR sequences during streaming so they render as
real terminal colors next to bold / italic / theme styling.

## Why

Plain markdown gives the model bold, italic, headings, and code spans, but no way to highlight individual words by
color. Colored emphasis ("the word `error` in red, `ok` in green") is useful for short, repeating tokens the user wants
to scan for at a glance - log levels, status verbs, diff hunks, key terms in an explanation.

This extension adds exactly that knob, with no other moving parts.

## Mechanism

```text
        ┌──────────────────────────────────────────────────────┐
LLM     │ ...processed [c:red]error[/c] in 12ms ([c:success]ok │
output  │ [/c] otherwise)...                                   │
        └─────────────────────────┬────────────────────────────┘
                                  │ streamed token-by-token
                                  ▼
        ┌──────────────────────────────────────────────────────┐
pi      │ message_update event { message: { content: [...] } } │
event   └─────────────────────────┬────────────────────────────┘
                                  │ in-place mutate text/thinking
                                  ▼
        ┌──────────────────────────────────────────────────────┐
pi TUI  │ ...processed \x1b[31merror\x1b[39m in 12ms (\x1b[…m  │
render  │ ok\x1b[39m otherwise)...                             │
        └──────────────────────────────────────────────────────┘
```

Two hooks for the colored render path, plus one to keep history clean:

1. **`before_agent_start`** appends a `## Inline color tags` section to the system prompt teaching the model the bracket
   syntax, the close-tag rule, the no-nesting rule, the full vocabulary (named-16, 256-index, hex, theme tokens), and
   crucially the **"emit as plain text - do NOT convert to escape sequences yourself"** guardrail. Idempotent: if the
   heading is already present, the addendum is skipped. Skipped entirely when `PI_COLOR_TAGS_NO_PROMPT=1`.

2. **`message_update`** runs once per streaming chunk. The handler walks `event.message.content[]` and, for each `text`
   / `thinking` part on an assistant message, rewrites the cumulative text with
   `rewriteColorTags(text, resolver, { streaming: true })`. The mutation is in-place, so pi's `streamingComponent`
   re-renders from the same array reference and colors apply progressively as the model types.

3. **`context`** runs whenever pi assembles `context.messages` for an outgoing provider request. It strips every
   `\x1b[…m` SGR sequence from assistant parts that contain one, and returns a replacement messages array. This is what
   stops the model from seeing its own past ANSI bytes in conversation history and starting to emit raw escape bytes
   itself.

Pure logic lives under [`lib/node/pi/color-tags/`](../../../lib/node/pi/color-tags/) and is unit-tested by
[`tests/lib/node/pi/color-tags/`](../../../tests/lib/node/pi/color-tags/):

| Helper                                                                       | Job                                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`resolve-color.ts`](../../../lib/node/pi/color-tags/resolve-color.ts)       | Map a name to an `{ open, close }` SGR pair. Named-16, `x256-N`, `#RRGGBB` / `#RGB`. Unknown ⇒ `undefined`.   |
| [`parse-color-tags.ts`](../../../lib/node/pi/color-tags/parse-color-tags.ts) | Three-pass rewriter: closed pairs → trailing open-without-close (streaming) → trailing partial-open suppress. |
| [`color-prompt.ts`](../../../lib/node/pi/color-tags/color-prompt.ts)         | Build the `## Inline color tags` addendum + idempotent append helper.                                         |

The extension layer wraps the pure resolver with a theme-aware lookup so semantic names like `accent`, `success`,
`mdHeading`, `bashMode` route through `theme.getFgAnsi(token)` first and fall through to the named-16 / 256 / hex
resolver only when the name isn't a `ThemeColor`.

## Why brackets, not guillemets / curly / HTML

Three earlier delimiter shapes were tried and rejected. The decisive evidence was hex-dumping `pi -p` raw output against
Anthropic Claude opus-4-7 and llama-cpp qwen3-6-35b-a3b - both with and without our addendum injected - sidestepping
pi's marked.js renderer entirely so the bytes are exactly what each model emitted.

| Shape                         | Result with addendum                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<color name="red">…</color>` | Marked tokenises as an HTML tag. Open variably stripped from the rendered text.                                                                                                                                                |
| `{c:NAME}content{/c}`         | Curly opens stripped at the API boundary on at least one tested provider.                                                                                                                                                      |
| `«c:NAME»content«/c»`         | Survives the API but Claude auto-converts some opens to raw `\x1b[…m` bytes (training-data reflex on the guillemet+color shape) and partially strips others. Qwen3 drops `«` consistently across all tags.                     |
| **`[c:NAME]content[/c]`**     | **Survives the API; both models emit the tags character-for-character; marked tokenises as a single text node (no link-reference parse because there's no `(href)` after the close); no model-trained ANSI reflex triggered.** |

The lesson learned: the original design assumed the failure was an API-side sanitiser stripping tag-shaped opens. The
real failure was **the model's own pretrained reflex** on the guillemet+color shape - Claude has training data where
`«color»` patterns map to ANSI escapes, and it auto-rewrites them on emission. Bracket form sidesteps that reflex
because there's no `[c:NAME]→\x1b[…m` mapping in the model's training data.

The marked link-reference concern that originally pushed us off the bracket form turned out to be a false alarm:
`marked.lexer('[c:red]ERROR[/c]: status')` tokenises as a single `text` token, because link references require either
`[text](url)` or `[text][label]` - the `[c:red]ERROR[/c]:` shape matches neither. Verified directly.

## Why no `message_end` rewrite

The prototype also ran the rewriter at `message_end` to make the post-stream final render clean. That triggered a
session-history feedback loop:

1. Pi's `MessageEndEventResult.message` mutation propagated through `appendMessage(event.message)` into the on-disk
   session **and** `context.messages` for the next turn.
2. The next provider request therefore included raw `\x1b[31m…\x1b[39m]` bytes in conversation history.
3. Claude (very good at pattern-matching its own output) then **emitted raw ANSI escape bytes itself** instead of
   `[c:NAME]` tags. Display still worked (the bytes are valid ANSI) but the rewriter did nothing useful and the close
   `[/c]` was orphaned.

So `message_end` is deliberately not wired. The model's own past output stays as the original `[c:NAME]` syntax in
session storage, and the LLM never sees ANSI bytes in history.

## Commands

None. The extension is invisible: it only adds a system-prompt section and rewrites streaming text.

## Environment variables

- `PI_COLOR_TAGS_DISABLED=1` - skip the extension entirely. No system-prompt section, no streaming rewrite.
- `PI_COLOR_TAGS_NO_PROMPT=1` - keep the streaming rewriter active, drop the system-prompt addendum. Useful for A/B
  testing whether the addendum changes model behaviour for a given local model.
- `PI_COLOR_TAGS_TRACE=<path>` - append per-event diagnostics to `<path>`. Logs `parts=N`, `[c:openCount=N`,
  `[/c]closeCount=N`, `mutationChangedText=YES|no`, plus the last 200 chars of each text part before / after the
  rewrite. Default off. Set to `off` (or leave unset) to disable.

## Known limits

- **Brief raw-tag flash at end of stream.** Pi's interactive `case "message_end"` handler calls
  `streamingComponent.updateContent(event.message)` with a fresh agent clone of the final message, which doesn't carry
  this extension's in-place mutation. So the user briefly sees the literal `[c:NAME]content[/c]` text right after
  streaming completes, before the next render pass. Acceptable trade-off for the simpler hook surface; if it ever gets
  painful, the path forward is to add a `before_provider_request` hook that strips ANSI from outgoing payload and re-add
  the `message_end` rewrite.
- **Streaming-only.** The rewriter relies on `message_update` exclusively. Replays from session storage do not get
  re-rewritten - they show the original `[c:NAME]` syntax (which is the correct on-disk representation, see "Why no
  `message_end` rewrite" above).
- **`pi -p` (print) mode does not color.** Print mode reads `state.messages[last].content[i].text` directly to stdout
  and never fires `message_update`, so the literal `[c:NAME]` tags are emitted verbatim. The extension is
  interactive-only by design.
- **Mid-name partial-open flash.** When a stream chunk ends mid-tag (e.g. `[c:re`), the rewriter leaves it visible for
  one frame. Earlier versions had a fourth pass that suppressed trailing partial opens, but that was a destructive
  mutation - pi's agent-core appends the next chunk's delta to the cumulative text via `content.text += delta`, so bytes
  deleted by the suppression pass were never reconstructed and `:red]content` showed up literal forever once the rest
  streamed in. Accepting a one-frame `[c:re` flash is strictly better than that failure mode.
- **No background colors yet.** Foreground only. `[bg:NAME]…[/bg]` is on the deferred list - independent resolver, close
  `\x1b[49m`, probably wants a single combined parser.
- **No block-level colors.** Inline-only. Markdown-it `:::block:::` style is on the deferred list and would need to hook
  into marked's block tokenizer rather than rewriting text.

## Hot reload

Edit [`extensions/color-tags.ts`](./color-tags.ts) or helpers under
[`lib/node/pi/color-tags/`](../../../lib/node/pi/color-tags/) and run `/reload` in an interactive pi session to pick up
changes without restarting.
