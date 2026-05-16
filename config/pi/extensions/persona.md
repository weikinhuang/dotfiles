# `persona.ts`

Named persona overlay for the parent session - pick a persona (planner, chat, knowledge-base, journal, …) and the parent
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

| Field                | Type                                   | Purpose                                                                                                                                              |
| -------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | `string`                               | Persona name. Filename stem if omitted. Must be unique across layers.                                                                                |
| `description`        | `string`                               | One-line shown by `/persona` listing and tab-completion.                                                                                             |
| `agent`              | `string?`                              | **Persona-only.** Reference to an agent in the layered registry. Inherits `tools`, `model`, `thinkingLevel`, body.                                   |
| `tools`              | `string[]?`                            | Tool allowlist for the **parent** session. Validated against `pi.getAllTools()`; unknowns warned-and-dropped.                                        |
| `writeRoots`         | `string[]?`                            | **Persona-only.** Positive allowlist for `write` / `edit`. Tilde + `{projectSlug}` substitution. Empty ⇒ no writes.                                  |
| `bashAllow`          | `string[]?`                            | **Persona-only.** Bash command-prefix allowlist layered on `bash-permissions.ts`.                                                                    |
| `bashDeny`           | `string[]?`                            | **Persona-only.** Bash deny patterns layered on `bash-permissions.ts`. `["*"]` blocks all.                                                           |
| `model`              | `string?` (`"provider/modelId"`)       | Model override. Parsed and resolved against `ctx.modelRegistry` with auth check.                                                                     |
| `thinkingLevel`      | `"off" \| "low" \| "medium" \| "high"` | Thinking level override.                                                                                                                             |
| `appendSystemPrompt` | `string?`                              | **Persona-only.** Extra text appended after the body - useful when layering project-specific text onto an `agent:`-ref persona.                      |
| `requestOptions`     | `object?`                              | **Persona-only.** Free-form fields deep-merged into the outgoing provider payload via `before_provider_request`. See `requestOptions` section below. |

The body markdown becomes the persona system-prompt section, prepended via `before_agent_start` with a two-newline
separator (parity with preset's `appendSystemPrompt`). A standalone persona (no `agent:` ref) uses its body verbatim. An
`agent:`-ref persona that supplies its own body uses the persona body, falling back to the inherited agent body
otherwise; `appendSystemPrompt` always appends after whichever body wins.

See [`../../../lib/node/pi/persona/`](../../../lib/node/pi/persona/) for the parsed `ParsedPersona` type and the
`parsePersonaFile` / `mergeAgentInheritance` / `resolveWriteRoots` / `isInsideWriteRoots` / `loadPersonaSettings` /
`snapshotSession` helpers.

## Agent inheritance (`agent: <name>` ref)

A persona file with `agent: plan` resolves the name through the same layered agent registry the
[`subagent.ts`](./subagent.ts) extension uses - `<cwd>/.pi/agents/` overrides `~/.pi/agents/` overrides
[`../agents/`](../agents/), first hit wins. The inherited record contributes `tools`, `model`, `thinkingLevel`, and
body. Persona-only fields (`writeRoots`, `bashAllow`, `bashDeny`, `appendSystemPrompt`, `requestOptions`) layer on top.
A user who forks an agent locally automatically gets the fork wherever a persona references it.

Standalone personas (no `agent:` ref) are also valid: supply `tools`, optionally `model` / `thinkingLevel`, and the body
serves as the system-prompt addendum directly.

## Discovery and layering

Personas are loaded in order, later layers override earlier by persona name:

1. **Shipped**: `../personas/` (sibling of this extension dir, resolved from `import.meta.url`).
2. **User-global**: `~/.pi/personas/`.
3. **Project-local**: `<cwd>/.pi/personas/`.

Missing directories are silently skipped; parse errors surface once each via `ctx.ui.notify(..., 'warning')`, de-duped
by `path + reason` - same UX as `preset.ts` and `subagent-loader.ts`. Files named `README.md` are skipped so a catalog
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

- `/persona` - list every loaded persona with its one-line description; mark the active one with `*`.
- `/persona <name>` - activate the named persona. Tab-completion is wired via `getArgumentCompletions`.
- `/persona off` (or `/persona (none)`) - clear the active persona and restore the snapshot taken at activation time.
- `/persona info <name>` - print the resolved persona (frontmatter + resolved `writeRoots` + body length + inheritance
  source). Useful for debugging the agent-inheritance merge.
- `Ctrl+Shift+M` - cycle through personas in `nameOrder`, then `(none)`, then back to the first.
- `--persona <name>` CLI flag - activate at `session_start`. Flag wins over the session-restored persona and over
  `PI_PERSONA_DEFAULT`.
- `--persona-info <name>` CLI flag - print the resolved persona (same surface as `/persona info <name>`) to stdout and
  exit. Useful in `pi -p` / scripting mode where slash commands are not dispatched. Exits non-zero if `<name>` is
  unknown.
- `--list-personas` CLI flag - print one line per loaded persona (`name  [source] description`) and exit 0. The active
  persona, if any, is prefixed with `*`.
- `--validate-personas` CLI flag - parse every persona file across all layers, print one `<path>: <reason>` per warning,
  and exit non-zero if any warning fired. Designed for CI gating: `pi --validate-personas && …`.

> **Why `--persona` and not `--mode`?** Pi's CLI parser reserves `--mode` for the built-in output-mode flag
> (`text|json|rpc`); a user-extension flag named `mode` is silently shadowed. `--persona` sidesteps the collision and
> reads naturally given the body IS a persona overlay.
>
> The three query / validation flags (`--persona-info`, `--list-personas`, `--validate-personas`) short-circuit at
> `session_start` via `process.exit()` - they print to stdout (or stderr on error) and never invoke a model. Run with
> `--no-session` if you don't want the validation invocation to leave a session transcript on disk.

## Write-scope gate

The `writeRoots` gate is the new primitive personas introduce. On every `tool_call` for `write` or `edit`, the extension
resolves the input path against `ctx.cwd` and checks `isInsideWriteRoots`. If the path is inside the active persona's
resolved `writeRoots`, the call passes through unchanged. If it's outside, persona invokes the same `askForPermission`
helper [`protected-paths.ts`](./protected-paths.ts) uses, offering three options:

1. **Allow once** - single-shot, no caching.
2. **Allow this session** - adds the absolute path to a `sessionAllow` cache so subsequent writes to the same path don't
   re-prompt.
3. **Deny + feedback** - returns `{ block: true, reason: <feedback> }` so the model gets an explicit deny message and
   can pick a path under `writeRoots` next turn.

An empty `writeRoots` array means writes are disallowed entirely - every `write` / `edit` triggers the prompt with the
`persona "<name>" disallows writes` reason. In no-UI mode (`-p`, JSON, RPC without UI) the default is to **block**;
`PI_PERSONA_VIOLATION_DEFAULT=allow` flips that to allow-on-violation.

`writeRoots` matching is **lexical** - it does not call `realpath`. A path that textually escapes via a symlink is
treated as its link path, not its target, mirroring `protected-paths.ts`'s convention. If `plans/leak` is a symlink to
`~/.ssh/`, a write to `plans/leak/config` is allowed by the gate. Documented limitation; harden in v2 if a shipped
persona needs `realpath` semantics.

## Bash policy

Per-persona `bashAllow` / `bashDeny` layer on top of [`bash-permissions.ts`](./bash-permissions.ts). The two extensions
compose as follows:

1. **Hardcoded deny** in `bash-permissions.ts` (rm -rf /, mkfs, fork bombs, …) ALWAYS blocks first.
2. **Explicit deny** rules in `bash-permissions.json` (any layer) block.
3. **Always-prompt list** (sudo / doas / pkexec / …) ALWAYS forces a dialog - a persona's `bashAllow` cannot wave
   privilege escalation through.
4. **Explicit allow** rules in `bash-permissions.json` (any layer) allow.
5. **Persona vouch.** When the active persona's `bashAllow` matches the sub-command, `bash-permissions.ts` treats the
   call as session-allowed by the user-author of the persona file. No file on disk is touched. This vouch is the reason
   a persona shipping `bashAllow: ['ai-fetch-web *']` Just Works in `pi -p` / non-UI mode without forcing the user to
   also widen their `~/.pi/bash-permissions.json` allowlist. Implementation:
   [`lib/node/pi/persona/bash-vouch.ts`](../../../lib/node/pi/persona/bash-vouch.ts) consulting the same
   [`active.ts`](../../../lib/node/pi/persona/active.ts) singleton that powers the `writeRoots` vouch.
6. Otherwise: prompt (UI) or block with a diagnostic (non-UI).

After `bash-permissions.ts` admits the call, persona's own `tool_call` handler runs `evaluateBashPolicy`:

1. `bashAllow` matches → allow (carves out of any persona-level deny).
2. `bashDeny` matches → block.
3. `bashAllow` non-empty but doesn't match → block (allow-list mode - declaring `bashAllow` at all is a positive
   assertion of “ONLY these commands”).
4. Otherwise allow.

So `bashAllow` wins over `bashDeny` on overlap. Concretely: shipping `bashAllow: ["rg *"]` + `bashDeny: ["*"]` means
“deny everything, except carve out rg” - `rg pattern` runs, every other command is blocked.

Matcher semantics are deliberately trivial:

- Exact match (`"git status"` matches the head token after splitting on whitespace).
- Prefix-with-trailing-`*` (`"ai-fetch-web *"` matches any command whose head is `ai-fetch-web`).
- Wildcard `*` matches everything.

Personas that ship `bashDeny: ["*"]` alone (e.g. `plan`, `journal`, `roleplay`, `review`) deny all bash. Personas with
`bashAllow: ["ai-fetch-web *", "rg *"]` (e.g. `chat`, `research`) restrict bash to those prefixes. Richer glob semantics
are deferred to v2.

## `requestOptions`

A persona may carry a free-form `requestOptions` block that is deep-merged into the outgoing provider payload via pi's
`before_provider_request` event whenever that persona is active. The merge runs after pi-ai has built the payload, so an
explicit `temperature: 0.7` from the persona overwrites pi-ai's defaults for that field. Pure-helper implementation +
schema lives in [`lib/node/pi/request-options.ts`](../../../lib/node/pi/request-options.ts).

```yaml
requestOptions:
  apis: [openai-completions] # optional API filter
  temperature: 0.7
  top_p: 0.95
  top_k: 40
  chat_template_kwargs:
    enable_thinking: true
```

Merge rules:

- Top-level keys are deep-merged into the payload - nested objects recurse, arrays / primitives from the override fully
  replace the original. So a persona can add `chat_template_kwargs.enable_thinking` without nuking the
  `preserve_thinking` key pi-ai already injects for the qwen-chat-template thinking format.
- The reserved `apis` key is a string list of API families this block applies to (e.g. `["openai-completions"]`,
  `["anthropic-messages"]`). When omitted or empty, the override applies to every provider.
- The `apis` filter matters because some providers (Anthropic Messages especially, and Bedrock Converse) reject unknown
  top-level fields with a 400. Scoping a llama.cpp-only `chat_template_kwargs` block to `apis: [openai-completions]`
  keeps it from leaking into an Anthropic payload when the user changes models mid-session.
- Field names match the **provider wire format**, not pi-ai's internal `StreamOptions` (which only formally exposes
  `temperature`, `maxTokens`, `metadata`, `cacheRetention`, `thinkingBudgets`). Use `top_p` / `top_k` / `stop` /
  `chat_template_kwargs` etc. as the upstream API expects them.

## Subagents run unrestricted

Persona constraints attach to the **parent** session's `tool_call` events only. The `tool_call` interceptor explicitly
short-circuits when `event.toolName === 'subagent'` or `'subagent_send'`, so a subagent dispatched by the parent runs
with whatever its agent file's `tools` declare - even if the parent persona would forbid them. This is documented
behaviour, not a leak. If you're in the `explain` persona (read-only) and dispatch a `general-purpose` subagent, that
child can still write anywhere its own agent file allows.

This is the headline footgun of the extension. The shipped catalog's `plan` persona body reminds the model each turn so
it doesn't accidentally route a write through `subagent(...)` to bypass the parent's gate.

## Composition with existing extensions

| Extension                                      | Interaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`preset.ts`](./preset.ts)                     | Orthogonal. Both extensions snapshot/restore independently. The effective active-tool set is the **intersection** because each calls `pi.setActiveTools` with its own list. Last-write-wins on `model` / `thinkingLevel`.                                                                                                                                                                                                                                                                                                              |
| [`protected-paths.ts`](./protected-paths.ts)   | Persona's `writeRoots` are now a **positive vouch** that protected-paths honors: writes targeting a path inside the active persona's resolved `writeRoots` skip the protected-paths gate entirely (reads are unaffected). The vouch flows through `lib/node/pi/persona/active.ts`'s singleton, which persona publishes on activate / clear / `session_shutdown`. Persona's own write-gate still runs first; if a path is outside `writeRoots`, both gates can still block. Persona reuses protected-paths's `askForPermission` helper. |
| [`bash-permissions.ts`](./bash-permissions.ts) | Two-way composition. Bash-permissions runs first: hardcoded deny / explicit deny / always-prompt always win. The active persona's `bashAllow` then **vouches** for sub-commands at the unknown-command step (mirrors `writeRoots` → protected-paths), so personas Just Work in `pi -p` without widening `~/.pi/bash-permissions.json` on disk. After admission, persona's own `tool_call` handler enforces its `bashDeny` (terminal) and `bashAllow` (restrictive only).                                                               |
| [`subagent.ts`](./subagent.ts)                 | Subagent dispatch is **not** intercepted by persona (D4). Children run with their own agent file's `tools`.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [`statusline.ts`](./statusline.ts)             | Persona emits a `persona:<name>` badge segment, sibling to `preset:<name>`. Render order is whatever statusline already produces.                                                                                                                                                                                                                                                                                                                                                                                                      |
| [`btw.ts`](./btw.ts)                           | `/btw` runs out-of-band - it doesn't go through `tool_call`. Persona does not constrain `/btw` (and shouldn't).                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Environment variables

- `PI_PERSONA_DISABLED=1` - skip the extension entirely (no flag, command, or shortcut registered).
- `PI_PERSONA_DEBUG=1` - `ctx.ui.notify` on every internal decision (snapshot taken, persona activated, write violation,
  …).
- `PI_PERSONA_DEFAULT=<name>` - auto-activate at `session_start` when neither `--persona` nor a session-restored persona
  is set.
- `PI_PERSONA_VIOLATION_DEFAULT=allow` - in non-UI mode, allow writes outside `writeRoots` instead of blocking.

Activation precedence at `session_start`: `--persona` flag > session-restored persona (from the last `persona-state`
entry on `/resume`) > `PI_PERSONA_DEFAULT`.

## Hot reload

Edit [`extensions/persona.ts`](./persona.ts), the helpers under
[`../../../lib/node/pi/persona/`](../../../lib/node/pi/persona/), or any catalog file under `../personas/` and run
`/reload` in an interactive pi session to pick up changes without restarting. See
