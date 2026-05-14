# `mode.ts`

Named persona overlay for the parent session — pick a mode (planner, chat, knowledge-base, journal, …) and the parent
gets the persona body folded into the system prompt, a tool allowlist, an optional model/thinkingLevel swap, a positive
`writeRoots` gate with ask-on-violation, and optional `bashAllow` / `bashDeny` layered on top of
[`bash-permissions.ts`](./bash-permissions.ts). Modes are the missing-piece complement to [`preset.ts`](./preset.ts)
(model swap) and [`protected-paths.ts`](./protected-paths.ts) (negative read/write gate): preset answers "which model",
protected-paths answers "what's off-limits", mode answers "who am I right now and where am I allowed to write".

## What it does

Registers a `--mode` CLI flag, a `/mode` command (with `off` and `info <name>` subcommands), and a `Ctrl+Shift+M` cycle
shortcut. When a mode is activated it snapshots the current model / thinking level / active tools, applies the mode's
overrides via `pi.setActiveTools` + `pi.setModel` + `pi.setThinkingLevel`, and wires up a `before_agent_start` hook to
append the mode body (and any `appendSystemPrompt`) to the system prompt. Activation is persisted via a
`customType: 'mode-state'` session entry so `/resume` re-applies on reload; `/mode off` (or cycling past the last mode)
restores the pre-mode snapshot. Status badge `mode:<name>` reflects the active mode.

Activation is belt-and-braces validated before the mode is marked active: an unknown model, a model without auth, or a
malformed `provider/id` aborts activation with a `ctx.ui.notify` warning rather than half-applying. Unknown tool names
are dropped with a warning and the remaining valid tools are still applied.

## Mode file shape (frontmatter)

A mode is a markdown file: YAML frontmatter on top, body underneath. The frontmatter is a strict superset of the agent
frontmatter [`subagent.ts`](./subagent.ts) parses, so a mode file can be referenced as an agent and vice versa.

| Field                | Type                                   | Purpose                                                                                                                      |
| -------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `name`               | `string`                               | Mode name. Filename stem if omitted. Must be unique across layers.                                                           |
| `description`        | `string`                               | One-line shown by `/mode` listing and tab-completion.                                                                        |
| `agent`              | `string?`                              | **Mode-only.** Reference to an agent in the layered registry. Inherits `tools`, `model`, `thinkingLevel`, body.              |
| `tools`              | `string[]?`                            | Tool allowlist for the **parent** session. Validated against `pi.getAllTools()`; unknowns warned-and-dropped.                |
| `writeRoots`         | `string[]?`                            | **Mode-only.** Positive allowlist for `write` / `edit`. Tilde + `{projectSlug}` substitution. Empty ⇒ no writes.             |
| `bashAllow`          | `string[]?`                            | **Mode-only.** Bash command-prefix allowlist layered on `bash-permissions.ts`.                                               |
| `bashDeny`           | `string[]?`                            | **Mode-only.** Bash deny patterns layered on `bash-permissions.ts`. `["*"]` blocks all.                                      |
| `model`              | `string?` (`"provider/modelId"`)       | Model override. Parsed and resolved against `ctx.modelRegistry` with auth check.                                             |
| `thinkingLevel`      | `"off" \| "low" \| "medium" \| "high"` | Thinking level override.                                                                                                     |
| `appendSystemPrompt` | `string?`                              | **Mode-only.** Extra text appended after the body — useful when layering project-specific text onto an `agent:`-ref persona. |

The body markdown becomes the persona system-prompt section, prepended via `before_agent_start` with a two-newline
separator (parity with preset's `appendSystemPrompt`). A standalone mode (no `agent:` ref) uses its body verbatim. An
`agent:`-ref mode that supplies its own body uses the mode body, falling back to the inherited agent body otherwise;
`appendSystemPrompt` always appends after whichever body wins.

See [`../../../lib/node/pi/mode/`](../../../lib/node/pi/mode/) for the parsed `ParsedMode` type and the `parseModeFile`
/ `mergeAgentInheritance` / `resolveWriteRoots` / `isInsideWriteRoots` / `loadModeSettings` / `snapshotSession` helpers.

## Agent inheritance (`agent: <name>` ref)

A mode file with `agent: plan` resolves the name through the same layered agent registry the
[`subagent.ts`](./subagent.ts) extension uses — `<cwd>/.pi/agents/` overrides `~/.pi/agents/` overrides
[`../agents/`](../agents/), first hit wins. The inherited record contributes `tools`, `model`, `thinkingLevel`, and
body. Mode-only fields (`writeRoots`, `bashAllow`, `bashDeny`, `appendSystemPrompt`) layer on top. A user who forks an
agent locally automatically gets the fork wherever a mode references it.

Standalone modes (no `agent:` ref) are also valid: supply `tools`, optionally `model` / `thinkingLevel`, and the body
serves as the system-prompt addendum directly.

## Discovery and layering

Modes are loaded in order, later layers override earlier by mode name:

1. **Shipped**: `../modes/` (sibling of this extension dir, resolved from `import.meta.url`).
2. **User-global**: `~/.pi/modes/`.
3. **Project-local**: `<cwd>/.pi/modes/`.

Missing directories are silently skipped; parse errors surface once each via `ctx.ui.notify(..., 'warning')`, de-duped
by `path + reason` — same UX as `preset.ts` and `subagent-loader.ts`. Files named `README.md` are skipped so a catalog
README can sit alongside its mode files.

## `<cwd>/.pi/mode-settings.json`

Optional per-project override layer for `writeRoots`. Same JSONC parser presets use:

```jsonc
{
  // Override the default writeRoots for specific modes in this project.
  // Paths are resolved against <cwd>; absolute paths and ~/ allowed.
  "writeRoots": {
    "plan": ["docs/plans/"],
    "journal": ["~/journal/{projectSlug}/"],
    "research": ["docs/research/"],
  },

  // Future-proofing knobs (parsed, ignored in v1):
  "default": "plan",
  "disabled": ["roleplay"],
}
```

User-global is `~/.pi/mode-settings.json` with the same shape; the project layer wins per-mode-name.

## Commands

- `/mode` — list every loaded mode with its one-line description; mark the active one with `*`.
- `/mode <name>` — activate the named mode. Tab-completion is wired via `getArgumentCompletions`.
- `/mode off` (or `/mode (none)`) — clear the active mode and restore the snapshot taken at activation time.
- `/mode info <name>` — print the resolved mode (frontmatter + resolved `writeRoots` + body length + inheritance
  source). Useful for debugging the agent-inheritance merge.
- `Ctrl+Shift+M` — cycle through modes in `nameOrder`, then `(none)`, then back to the first.
- `--mode <name>` CLI flag — activate at `session_start`. Flag wins over the session-restored mode and over
  `PI_MODE_DEFAULT`.

## Write-scope gate

The `writeRoots` gate is the new primitive mode introduces. On every `tool_call` for `write` or `edit`, the extension
resolves the input path against `ctx.cwd` and checks `isInsideWriteRoots`. If the path is inside the active mode's
resolved `writeRoots`, the call passes through unchanged. If it's outside, mode invokes the same `askForPermission`
helper [`protected-paths.ts`](./protected-paths.ts) uses, offering three options:

1. **Allow once** — single-shot, no caching.
2. **Allow this session** — adds the absolute path to a `sessionAllow` cache so subsequent writes to the same path don't
   re-prompt.
3. **Deny + feedback** — returns `{ block: true, reason: <feedback> }` so the model gets an explicit deny message and
   can pick a path under `writeRoots` next turn.

An empty `writeRoots` array means writes are disallowed entirely — every `write` / `edit` triggers the prompt with the
`mode "<name>" disallows writes` reason. In no-UI mode (`-p`, JSON, RPC without UI) the default is to **block**;
`PI_MODE_VIOLATION_DEFAULT=allow` flips that to allow-on-violation.

`writeRoots` matching is **lexical** — it does not call `realpath`. A path that textually escapes via a symlink is
treated as its link path, not its target, mirroring `protected-paths.ts`'s convention. If `plans/leak` is a symlink to
`~/.ssh/`, a write to `plans/leak/config` is allowed by the gate. Documented limitation; harden in v2 if a shipped mode
needs `realpath` semantics.

## Bash policy

Per-mode `bashAllow` / `bashDeny` layer on top of [`bash-permissions.ts`](./bash-permissions.ts). Bash-permissions runs
first; if it denies, mode never sees the call. If it allows, mode's deny still wins, then mode's allow filters the
remainder. Matcher semantics are deliberately trivial:

- Exact match (`"git status"` matches the head token after splitting on whitespace).
- Prefix-with-trailing-`*` (`"ai-fetch-web *"` matches any command whose head is `ai-fetch-web`).
- Wildcard `*` matches everything.

Modes that ship `bashDeny: ["*"]` (e.g. `plan`, `journal`, `roleplay`, `review`) deny all bash. Modes with
`bashAllow: ["ai-fetch-web *", "rg *"]` (e.g. `chat`, `research`) restrict bash to those prefixes. Richer glob semantics
are deferred to v2.

## Subagents run unrestricted

Mode constraints attach to the **parent** session's `tool_call` events only. The `tool_call` interceptor explicitly
short-circuits when `event.toolName === 'subagent'` or `'subagent_send'`, so a subagent dispatched by the parent runs
with whatever its agent file's `tools` declare — even if the parent mode would forbid them. This is documented
behaviour, not a leak. If you're in `mode:explain` (read-only) and dispatch a `general-purpose` subagent, that child can
still write anywhere its own agent file allows.

This is the headline footgun of the extension. The shipped catalog's `mode:plan` body reminds the model each turn so it
doesn't accidentally route a write through `subagent(...)` to bypass the parent's gate.

## Composition with existing extensions

| Extension                                      | Interaction                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`preset.ts`](./preset.ts)                     | Orthogonal. Both extensions snapshot/restore independently. The effective active-tool set is the **intersection** because each calls `pi.setActiveTools` with its own list. Last-write-wins on `model` / `thinkingLevel`. |
| [`protected-paths.ts`](./protected-paths.ts)   | Mode can only **tighten** what protected-paths permits. Both subscribe to `tool_call`; if either says `block`, the call is blocked. Mode reuses protected-paths's `askForPermission` helper.                              |
| [`bash-permissions.ts`](./bash-permissions.ts) | Mode's `bashAllow` / `bashDeny` layer on top. Bash-permissions runs first; if it allows, mode's deny still wins. If it denies, mode never sees the call.                                                                  |
| [`subagent.ts`](./subagent.ts)                 | Subagent dispatch is **not** intercepted by mode (D4). Children run with their own agent file's `tools`.                                                                                                                  |
| [`statusline.ts`](./statusline.ts)             | Mode emits a `mode:<name>` badge segment, sibling to `preset:<name>`. Render order is whatever statusline already produces.                                                                                               |
| [`btw.ts`](./btw.ts)                           | `/btw` runs out-of-band — it doesn't go through `tool_call`. Mode does not constrain `/btw` (and shouldn't).                                                                                                              |

## Environment variables

- `PI_MODE_DISABLED=1` — skip the extension entirely (no flag, command, or shortcut registered).
- `PI_MODE_DEBUG=1` — `ctx.ui.notify` on every internal decision (snapshot taken, mode activated, write violation, …).
- `PI_MODE_DEFAULT=<name>` — auto-activate at `session_start` when neither `--mode` nor a session-restored mode is set.
- `PI_MODE_VIOLATION_DEFAULT=allow` — in non-UI mode, allow writes outside `writeRoots` instead of blocking.

Activation precedence at `session_start`: `--mode` flag > session-restored mode (from the last `mode-state` entry on
`/resume`) > `PI_MODE_DEFAULT`.

## Hot reload

Edit [`extensions/mode.ts`](./mode.ts), the helpers under [`../../../lib/node/pi/mode/`](../../../lib/node/pi/mode/), or
any catalog file under `../modes/` and run `/reload` in an interactive pi session to pick up changes without restarting.
See [`../../../plans/pi-mode-extension.md`](../../../plans/pi-mode-extension.md) for the full design rationale and the
locked decisions D1–D9.
