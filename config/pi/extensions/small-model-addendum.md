# `small-model-addendum.ts`

Appends a short, directive reminder block to the system prompt on every turn - but only when the active provider/model
is on a configured allow-list. Aimed at weak self-hosted models (qwen3-30B-A3B, gpt-oss-20B, other ~3–30B chat models)
that need repeated reinforcement of the behaviours other extensions encourage (`todo`, `scratchpad`,
`verify-before-claim`, `context-budget`, …) - their hints compete with every other signal in the prompt and get tuned
out on small models.

## What it does

On `before_agent_start`:

1. Load the config (lazy, cached per session) and reconcile the current `ctx.model` against the allow-list via
   [`matchesModel`](../../../lib/node/pi/small-model-addendum.ts).
2. If no match → clear the status key and return without touching the prompt.
3. If match → call [`appendAddendum`](../../../lib/node/pi/small-model-addendum.ts) on the current `systemPrompt` (or
   `ctx.getSystemPrompt()` when the event omits it) and return `{ systemPrompt: next }`. Pi chains `before_agent_start`
   handlers, so this plays nicely with anything else that also rewrites the prompt.
4. Set the statusline key to `✓ small-model addendum active` so the user can verify the extension fired.

Config is reloaded on each `session_start`, so edits to the JSON files are picked up on `/new`, `/resume`, `/fork`,
`/reload` without requiring an extension reload.

## Config

User config lives at `~/.pi/agent/small-model-addendum.json` or project `.pi/small-model-addendum.json` (JSONC):

```json
{
  "providers": ["llama-cpp"],
  "models": ["llama-cpp/qwen3-6-35b-a3b"],
  "text": "## Reminders\n- Do the thing."
}
```

- `providers: string[]` - providers to apply the addendum to, regardless of model id.
- `models: string[]` - fully qualified `provider/modelId` matches.
- `text: string` - addendum body appended verbatim to the system prompt.

When both `providers` and `models` are empty the extension is a no-op (installed but silent). Missing fields fall back
to sensible defaults; the default `text` lives in
[`lib/node/pi/small-model-addendum.ts`](../../../lib/node/pi/small-model-addendum.ts) and is editable without patching
the extension. Parse / IO failures surface as a single `ctx.ui.notify` warning (never re-notified for the same path +
error pair).

## Environment variables

- `PI_SMALL_MODEL_ADDENDUM_DISABLED=1` - skip the extension entirely.
- `PI_SMALL_MODEL_ADDENDUM_DEBUG=1` - `ctx.ui.notify` every decision (appended / skipped with the matched model label).

## Hot reload

Edit [`extensions/small-model-addendum.ts`](./small-model-addendum.ts) or
[`lib/node/pi/small-model-addendum.ts`](../../../lib/node/pi/small-model-addendum.ts) and run `/reload` in an
interactive pi session to pick up changes without restarting.
