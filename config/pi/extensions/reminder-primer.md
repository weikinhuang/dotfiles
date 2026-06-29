# `reminder-primer.ts`

Appends a short, static primer to the system prompt that teaches the model the `<system-reminder>` convention - but only
when the active model isn't already a Claude / Anthropic model. Aimed at non-Claude models (local llama.cpp / vLLM
servers, GPT, Gemini, Qwen, …) that lack the training prior Claude has for that framing.

## Why

`todo`, `scratchpad`, `bg-bash`, `context-budget`, and `roleplay` splice an ephemeral
`<system-reminder id="…">…</system-reminder>` block into the last user / tool-result message every turn (see
[`context-reminder.ts`](../../../lib/node/pi/context-reminder.ts)). Claude models read that framing as ephemeral,
harness-authored current state. A non-Claude model still reads the text but can misattribute authorship - treating a
harness budget line as "the user is asking about the budget", or trying to act on injected state as if it were an
instruction. This extension supplies the missing prior so the content is interpreted as system context, not user input.

The primer is **constant**, so it sits in the cached system-prompt prefix and never busts it. This is the opposite of
the trap the per-turn reminders avoid: there it is the per-turn _mutation_ of the system prompt that is cache-hostile,
which is why those reminders go through the `context` hook instead. A one-time static primer is free after the first
request.

## What it does

On `before_agent_start`:

1. Load the config (lazy, cached per session) and decide via
   [`shouldInjectPrimer`](../../../lib/node/pi/reminder-primer.ts) whether to fire.
2. In the default `auto` mode, inject **unless** the model is a Claude / Anthropic model. The gate is on the **model**,
   not the provider: [`modelKnowsReminders`](../../../lib/node/pi/reminder-primer.ts) matches `claude` / `anthropic` in
   the provider or id, so Claude served via `openrouter` / `amazon-bedrock` / `google-vertex` is still recognised, and a
   Llama model served via `amazon-bedrock` is still primed.
3. On inject → call [`appendPrimer`](../../../lib/node/pi/reminder-primer.ts) on the current `systemPrompt` (or
   `ctx.getSystemPrompt()` when the event omits it) and return `{ systemPrompt: next }`. Pi chains `before_agent_start`
   handlers, so this composes with `small-model-addendum` and anything else that rewrites the prompt.
4. Set the statusline key to `✓ reminder primer active` so the user can verify the extension fired; clear it when it
   skips.

Config is reloaded on each `session_start`, so edits to the JSON files are picked up on `/new`, `/resume`, `/fork`,
`/reload` without requiring an extension reload.

## Config

User config lives at `~/.pi/agent/reminder-primer.json` or project `.pi/reminder-primer.json` (JSONC):

```json
{
  "mode": "auto",
  "text": "## Injected reminders\n- ..."
}
```

- `mode: "auto" | "always" | "never"` - `auto` (default) skips Claude / Anthropic models; `always` injects regardless of
  model; `never` is installed but silent.
- `text: string` - primer body appended verbatim to the system prompt.

Missing fields fall back to sensible defaults; the default `text` lives in
[`lib/node/pi/reminder-primer.ts`](../../../lib/node/pi/reminder-primer.ts) and is editable without patching the
extension. Parse / IO failures surface as a single `ctx.ui.notify` warning (never re-notified for the same path + error
pair).

## Environment variables

- `PI_REMINDER_PRIMER_DISABLED=1` - skip the extension entirely.
- `PI_REMINDER_PRIMER_DEBUG=1` - `ctx.ui.notify` every decision (appended / skipped with the model label and mode).

## Hot reload

Edit [`extensions/reminder-primer.ts`](./reminder-primer.ts) or
[`lib/node/pi/reminder-primer.ts`](../../../lib/node/pi/reminder-primer.ts) and run `/reload` in an interactive pi
session to pick up changes without restarting.
