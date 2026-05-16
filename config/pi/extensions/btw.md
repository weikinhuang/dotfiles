# `btw.ts`

Claude Code `/btw`-style ephemeral side-question command. Type `/btw <question>` to ask something about the current
session without saving the Q&A to history and without letting the model call tools.

## Why

Quick questions during a long session - "what file did we edit three turns ago?", "summarize the plan in two bullets",
"which approach did we rule out?" - don't need a new user turn. They don't need tool access. They shouldn't clutter the
transcript. Claude Code bundles this as `/btw`; this extension replicates the UX on pi.

## Mechanism

Pi's extension API doesn't expose a "call the LLM out of band" primitive - `pi.sendMessage` / `pi.sendUserMessage` both
append to the session and trigger turns. `/btw` therefore reaches through the API and calls
[`@earendil-works/pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai)'s `complete()` function directly,
using pi's own helpers to reconstruct the branch context that would otherwise be sent next turn:

1. Grab the current branch: `ctx.sessionManager.getBranch()`.
2. Convert entries → LLM messages: `buildSessionContext(entries)` (exported from `pi-coding-agent`).
3. Append the side question as a synthetic user message with a short directive (no tools, not persisted).
4. Resolve creds: `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)`.
5. Call

   ```typescript
   complete(
     model,
     { systemPrompt, messages, tools: [] },
     { apiKey, headers, sessionId, cacheRetention: 'short', signal },
   );
   ```

6. Render the answer via `ctx.ui.notify` with a one-line footer (model · tokens · cached · out · $cost · duration ·
   `ephemeral`).
7. Do **not** call `pi.sendMessage` / `pi.sendUserMessage` / `pi.appendEntry` - that's what keeps the Q&A ephemeral.

## What's inherited from the main turn

- **Model** - `ctx.model`, including any `/model` switch the user did mid-session. Override with `PI_BTW_MODEL`.
- **System prompt** - `ctx.getSystemPrompt()`, which includes every extension's injected sections.
- **Messages** - the branch's full message list, so the side question sees everything the main turn would have.
- **`sessionId` + `cacheRetention: "short"`** - these are the load-bearing knobs for prompt-cache reuse.
- **API key + custom headers** - via `ModelRegistry.getApiKeyAndHeaders()`, so OAuth / basic-auth / proxies work.
- **`signal`** - the session's abort signal, so Ctrl+C cancels the side question cleanly.

## What's NOT inherited

`temperature`, `maxTokens`, `timeoutMs`, `maxRetries`, `metadata`, and per-provider options (Anthropic's thinking
display, Google's `thinkingBudgets`, Bedrock options) are not reachable from `ExtensionContext`. pi-ai's defaults apply.
For the typical Anthropic / OpenAI / local-OpenAI-compatible case prompt caching still works because the request prefix
is unchanged; for exotic provider-specific setups cache reuse is best-effort.

## Ephemeral footer

Every answer ends with a one-line stats footer so the user can verify which model answered, whether caching engaged, and
how much the call cost:

```text
[model: claude-opus-4-7 · 3.6k tokens · 2.9k cached · 180 out · $0.0023 · 1.2s · ephemeral]
```

Fields render only when present (e.g. `cached` is omitted when zero, `$` is omitted when cost is 0). The trailing
`ephemeral` is always shown as a reminder that the Q&A was not saved.

## Commands

- `/btw <question>` - answer a side question. With no argument, prints the usage help.

## Environment variables

- `PI_BTW_DISABLED=1` - skip the extension entirely (no `/btw` command registered).
- `PI_BTW_MODEL=provider/modelId` - answer side questions with a specific model instead of the session's current one.
  Useful for pairing a big reasoning model on the main turn with a cheaper fast model on side questions. Falls back to
  the current model with a warning if the override isn't registered.
- `PI_BTW_INCLUDE_TOOLS=1` - pass the currently-active tools to the side-question call instead of `[]`. Escape hatch for
  debugging; defeats the whole point of the command.

## Hot reload

Edit [`extensions/btw.ts`](./btw.ts) or [`lib/node/pi/btw.ts`](../../../lib/node/pi/btw.ts) and run `/reload` in an
interactive pi session to pick up changes without restarting.
