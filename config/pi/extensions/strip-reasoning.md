# `strip-reasoning.ts`

Drops plain-text `thinking` blocks from assistant history before each LLM call, for an explicit allowlist of models. A
non-destructive `context`-hook overlay: the hook output is ephemeral, so the full reasoning stays in the session
`.jsonl` and the TUI scrollback - the model is just sent less.

## Why

With `reasoning: true` (e.g. gemma / qwen via llama.cpp), pi stores each thinking trace as a `thinking` block and the
OpenAI-completions client re-attaches every past assistant turn's reasoning on each replayed message. That round-trip is
load-bearing for signed-thinking models (Claude, OpenAI responses) but dead weight for models that emit plain-text
reasoning: they don't need their own past chain-of-thought resent to stay coherent. On a small window the retained
reasoning can eat ~15% of the budget and pull auto-compaction forward for no benefit.

## Detection

Two safety layers, so a mistaken allowlist entry can never corrupt a request (logic in
[`lib/node/pi/strip-reasoning.ts`](../../../lib/node/pi/strip-reasoning.ts)):

1. **Trailing window.** The last `keepLast` assistant turns keep their reasoning, so an in-flight tool loop
   (assistant-think -> toolCall -> toolResult -> next call) still sees the immediately-preceding trace.
2. **Per-block.** Only plain-text reasoning is dropped: a block is stripable only when it is not `redacted` and its
   signature is empty or one of the llama.cpp / OpenAI-completions field-name sentinels (`reasoning_content`,
   `reasoning`, `reasoning_text`). A real opaque signature (Anthropic signed thinking, encrypted reasoning) is
   preserved, so listing such a model is a no-op rather than a broken request.

`stripReasoning` returns the same array reference when nothing changed, so an identical token prefix lets the backend
reuse its prefix cache.

## Config shape

`strip-reasoning.json`, resolved project `.pi/strip-reasoning.json` over user `<agentDir>/strip-reasoning.json`. The
`models` allowlist is the union of both layers; `keepLast` is project > user > default (`1`). A missing / unreadable /
invalid file contributes an empty layer, so the default is an empty allowlist (the extension is inert).

```jsonc
{
  // "provider/id" or bare "id"
  "models": ["llama-cpp/gemma4-31b", "gemma4-31b"],
  "keepLast": 1, // trailing assistant turns whose reasoning is always kept
}
```

See [`../strip-reasoning-example.json`](../strip-reasoning-example.json).

## Environment variables

- `PI_STRIP_REASONING_DISABLED=1` - skip the extension entirely.

## Hot reload

Edit [`extensions/strip-reasoning.ts`](./strip-reasoning.ts) or
[`lib/node/pi/strip-reasoning.ts`](../../../lib/node/pi/strip-reasoning.ts) and run `/reload`. The config file is read
per turn, so edits to `strip-reasoning.json` take effect on the next turn without a reload.
