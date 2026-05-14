# `persona.ts`

Named persona overlay for the parent session — pick a persona (planner, chat, knowledge-base, journal, …) and the parent
gets the persona body folded into the system prompt, a tool allowlist, an optional model/thinkingLevel swap, a positive
`writeRoots` gate with ask-on-violation, and optional `bashAllow` / `bashDeny` layered on top of
[`bash-permissions.ts`](./bash-permissions.ts). Personas are the missing-piece complement to [`preset.ts`](./preset.ts)
(model swap) and [`protected-paths.ts`](./protected-paths.ts) (negative read/write gate): preset answers "which model",
protected-paths answers "what's off-limits", persona answers "who am I right now and where am I allowed to write".

## What it does

Registers a `--persona` CLI flag, a `/persona` command (with `off` and `info <name>` subcommands), and a `Ctrl+Shift+M`
cycle shortcut. When a persona is activated it snapshots the current model / thinking level / active tools, applies the
persona's overrides via `pi.setActiveTools` + `pi.setModel` + `pi.setThinkingLevel`, and wires up a `before_agent_start`
hook to append the persona body (and any `appendSystemPrompt`) to the system prompt. Activation is persisted via a
`customType: 'persona-state'` session entry so `/resume` re-applies on reload; `/persona off` (or cycling past the last
persona) restores the pre-persona snapshot. Status badge `persona:<name>` reflects the active persona.

Activation is belt-and-braces validated before the persona is marked active: an unknown model, a model without auth, or
a malformed `provider/id` aborts activation with a `ctx.ui.notify` warning rather than half-applying. Unknown tool names
are dropped with a warning and the remaining valid tools are still applied.

## Persona file shape (frontmatter)

A persona is a markdown file: YAML frontmatter on top, body underneath. The frontmatter is a strict superset of the
agent frontmatter [`subagent.ts`](./subagent.ts) parses, so a persona file can be referenced as an agent and vice versa.

| Field                | Type                                   | Purpose                                                                                                                         |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | `string`                               | Persona name. Filename stem if omitted. Must be unique across layers.                                                           |
| `description`        | `string`                               | One-line shown by `/persona` listing and tab-completion.                                                                        |
| `agent`              | `string?`                              | **Persona-only.** Reference to an agent in the layered registry. Inherits `tools`, `model`, `thinkingLevel`, body.              |
| `tools`              | `string[]?`                            | Tool allowlist for the **parent** session. Validated against `pi.getAllTools()`; unknowns warned-and-dropped.                   |
| `writeRoots`         | `string[]?`                            | **Persona-only.** Positive allowlist for `write` / `edit`. Tilde + `{projectSlug}` substitution. Empty ⇒ no writes.             |
| `bashAllow`          | `string[]?`                            | **Persona-only.** Bash command-prefix allowlist layered on `bash-permissions.ts`.                                               |
| `bashDeny`           | `string[]?`                            | **Persona-only.** Bash deny patterns layered on `bash-permissions.ts`. `["*"]` blocks all.                                      |
| `model`              | `string?` (`"provider/modelId"`)       | Model override. Parsed and resolved against `ctx.modelRegistry` with auth check.                                                |
| `thinkingLevel`      | `"off" \| "low" \| "medium" \| "high"` | Thinking level override.                                                                                                        |
| `appendSystemPrompt` | `string?`                              | **Persona-only.** Extra text appended after the body — useful when layering project-specific text onto an `agent:`-ref persona. |

The body markdown becomes the persona system-prompt section, prepended via `before_agent_start` with a two-newline
separator (parity with preset's `appendSystemPrompt`). A standalone persona (no `agent:` ref) uses its body verbatim. An
`agent:`-ref persona that supplies its own body uses the persona body, falling back to the inherited agent body
otherwise; `appendSystemPrompt` always appends after whichever body wins.

See [`../../../lib/node/pi/persona/`](../../../lib/node/pi/persona/) for the parsed `ParsedPersona` type and the
`parsePersonaFile` / `mergeAgentInheritance` / `resolveWriteRoots` / `isInsideWriteRoots` / `loadPersonaSettings` /
`snapshotSession` helpers.

## Agent inheritance (`agent: <name>` ref)

A persona file with `agent: plan` resolves the name through the same layered agent registry the
[`subagent.ts`](./subagent.ts) extension uses — `<cwd>/.pi/agents/` overrides `~/.pi/agents/` overrides
[`../agents/`](../agents/), first hit wins. The inherited record contributes `tools`, `model`, `thinkingLevel`, and
body. Persona-only fields (`writeRoots`, `bashAllow`, `bashDeny`, `appendSystemPrompt`) layer on top. A user who forks
an agent locally automatically gets the fork wherever a persona references it.

Standalone personas (no `agent:` ref) are also valid: supply `tools`, optionally `model` / `thinkingLevel`, and the body
serves as the system-prompt addendum directly.

## Discovery and layering

Personas are loaded in order, later layers override earlier by persona name:

1. **Shipped**: `../personas/` (sibling of this extension dir, resolved from `import.meta.url`).
2. **User-global**: `~/.pi/personas/`.
3. **Project-local**: `<cwd>/.pi/personas/`.

Missing directories are silently skipped; parse errors surface once each via `ctx.ui.notify(..., 'warning')`, de-duped
by `path + reason` — same UX as `preset.ts` and `subagent-loader.ts`. Files named `README.md` are skipped so a catalog
README can sit alongside its persona files.

## `<cwd>/.pi/persona-settings.json`

Optional per-project override layer for `writeRoots`. Same JSONC parser presets use:

```jsonc
{
  // Override the default writeRoots for specific personas in this project.
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

User-global is `~/.pi/persona-settings.json` with the same shape; the project layer wins per-persona-name.

## Commands

- `/persona` — list every loaded persona with its one-line description; mark the active one with `*`.
- `/persona <name>` — activate the named persona. Tab-completion is wired via `getArgumentCompletions`.
- `/persona off` (or `/persona (none)`) — clear the active persona and restore the snapshot taken at activation time.
- `/persona info <name>` — print the resolved persona (frontmatter + resolved `writeRoots` + body length + inheritance
  source). Useful for debugging the agent-inheritance merge.
- `Ctrl+Shift+M` — cycle through personas in `nameOrder`, then `(none)`, then back to the first.
- `--persona <name>` CLI flag — activate at `session_start`. Flag wins over the session-restored persona and over
  `PI_PERSONA_DEFAULT`.

> **Why `--persona` and not `--mode`?** Pi's CLI parser reserves `--mode` for the built-in output-mode flag
> (`text|json|rpc`); a user-extension flag named `mode` is silently shadowed. `--persona` sidesteps the collision and
> reads naturally given the body IS a persona overlay.

## Write-scope gate

The `writeRoots` gate is the new primitive personas introduce. On every `tool_call` for `write` or `edit`, the extension
resolves the input path against `ctx.cwd` and checks `isInsideWriteRoots`. If the path is inside the active persona's
resolved `writeRoots`, the call passes through unchanged. If it's outside, persona invokes the same `askForPermission`
helper [`protected-paths.ts`](./protected-paths.ts) uses, offering three options:

1. **Allow once** — single-shot, no caching.
2. **Allow this session** — adds the absolute path to a `sessionAllow` cache so subsequent writes to the same path don't
   re-prompt.
3. **Deny + feedback** — returns `{ block: true, reason: <feedback> }` so the model gets an explicit deny message and
   can pick a path under `writeRoots` next turn.

An empty `writeRoots` array means writes are disallowed entirely — every `write` / `edit` triggers the prompt with the
`persona "<name>" disallows writes` reason. In no-UI mode (`-p`, JSON, RPC without UI) the default is to **block**;
`PI_PERSONA_VIOLATION_DEFAULT=allow` flips that to allow-on-violation.

`writeRoots` matching is **lexical** — it does not call `realpath`. A path that textually escapes via a symlink is
treated as its link path, not its target, mirroring `protected-paths.ts`'s convention. If `plans/leak` is a symlink to
`~/.ssh/`, a write to `plans/leak/config` is allowed by the gate. Documented limitation; harden in v2 if a shipped
persona needs `realpath` semantics.

## Bash policy

Per-persona `bashAllow` / `bashDeny` layer on top of [`bash-permissions.ts`](./bash-permissions.ts). Bash-permissions
runs first; if it denies, persona never sees the call. If it allows, persona's deny still wins, then persona's allow
filters the remainder. Matcher semantics are deliberately trivial:

- Exact match (`"git status"` matches the head token after splitting on whitespace).
- Prefix-with-trailing-`*` (`"ai-fetch-web *"` matches any command whose head is `ai-fetch-web`).
- Wildcard `*` matches everything.

Personas that ship `bashDeny: ["*"]` (e.g. `plan`, `journal`, `roleplay`, `review`) deny all bash. Personas with
`bashAllow: ["ai-fetch-web *", "rg *"]` (e.g. `chat`, `research`) restrict bash to those prefixes. Richer glob semantics
are deferred to v2.

## Subagents run unrestricted

Persona constraints attach to the **parent** session's `tool_call` events only. The `tool_call` interceptor explicitly
short-circuits when `event.toolName === 'subagent'` or `'subagent_send'`, so a subagent dispatched by the parent runs
with whatever its agent file's `tools` declare — even if the parent persona would forbid them. This is documented
behaviour, not a leak. If you're in the `explain` persona (read-only) and dispatch a `general-purpose` subagent, that
child can still write anywhere its own agent file allows.

This is the headline footgun of the extension. The shipped catalog's `plan` persona body reminds the model each turn so
it doesn't accidentally route a write through `subagent(...)` to bypass the parent's gate.

## Composition with existing extensions

| Extension                                      | Interaction                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`preset.ts`](./preset.ts)                     | Orthogonal. Both extensions snapshot/restore independently. The effective active-tool set is the **intersection** because each calls `pi.setActiveTools` with its own list. Last-write-wins on `model` / `thinkingLevel`. |
| [`protected-paths.ts`](./protected-paths.ts)   | Persona can only **tighten** what protected-paths permits. Both subscribe to `tool_call`; if either says `block`, the call is blocked. Persona reuses protected-paths's `askForPermission` helper.                        |
| [`bash-permissions.ts`](./bash-permissions.ts) | Persona's `bashAllow` / `bashDeny` layer on top. Bash-permissions runs first; if it allows, persona's deny still wins. If it denies, persona never sees the call.                                                         |
| [`subagent.ts`](./subagent.ts)                 | Subagent dispatch is **not** intercepted by persona (D4). Children run with their own agent file's `tools`.                                                                                                               |
| [`statusline.ts`](./statusline.ts)             | Persona emits a `persona:<name>` badge segment, sibling to `preset:<name>`. Render order is whatever statusline already produces.                                                                                         |
| [`btw.ts`](./btw.ts)                           | `/btw` runs out-of-band — it doesn't go through `tool_call`. Persona does not constrain `/btw` (and shouldn't).                                                                                                           |

## Environment variables

- `PI_PERSONA_DISABLED=1` — skip the extension entirely (no flag, command, or shortcut registered).
- `PI_PERSONA_DEBUG=1` — `ctx.ui.notify` on every internal decision (snapshot taken, persona activated, write violation,
  …).
- `PI_PERSONA_DEFAULT=<name>` — auto-activate at `session_start` when neither `--persona` nor a session-restored persona
  is set.
- `PI_PERSONA_VIOLATION_DEFAULT=allow` — in non-UI mode, allow writes outside `writeRoots` instead of blocking.

Activation precedence at `session_start`: `--persona` flag > session-restored persona (from the last `persona-state`
entry on `/resume`) > `PI_PERSONA_DEFAULT`.

## Hot reload

Edit [`extensions/persona.ts`](./persona.ts), the helpers under
[`../../../lib/node/pi/persona/`](../../../lib/node/pi/persona/), or any catalog file under `../personas/` and run
`/reload` in an interactive pi session to pick up changes without restarting. See
[`../../../plans/pi-mode-extension.md`](../../../plans/pi-mode-extension.md) for the full design rationale and the
locked decisions D1–D9.
