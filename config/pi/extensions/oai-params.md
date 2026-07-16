# oai-params

Define **derived model variants** for OpenAI-compatible endpoints: a new pi model id that `extends` an existing
`openai-completions` model (the "parent", e.g. a llama.cpp or litellm model in `models.json`) and layers a block of
OpenAI-completions sampling params (`temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`, or any other body
field the server accepts) onto every request for that variant.

The failure mode it addresses: pi's `models.json` has no place to pin per-model sampling params, and pi's coding-agent
never sends `temperature` / `top_p` / `min_p` etc. This extension lets you register, say, a "creative" and a "precise"
preset of the same local model as two selectable models, each with its own sampling profile.

## Composition on `before_provider_request`

Two extensions in this repo listen on `before_provider_request` for `openai-completions` payloads:

| Extension               | Signal                                                                                    | Action                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `llama-thinking-budget` | `reasoning_effort` / `enable_thinking` / `chat_template_kwargs` present + provider opt-in | Inject a numeric `thinking_budget_tokens`.                                     |
| `oai-params` (this)     | `ctx.model.provider` is a registered variant                                              | Rewrite `payload.model` to the parent server id + fill in the sampling params. |

They compose: each returns the payload for the next handler. `oai-params` only touches `payload.model` and the sampling
keys it owns; it never sets thinking fields.

> **Known limitation.** `llama-thinking-budget` keys its injection config by _provider name_ (`thinkingBudgetInjection`
> under a provider in `models.json`). A variant is registered under its own synthetic provider (named after the variant
> id), so it does **not** inherit the parent provider's thinking-budget config. Thinking-budget injection therefore does
> not apply to variants. Use the parent model directly if you need the numeric budget.

## How a variant becomes a selectable model

pi sends `model: <model.id>` on the wire. To make a variant show up in `/model` with a clean id while still hitting the
right server model, the extension:

1. Reads each variant from `oai-params.json` and resolves its parent's provider + model block from `models.json`
   ([`load-config.ts`](../../../lib/node/pi/oai-params/load-config.ts),
   [`build-registration.ts`](../../../lib/node/pi/oai-params/build-registration.ts)).
2. Registers the variant as **its own single-model provider** (provider name == variant id), cloning the parent's
   `baseUrl` / `apiKey` / `headers` / `authHeader` / `api` and the parent model entry's `cost` / `contextWindow` /
   `maxTokens` / `input` / `reasoning` / `compat` / `thinkingLevelMap`. This runs at extension load (queued and applied
   when the runner binds context), so the variant exists for `--model <id>` resolution.
3. On each request, if `ctx.model.provider` is a known variant, rewrites `payload.model` to the parent's real server id
   and fills in the sampling params ([`inject.ts`](../../../lib/node/pi/oai-params/inject.ts)).

Because one provider hosts exactly one variant, per-variant `baseUrl` / `apiKey` / `headers` all work independently -
variants may extend parents from different providers (`llama-cpp`, `local`, …) with different auth.

## Fill-only injection

Injection is **fill-only**: a sampling key is set only when it is **absent** from the payload pi built. pi never emits
`top_p` / `top_k` / `min_p` / `repetition_penalty` / … and never emits `temperature` (the coding-agent passes none), so
those always flow through. Keys pi _does_ manage are left untouched, and the same set is refused outright as sampling
keys (reserved): `model`, `messages`, `stream`, `stream_options`, `store`, `tools`, `tool_choice`, `max_tokens`,
`max_completion_tokens`, `n`. (`payload.model` is still rewritten - that is the variant mechanism, not a sampling key.)

## Config shape

`oai-params.json` lives in the agent dir (`~/.pi/agent/oai-params.json`) and/or the project
(`<cwd>/.pi/oai-params.json`, which overrides the agent-dir layer per variant id). JSONC (comments + trailing commas) is
accepted. Keyed by the **new model id**:

```jsonc
{
  // A high-temperature creative preset of the local Qwen model.
  "qwen3-27b-creative": {
    "extends": "llama-cpp/qwen3-6-27b", // "provider/id" of the parent (required, qualified)
    "name": "Qwen 3.6 27B (creative)", // optional display name (defaults to the key)
    "samplingParams": {
      "temperature": 1.0,
      "top_p": 0.95,
      "min_p": 0.05,
      "top_k": 40,
    },
  },
  "qwen3-27b-precise": {
    "extends": "llama-cpp/qwen3-6-27b",
    "samplingParams": { "temperature": 0.2, "top_p": 0.8 },
  },
}
```

Requirements per entry:

- `extends` must be a `"provider/id"` string; both the provider and the parent model must exist in `models.json`, and
  the parent's resolved `api` must be `openai-completions`. Anything else is skipped with an error surfaced by
  `/oai-params`.
- `samplingParams` is an open passthrough - any JSON-typed field the endpoint accepts - minus the reserved keys above.

Select a variant with `/model` or `--model qwen3-27b-creative`; the wire request carries `model: "qwen3-6-27b"`.

## Command

- `/oai-params` - list every defined variant, its parent, and the sampling params layered on it; the active model is
  marked with `→`. Config/resolution errors are listed at the bottom. `/oai-params --help` prints usage.

## Environment variables

- `PI_OAI_PARAMS_DISABLED=1` - skip the extension entirely (no providers registered, no hook, no command).

## Hot reload

- Editing `oai-params.json` or the parent's `models.json` entry: run `/reload`. Reload routes through `session_shutdown`
  (which unregisters this extension's variant providers) then re-runs the factory (which re-reads config and
  re-registers), so removed variants disappear and edited sampling params take effect without a restart.
- Editing `oai-params.ts` itself: `/reload` (headless `-p` picks up the latest on launch).
