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

## How the injection works

- Hook: `pi.on('before_provider_request', …)` — returns a mutated payload clone (`{ ...p, [field]: budget }`),
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

- `field` — numeric field name injected. Default `"thinking_budget_tokens"`.
- `stripEffort` — delete `reasoning_effort` after injection. Default `false`.
- `models` — allow-list of model ids. Omit to match every model on the provider.
- `budgets` — per-level override (`minimal` / `low` / `medium` / `high` → positive int).

Budget resolution order per level (first defined wins): env override → provider `budgets` → pi settings
`thinkingBudgets` (from `~/.pi/agent/settings.json` then project `.pi/settings.json`) → built-in defaults
`1024 / 2048 / 8192 / 16384`.

## Environment variables

- `PI_LLAMA_BUDGET_MINIMAL` — override minimal-level budget (positive int).
- `PI_LLAMA_BUDGET_LOW` — override low-level budget.
- `PI_LLAMA_BUDGET_MEDIUM` — override medium-level budget.
- `PI_LLAMA_BUDGET_HIGH` — override high-level budget.
- `PI_LLAMA_BUDGET_DEBUG=/path/to/log` — append one line per decision (inject / skip + reason) to this file. Unset =
  silent.

## Hot reload

Edit [`extensions/llama-thinking-budget.ts`](./llama-thinking-budget.ts) and run `/reload` in an interactive pi session
to pick up changes without restarting. Changes to `models.json` / `settings.json` are only re-read at extension load, so
`/reload` is also required after editing those.
