# `hooks.ts`

Claude Code–style user hook system for pi. Drop a shell script at a tool-call (or session) boundary without writing a
TypeScript extension. Matches the upstream `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SessionStart`
shape closely enough that existing Claude Code hook scripts work with minimal rewriting.

## Baseline example

[`../hooks-example.json`](../hooks-example.json) is an annotated JSONC starter with one commented-out example per event
class. Copy or merge into `~/.pi/hooks.json` (user scope) or `<repo>/.pi/hooks.json` (project scope), then drop your
script paths into the relevant `command` slots.

## Rule layers

Layers are loaded on every event. There's no precedence ordering across layers - all matching hooks fire in array order;
the first hook to return `block` (where `block` is legal) short-circuits the remainder.

| Layer   | Source                                        | Scope                                                 |
| ------- | --------------------------------------------- | ----------------------------------------------------- |
| Session | in-memory, cleared on `session_shutdown`      | current pi session only - reserved for a future slash |
| Project | `.pi/hooks.json` (resolved against `ctx.cwd`) | one repo                                              |
| User    | `~/.pi/hooks.json`                            | all projects                                          |

File schema (JSONC - `//` and `/* */` comments are allowed, trailing commas are not):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "command": "~/.pi/hooks/log-bash.sh",
        "timeout": 5000,
        "sandboxed": false,
      },
    ],
    "PostToolUse": [{ "matcher": "edit,write", "command": "~/.pi/hooks/run-prettier.sh" }],
    "UserPromptSubmit": [{ "command": "~/.pi/hooks/inject-cwd.sh" }],
    "Stop": [],
    "SessionStart": [],
  },
}
```

Malformed hook files log one `console.warn` per unique path+error (matches `bash-permissions`'s warning de-dup) and are
otherwise treated as empty. Missing files are silent.

### Field semantics

| Field       | Type      | Default | Notes                                                                                                                                                                                                                                                        |
| ----------- | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `matcher`   | `string?` | -       | Tool-name selector. Forms (resolved in order): `undefined` / `""` / `"*"` → matches every tool; `"re:<regex>"` → JS regex (no flags); `"a,b,c"` → comma-separated list; `"<name>"` → exact match. Optional for `UserPromptSubmit` / `Stop` / `SessionStart`. |
| `command`   | `string`  | -       | Path to executable. `~` expanded against `$HOME`. Relative paths containing `/` are resolved against `ctx.cwd`; bare commands are passed to the shell for `PATH` lookup. Invoked via `sh -c <command>` so pipes / redirects work.                            |
| `timeout`   | `number?` | `60000` | Milliseconds. The runner kills the child on timeout and surfaces the result as `block` with a `hook timed out after <n>ms` reason.                                                                                                                           |
| `sandboxed` | `bool?`   | `false` | Reserved: opt the hook into the kernel sandbox (the same wrap pi uses for model-emitted bash). v1 plumbs the field end-to-end; the actual wrap lands in a follow-up commit so the schema doesn't shift later.                                                |

Invalid regex matchers never match and print a single `console.warn` per unique pattern so typos are discoverable.
Pattern semantics mirror `bash-permissions`'s `bash-match.ts` minus the prefix form (tool names are single tokens, so
`*` is the all-tools selector instead).

## Payload (stdin → hook)

A single JSON object is written to the hook's stdin. Common fields: `event`, `cwd`, `session_id`. Event-specific
additions:

| Event              | Extra fields    |
| ------------------ | --------------- |
| `PreToolUse`       | `tool`, `input` |
| `PostToolUse`      | `tool`, `input` |
| `UserPromptSubmit` | `prompt`        |
| `Stop`             | (none)          |
| `SessionStart`     | (none)          |

Example `PreToolUse` payload for a `bash` call:

```json
{
  "event": "PreToolUse",
  "tool": "bash",
  "input": { "command": "ls -la" },
  "cwd": "/repo",
  "session_id": "abc123"
}
```

## Response (hook stdout → extension)

If stdout parses as JSON, the following fields are recognized:

```json
{
  "decision": "allow" | "block" | "continue",
  "reason": "human-readable explanation",
  "additionalContext": "text appended to tool result / system prompt"
}
```

Non-JSON stdout is treated as `additionalContext` with `decision: "continue"`. Empty stdout is `continue`. A non-zero
exit code maps to `decision: "block"` with `stderr` as `reason` (mirrors Claude Code).

### Decision matrix

| Event              | `block`                                                   | `allow`                                                        | `continue`                                                      | `additionalContext`                                                                        |
| ------------------ | --------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `PreToolUse`       | Tool error with `reason`; short-circuits remaining hooks. | Skip remaining hooks for this event; tool proceeds.            | Run the next hook; if all return `continue`, the tool proceeds. | Ignored (no tool result yet).                                                              |
| `PostToolUse`      | Illegal - logged and treated as `continue`.               | Stop running further `PostToolUse` hooks for this tool_result. | Run the next hook.                                              | Appended to the tool result as a second text part (composes with `tool-output-condenser`). |
| `UserPromptSubmit` | Cancels the turn with `reason`.                           | Stop running further hooks for this prompt.                    | Run the next hook.                                              | Appended to `event.systemPrompt` before the model sees the turn.                           |
| `Stop`             | Ignored.                                                  | Ignored.                                                       | Ignored - hook is fire-and-forget.                              | Ignored.                                                                                   |
| `SessionStart`     | Ignored.                                                  | Ignored.                                                       | Ignored - hook is fire-and-forget.                              | Ignored.                                                                                   |

## Composition with the built-in gates

Hooks fire **after** `bash-permissions`, `filesystem`, and `sandbox` have approved the call (D3 in
[`plans/pi-cc-parity.md`](../../../plans/pi-cc-parity.md)). A bash command denied by `bash-permissions` never reaches a
`PreToolUse` hook; a `read` to a denied path never reaches a `PreToolUse` hook either. This keeps the threat-model
clean: a malicious hook can refuse to let an approved command run, but it cannot vouch for one that the gates already
rejected.

Hooks run **outside** the kernel sandbox by default because they're user code, not model-emitted bash. The
`"sandboxed": true` field is reserved for the per-hook sandbox-wrap opt-in; v1 plumbs it end-to-end but does not yet
wrap, so setting it today is a no-op. The schema is locked so users can write it ahead of the wrap landing.

Within an event, hooks fire in array order: session-layer entries first, then project, then user. The order matches
`bash-permissions`'s layer order so the `/hooks` listing reads the same way.

## Worked examples

### Log every bash command

`~/.pi/hooks.json`:

```jsonc
{
  "hooks": {
    "PreToolUse": [{ "matcher": "bash", "command": "~/.pi/hooks/log-bash.sh", "timeout": 2000 }],
  },
}
```

`~/.pi/hooks/log-bash.sh` (read the payload from stdin, append to a log, return `continue`):

```bash
#!/usr/bin/env bash
set -euo pipefail
payload=$(cat)
printf '%s\t%s\n' "$(date -Iseconds)" "$payload" >> ~/.pi/bash.log
```

Empty stdout = `continue`, so the command runs.

### Run prettier on every `edit` / `write`

```jsonc
{
  "hooks": {
    "PostToolUse": [{ "matcher": "edit,write", "command": "~/.pi/hooks/run-prettier.sh", "timeout": 10000 }],
  },
}
```

The script parses `input.path` from the payload and shells out to `prettier --write`. Whatever it prints on stdout is
appended to the tool result as a second text part, which composes cleanly with `tool-output-condenser` (which runs
alphabetically later in `config/pi/extensions/`).

### Inject cwd context into every prompt

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [{ "command": "~/.pi/hooks/inject-cwd.sh" }],
  },
}
```

```bash
#!/usr/bin/env bash
printf '%s' "$(jq -r '.cwd' <<< "$(cat)" | xargs -I{} echo 'Working in {}')"
```

The stdout is appended to `event.systemPrompt` for the upcoming turn.

## Commands

- `/hooks` - list every registered hook grouped by source (session / project / user) and event. Mirrors
  `/bash-permissions`'s output shape so the two extensions read consistently.

## Environment variables

- `PI_HOOKS_DISABLED=1` - skip the extension entirely (no hooks fire, no `/hooks` registration).
- `PI_HOOKS_TIMEOUT_MS=<n>` - default per-hook timeout in milliseconds when an entry omits `timeout`. Default `60000`.
- `PI_HOOKS_DEBUG=1` - `ctx.ui.notify` each fired hook + its decision.
- `PI_HOOKS_TRACE=<path>` - append one line per fired hook to `<path>`. Useful in `-p` / RPC mode where notifications go
  nowhere.

## Hot reload

Hook files are re-read on every event, so edits to `~/.pi/hooks.json` or `<repo>/.pi/hooks.json` take effect on the next
tool call without `/reload`. Edits to the extension itself ([`hooks.ts`](./hooks.ts)) or its pure helpers under
[`lib/node/pi/hooks/`](../../../lib/node/pi/hooks/) still need `/reload`.
