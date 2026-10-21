# `llama-thinking-budget.ts`

Inject a numeric thinking budget into OpenAI-compatible (llama.cpp-style) request bodies so locally hosted reasoning
models know when to stop thinking.

## What it does

Pi's OAI-completions provider encodes "how much thinking" in one of three ways depending on the model's
`compat.thinkingFormat`:

- `openai` (default) → `reasoning_effort: "minimal|low|medium|high"`
- `qwen-chat-template` → `chat_template_kwargs.enable_thinking: true`
- `qwen` / `zai` → top-level `enable_thinking: true`

None of those carry a token budget, which llama.cpp-hosted reasoning models (Qwen3, GLM, etc.) need to actually bound
their thinking phase. This extension watches outgoing requests and, for providers that opt in via `models.json`, adds a
numeric `thinking_budget_tokens` (field name configurable) derived from the current thinking level.

It also carries a small, provider-independent [think-leak guard](#leaked-think-guard) that moves a stray literal
`</think>` segment out of visible OpenAI-completions replies.

## How the injection works

- Hook: `pi.on('before_provider_request', …)` - returns a mutated payload clone (`{ ...p, [field]: budget }`),
  optionally deleting `reasoning_effort` when `stripEffort` is set.
- Detect the reasoning signal in the payload, in order:
  1. `reasoning_effort` string → use directly as the level.
  2. `chat_template_kwargs.enable_thinking === true` → read level from session.
  3. top-level `enable_thinking === true` → read level from session.
  4. otherwise skip (not a thinking request).
- Session level lookup walks `ctx.sessionManager.getBranch()` backwards for the last `thinking_level_change` entry and
  normalizes `xhigh` → `high` to mirror pi-ai's own clamp.
- Gate by provider: `ctx.model.provider` must appear in the loaded `thinkingBudgetInjection` map.
- Gate by model id: if `injection.models` is set, `ctx.model.id` must be in the allow-list; omit to match every model on
  the provider.
- No-op early exit: if no provider opted in, the hook is never registered.

## Config surface

Opt in per provider in `~/.pi/agent/models.json` or project `.pi/models.json` (project wins, merged last):

```json
{
  "providers": {
    "llama-cpp": {
      "thinkingBudgetInjection": {
        "field": "thinking_budget_tokens",
        "stripEffort": false,
        "models": ["qwen3-6-35b-a3b"],
        "budgets": { "minimal": 1024, "low": 2048, "medium": 8192, "high": 16384 }
      }
    }
  }
}
```

All keys are optional:

- `field` - numeric field name injected. Default `"thinking_budget_tokens"`.
- `stripEffort` - delete `reasoning_effort` after injection. Default `false`.
- `models` - allow-list of model ids. Omit to match every model on the provider.
- `budgets` - per-level override (`minimal` / `low` / `medium` / `high` → positive int).

Budget resolution order per level (first defined wins): env override → provider `budgets` → pi settings
`thinkingBudgets` (from `~/.pi/agent/settings.json` then project `.pi/settings.json`) → built-in defaults
`1024 / 2048 / 8192 / 16384`.

## Environment variables

- `PI_LLAMA_THINKING_BUDGET_DISABLED=1` - skip the extension entirely (nothing registers).
- `PI_LLAMA_THINKING_BUDGET_DISABLE_THINK_GUARD=1` - keep stray `</think>` text visible (disables only the
  [think-leak guard](#leaked-think-guard); budget injection still runs).
- `PI_LLAMA_BUDGET_MINIMAL` - override minimal-level budget (positive int).
- `PI_LLAMA_BUDGET_LOW` - override low-level budget.
- `PI_LLAMA_BUDGET_MEDIUM` - override medium-level budget.
- `PI_LLAMA_BUDGET_HIGH` - override high-level budget.
- `PI_LLAMA_BUDGET_DEBUG=/path/to/log` - append one line per decision (inject / skip + reason) to this file. Unset =
  silent.

## Server-side behavior (llama.cpp)

Validated against the refactored llama.cpp server (`tools/server/`) on `master`:

- The OpenAI-compat chat-completions endpoint reads `thinking_budget_tokens` from the request body and maps it to the
  sampler's `reasoning_budget_tokens` (`server-common.cpp`). So the field name this extension injects is the one the
  server consumes.
- A **positive** `thinking_budget_tokens` alone arms the budget sampler (`common/sampling.cpp`: the sampler is created
  when the model's thinking tags are present and `reasoning_budget_tokens >= 0`). The extension is therefore correct to
  inject only the budget.
- `reasoning_control: true` (which the llama.cpp webui also sends) is **not** required for the budget to be enforced. It
  only enables the optional runtime "force end reasoning now" control endpoint (`SERVER_TASK_TYPE_CONTROL` /
  `reasoning_end`). pi has no stop-thinking control surface, so this extension intentionally omits `reasoning_control` -
  do not add it.

Three server-side preconditions must hold for an injected budget to actually take effect (none are extension bugs):

1. The server must **not** be launched with `--reasoning-budget N` - a CLI value takes precedence over the per-request
   `thinking_budget_tokens` (`reasoning_budget == -1` is the gate that lets the request value through).
2. The model's chat template must expose thinking start/end tags; the server drops the budget when `thinking_end_tag` is
   empty.
3. Any proxy in front of llama.cpp (e.g. a LiteLLM gateway) must forward the non-standard `thinking_budget_tokens` and
   `chat_template_kwargs` params rather than stripping them (`drop_params` / `allowed_openai_params`).

## Leaked `</think>` guard

llama.cpp's reasoning parser splits only the **first** `<think>…</think>` span into `reasoning_content`. Qwen-family
models with thinking enabled (seen at both `low` and `xhigh` effort) often keep deliberating after that split: they
write a draft answer into the visible channel, emit a second literal `</think>`, then write the real answer. The server
streams all of it as plain `content`, so the reply reads `draft </think> final`. Verified against a LiteLLM -> llama.cpp
gateway with a Qwen 3.8 27B model: `reasoning_content` is split correctly for both `enable_thinking: true` and `false`,
so this is model output, not a server-flag or template problem, and no server flag can repair it.

The guard runs on `message_end` for every assistant message whose `api` is `openai-completions` (independent of the
`thinkingBudgetInjection` opt-in). When a visible text part contains `<think>` / `</think>`, the pure helper
[`splitLeakedThinking`](../../../lib/node/pi/llama-thinking-budget/think-leak.ts) moves everything before the **last**
`</think>` into a `thinking` part (reusing the message's existing thinking signature, default `reasoning_content`) and
keeps only the trailing answer visible. When nothing follows the last closer, the text stays visible with the tags
stripped so a reply is never hidden. The repaired message replaces the original in place, so `pi -p` output, the session
`.jsonl`, and later replays all see the clean version. The TUI may show the raw text while it streams; the final message
is the repaired one.

## Recommended server and `models.json` setup

- Run llama.cpp with `--jinja` and the default `--reasoning-format` (`auto` / `deepseek`), so thinking lands in
  `reasoning_content`. `--reasoning-format none` puts `<think>` blocks in `content` and defeats both pi's thinking
  channel and this guard's single-leak assumption.
- Any proxy in front (LiteLLM) must forward `chat_template_kwargs` and `thinking_budget_tokens` (see preconditions
  above). A dropped `chat_template_kwargs` makes `--thinking off` a no-op on the server.
- A `thinkingLevelMap` entry set to `null` marks that level unsupported, and pi clamps it to the nearest supported
  level. With `defaultThinkingLevel: "high"` in `settings.json` and `"high": null` in the map (the current `qwen3-8-27b`
  entry), every model switch that falls back to the settings default sends `reasoning_effort: "xhigh"`. Map `"high"` to
  a real effort (or lower the settings default) if that is not intended. The persona model-swap path no longer falls
  back to the default; see [persona thinking-level precedence](./persona.md#thinking-level-precedence).
- `preserve_thinking` is not the trigger. In 10-turn roleplay A/B runs on a Qwen 3.8 27B at `low` effort, raw leaks hit
  1-4 of 10 replies with `preserve_thinking: true` and 4 of 10 with `false`; with thinking `off`
  (`enable_thinking: false`) there were none in 10. Keep the guard on for any thinking-enabled Qwen chat-template model.

## Hot reload

Edit [`extensions/llama-thinking-budget.ts`](./llama-thinking-budget.ts) and run `/reload` in an interactive pi session
to pick up changes without restarting. Changes to `models.json` / `settings.json` are only re-read at extension load, so
`/reload` is also required after editing those.
