# `native-web.ts`

`web_search` and `web_fetch` tools backed by the current provider's own server-side web tool, so a pi session on a
provider with built-in web access (a Copilot seat, a ChatGPT subscription, an OpenAI or Anthropic key) uses it, and a
session on any other provider falls back to the `ai-fetch-web` skill.

## Provider table

[`NATIVE_WEB_PROVIDERS`](../../../lib/node/pi/native-web.ts) lists the (provider, api) pairs with a native tool. Support
is keyed by provider _and_ api: Copilot serves Claude over `anthropic-messages` but rejects Anthropic's web tools there
("The use of the web search tool is not supported"), so only its Responses models qualify.

| Provider (pi)    | Eligible api             | Native tool                                                     | Preferred model    | Verified             |
| ---------------- | ------------------------ | --------------------------------------------------------------- | ------------------ | -------------------- |
| `github-copilot` | `openai-responses`       | Responses `web_search` (`open_page` / `find_in_page` for fetch) | `gpt-6-luna`       | live (Business seat) |
| `openai-codex`   | `openai-codex-responses` | Responses `web_search` (ChatGPT subscription)                   | `gpt-6-luna`       | unit tests only      |
| `openai`         | `openai-responses`       | Responses `web_search`                                          | `gpt-6-luna`       | unit tests only      |
| `anthropic`      | `anthropic-messages`     | `web_search_20250305` / `web_fetch_20250910` server tools       | `claude-haiku-5-5` | unit tests only      |
| anything else    |                          | none: tools off, `ai-fetch-web` stays                           |                    | live (llama-cpp)     |

Google (Gemini / Vertex) has native grounding, but pi's Google adapters reject a custom `fetch`, so the raw response
(and its grounding metadata) cannot be captured; it falls back to `ai-fetch-web`. To add a provider, add a table row
with an existing `family`, or a new family with an injector and parser in `native-web.ts`.

## Model selection

Web calls run on a model of the session's **current provider**, not necessarily the current model:
[`resolveWebModel`](../../../lib/node/pi/native-web.ts) picks the `PI_NATIVE_WEB_MODELS` override for that provider,
else the table's preferred model, else the cheapest available model on an eligible api. A Claude session on Copilot
therefore searches with `github-copilot/gpt-6-luna`, and a ChatGPT session on an expensive model searches with the cheap
one. Each call is one request on that model, billed like any other request on the provider.

## Transport

Each call is `ctx.modelRegistry.complete(model, …)`, so pi supplies auth (including OAuth refresh), endpoints, and
provider headers for every provider. Two hooks adapt it:

- `onPayload` runs [`injectWebTool`](../../../lib/node/pi/native-web.ts): Responses gets `{type: "web_search"}`,
  `tool_choice: "required"`, and `include: ["web_search_call.action.sources"]`; Anthropic gets the server tool (fetch
  also sends `anthropic-beta: web-fetch-2025-09-10`).
- A capturing `fetch` copies the raw response, and [`parseNativeWebRaw`](../../../lib/node/pi/native-web.ts) rebuilds
  text, `url_citation` / `citations_delta` citations, sources, and actions from the SSE stream, because pi's message
  parsers drop citations and server-tool results. `utm_*` params are stripped so tagged citations dedupe.

| Tool         | Parameters                          | Returns                                                                                       |
| ------------ | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `web_search` | `query`, optional `allowed_domains` | A concise cited answer followed by a `Sources:` list.                                         |
| `web_fetch`  | `url`, optional `prompt`            | The model's answer to `prompt` from that page only, plus a note when it never opened the URL. |

`web_fetch` returns a model answer, not the raw page; the provider fetches from its own network, so localhost, private,
and authenticated URLs fail.

## Provider gating

A `before_agent_start` handler runs [`applyWebGate`](../../../lib/node/pi/native-web.ts) on every run:

| Current provider                        | `web_search` / `web_fetch`                        | `ai-fetch-web` skill                 |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| has a native tool and an eligible model | active                                            | dropped from the `<skills>` prompt   |
| anything else (or no model)             | deactivated (`systemPromptOptions.selectedTools`) | left in place, so it is the web path |

The gate restores only tools it deactivated itself, so a persona or preset allowlist that never included them keeps them
off. Switching models mid-session flips the tools and skill on the next run; pi patches only the changed prompt
sections. Note that `ai-fetch-web` needs a bash allow rule (`ai-fetch-web*`) to run in headless `pi -p` sessions.

## Environment variables

| Variable                    | Default        | Effect                                                                      |
| --------------------------- | -------------- | --------------------------------------------------------------------------- |
| `PI_NATIVE_WEB_DISABLED`    | unset          | `1` skips the extension (no tools, no gating).                              |
| `PI_NATIVE_WEB_MODELS`      | unset          | `provider/id,...` model for web calls per provider.                         |
| `PI_NATIVE_WEB_TIMEOUT_MS`  | `120000`       | Per-call timeout; the call also aborts with the turn.                       |
| `PI_NATIVE_WEB_ALWAYS`      | unset          | `1` keeps the tools on for every provider (unsupported ones return errors). |
| `PI_NATIVE_WEB_HIDE_SKILLS` | `ai-fetch-web` | Comma-separated skills hidden while the tools are on; empty hides none.     |

## Hot reload

`/reload` picks up changes to `native-web.ts` and its helpers. Environment variables are read once at load, so change
them and `/reload` (or restart pi).

## Smoke test

```bash
D=$(mktemp -d)
pi --mode json --session-dir "$D" --session-id nw -p "Latest bats-core release? Look it up on the web." \
  --model github-copilot/claude-haiku-5.5 >/dev/null
jq -c 'select(.type=="message" and .message.role=="toolResult") | .message | {toolName, isError, details}' "$D"/*.jsonl
```
