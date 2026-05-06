# `preset.ts`

Named bundles that swap model, thinking level, active tool set, and an optional system-prompt addendum in one command —
the friction-reducer for flipping between remote heavy-reasoning models (Bedrock Opus) and cheap self-hosted ones
(llama.cpp qwen3). Presets are loaded from layered JSONC files; [`../presets.json`](../presets.json) ships with the
repo.

## What it does

Registers a `--preset` CLI flag, a `/preset` command, and a `Ctrl+Shift+U` cycle shortcut. When a preset is activated it
snapshots the current model / thinking level / active tools, applies the preset's overrides, and wires up a
`before_agent_start` hook to append `appendSystemPrompt` (if set) to the system prompt. Activation is persisted to the
session via a `customType: 'preset-state'` entry so `/resume` re-applies on reload; `/preset off` (or cycling past the
last preset) restores the pre-preset snapshot. If a preset's `model` is malformed, unknown, or lacks auth, activation
aborts _before_ marking it active — a failing preset never masquerades as working.

Each applied field is validated against the live registry: unknown tool names are dropped with a warning, invalid model
specs surface via `ctx.ui.notify` rather than silently no-op'ing. Status badge `preset:<name>` reflects the active
preset.

## Preset shape

A preset is an entry in the top-level object of `presets.json`, keyed by name. All fields are optional — a preset may
tweak a single knob.

| Field                | Type                                   | Purpose                                                                                         |
| -------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `model`              | `string` (`"provider/modelId"`)        | Model to switch to. Parsed via `parseModelSpec`; must resolve in `ctx.modelRegistry` with auth. |
| `thinkingLevel`      | `"off" \| "low" \| "medium" \| "high"` | Forwarded to `pi.setThinkingLevel`.                                                             |
| `tools`              | `string[]`                             | Active tool allow-list. Validated against `pi.getAllTools()`; unknowns warned-and-dropped.      |
| `appendSystemPrompt` | `string`                               | Appended to the system prompt on every turn while the preset is active (two-newline separator). |

See [`../../../lib/node/pi/preset.ts`](../../../lib/node/pi/preset.ts) for the parsed `Preset` / `PresetsConfig` types
and `describePreset` / `loadPresetFiles` helpers.

## Commands

- `/preset` — list every preset with its one-line description; marks the active one with `*`.
- `/preset <name>` — activate a preset. Tab-completion is wired via `getArgumentCompletions`.
- `/preset off` (or `/preset (none)`) — clear the active preset and restore the snapshot taken at activation time.
- `Ctrl+Shift+U` — cycle through presets in `nameOrder`, then `(none)`, then back to the first.
- `--preset <name>` CLI flag — activate at `session_start`. Flag wins over the session-restored preset name.

## `presets.json` location

Loaded in order (later layers override earlier by preset name):

1. **Shipped**: [`../presets.json`](../presets.json) (sibling of this extension, resolved from `import.meta.url`).
2. **User-global**: `~/.pi/agent/presets.json`.
3. **Project-local**: `<cwd>/.pi/presets.json`.

Missing files are silently skipped; parse errors are surfaced once each via `ctx.ui.notify(..., 'warning')` (de-duped by
path + error).

## Environment variables

- `PI_PRESET_DISABLED=1` — skip the extension entirely (no flag, command, or shortcut registered).
- `PI_PRESET_DEBUG=1` — `ctx.ui.notify` on every internal decision (snapshot taken, preset activated, …).

## Hot reload

Edit [`extensions/preset.ts`](./preset.ts), [`../presets.json`](../presets.json), or the helpers in
[`../../../lib/node/pi/preset.ts`](../../../lib/node/pi/preset.ts) and run `/reload` in an interactive pi session to
pick up changes without restarting.
