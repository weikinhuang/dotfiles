---
name: hooks-author
description:
  When to reach for a user hook (`~/.pi/agent/hooks.json` / `<repo>/.pi/hooks.json`) over an ad-hoc bash command or a
  full pi extension. Use when the user asks things like "can I run X every time pi does Y", "from now on when Z happens,
  do W", "log every bash command", "format files after edit", "inject context into every prompt", or to wire a Claude
  Code hook into pi. Do not suggest a hook for one-shot tasks, to replace a built-in gate, or for behavior that needs
  new pi events or tool registration.
---

# Hooks Author

The `hooks` extension lets a user drop a shell script at a tool-call (or session) boundary without writing TypeScript.
This skill teaches WHEN a hook is the right tool, which event to pick, and how to shape the script so the runner reads
the response correctly.

Reference: [`config/pi/extensions/hooks.md`](../../extensions/hooks.md) is the full spec (schema, payload, decision
matrix, env vars). Read it once before authoring a new hook; come back here for the judgment calls.

## Decision: hook vs ad-hoc command vs extension

Three options for "do X when pi does Y". Pick by how durable and how integrated the behavior needs to be.

| You want…                                                                                                                | Use                  |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| To run a bash command once, right now                                                                                    | Just run the bash    |
| Side-effect or context injection that should fire on **every** tool call / prompt / session, configured per-user or repo | **Hook**             |
| A new tool, a new slash command, a new pi event listener, or behavior that needs typed pi state                          | TypeScript extension |
| A new permissions allow / deny rule                                                                                      | `bash-permissions`   |
| A new filesystem read / write policy                                                                                     | `filesystem`         |

Reach for a hook when **all** of these hold:

- The trigger is one of the five Claude-Code-compatible events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`,
  `SessionStart`.
- The behavior is _user-trusted_ - the user (not the model) chose to install it.
- The work is short enough to fit in a script call and finish under the `timeout` (default 60s).
- The right answer is the same every time the trigger fires; you don't need new pi state or a new tool.

If any of those break, write an extension instead. Extensions are the right home for new tools, new slash commands,
typed event payloads, or anything that has to compose with another extension's state.

## Pick the event

| Event              | Fires on                                             | Can `block`? | Use it for                                                        |
| ------------------ | ---------------------------------------------------- | ------------ | ----------------------------------------------------------------- |
| `PreToolUse`       | A tool call that's already passed the built-in gates | Yes          | Audit log, last-mile deny, redact arguments before the tool runs. |
| `PostToolUse`      | A tool result on its way back                        | No           | Format-on-write, lint-on-edit, append context to the tool result. |
| `UserPromptSubmit` | A user turn about to start                           | Yes          | Inject cwd / branch / ticket context into the system prompt.      |
| `SessionStart`     | pi session is starting                               | No           | Warm caches, print a banner, kick off a background sync.          |
| `Stop`             | pi session is shutting down                          | No           | Flush a log, post a summary somewhere.                            |

Important constraints:

- `PostToolUse`, `Stop`, `SessionStart` are fire-and-forget for decisions - a `block` here is illegal and gets logged +
  treated as `continue`. Don't author a "block on post" hook; that's a `PreToolUse` job.
- Hooks fire **after** `bash-permissions`, `filesystem`, and `sandbox` have approved the call. A bash command the
  permissions gate already denied never reaches a `PreToolUse` hook - don't try to use a hook to weaken or override a
  built-in gate.

## Match the right tool

`matcher` semantics (full reference in [`hooks.md`](../../extensions/hooks.md#field-semantics)):

| Form                   | Matches                           |
| ---------------------- | --------------------------------- |
| omitted / `""` / `"*"` | every tool                        |
| `"bash"`               | exact name                        |
| `"edit,write"`         | comma-separated list (exact each) |
| `"re:^edit$"`          | JS regex (no flags)               |

For events without a tool dimension (`UserPromptSubmit`, `Stop`, `SessionStart`) omit `matcher` entirely.

## Author the script, not the config

Keep the JSONC entry thin. Logic lives in the script the entry calls - that's what gets edited, tested, and version
controlled separately from the config.

A typical hook script:

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Read the payload (single JSON object on stdin).
payload=$(cat)

# 2. Do the work. `jq` is the easiest way to pull fields.
tool=$(jq -r '.tool // empty' <<< "$payload")
cmd=$(jq -r '.input.command // empty' <<< "$payload")

# 3. Append to a log, format a file, etc.
printf '%s\t%s\t%s\n' "$(date -Iseconds)" "$tool" "$cmd" >> ~/.pi/bash.log

# 4. Empty stdout = `continue`. Exit 0.
```

Decision protocol cheat sheet (full matrix in [`hooks.md`](../../extensions/hooks.md#decision-matrix)):

- **Empty stdout, exit 0** → `continue`. Default. The tool / prompt proceeds.
- **Plain-text stdout, exit 0** → `continue` with the text appended as `additionalContext`.
- **JSON stdout with `{"decision": "continue"}`** → same as above; use this shape when you also need `additionalContext`
  or `reason` set explicitly.
- **JSON stdout with `{"decision": "allow"}`** → skip remaining hooks for this event (the next hook in the array does
  not run). The tool still runs.
- **JSON stdout with `{"decision": "block", "reason": "<text>"}`** → on `PreToolUse` / `UserPromptSubmit` only;
  short-circuits and surfaces `reason` to the model.
- **Non-zero exit code** → `block` with `stderr` as `reason`. Mirrors Claude Code.

Anti-patterns inside the script:

- **Don't read stdin twice.** `cat` once into a variable; the payload is gone after the first read.
- **Don't print debug logging to stdout.** It will be appended to the tool result as `additionalContext`. Use `stderr`
  (or `PI_HOOKS_TRACE=<path>` from the runner side) for diagnostics.
- **Don't shell out to `pi` from inside a hook.** Hooks fire inside the running session; re-entering it from a
  subprocess will not do what you want.

## Author the config

`~/.pi/agent/hooks.json` is JSONC - `//` and `/* */` comments are allowed, trailing commas are not. Start from
[`config/pi/hooks-example.json`](../../hooks-example.json) and uncomment the event you need. Project-scoped hooks live
at `<repo>/.pi/hooks.json` and merge with the user file on every event (deny-wins-block - the first `block` from any
layer short-circuits).

Recommended `timeout`s:

- Audit / log hooks: 2000-5000 ms.
- Formatters / linters that shell out to another binary: 10000-30000 ms.
- Anything talking to the network: bump up explicitly; don't rely on the 60s default.

The `sandboxed` field is plumbed end-to-end but the wrap lands in a follow-up commit. Setting `"sandboxed": true` today
is reserved - leave it at the default `false` unless you're tracking the follow-up.

## Verify the hook fires

After installing a hook, smoke-test it:

1. `pi /hooks` - the entry should appear under the correct scope (user / project / session) and event.
2. Run the matching trigger (`bash`, `edit`, etc.) and confirm the side effect (log line written, file formatted, prompt
   context injected).
3. If silent, set `PI_HOOKS_DEBUG=1` (notify on every fire) or `PI_HOOKS_TRACE=~/.pi/agent/hooks.trace` (one line per
   fire, works in `-p` / RPC mode where notifications go nowhere) and rerun.

## Anti-patterns

- **Suggesting a hook for a one-shot task.** "Run prettier on this file once" is a bash command, not a `PostToolUse`
  entry. Reserve hooks for things that should fire on _every_ matching event.
- **Using a hook as a permissions gate.** Permissions live in `bash-permissions.json`. A `PreToolUse` hook that
  re-implements deny rules will drift from the real gate and confuse later readers.
- **Putting logic in the JSONC entry.** The `command` field is a shell invocation - keep it pointing at a script.
  Pipelines, conditionals, or environment branching belong in the script, not in `hooks.json`.
- **Authoring a hook that needs a new pi event.** The five supported events are the whole surface. If the trigger isn't
  on that list, you want an extension, not a hook.
- **Forgetting `set -euo pipefail`.** Hook scripts run unattended; a silent failure mid-script is worse than a loud
  exit-1 `block`.

## Quick reference

| You want to…                                 | Event              | Matcher example | Decision shape             |
| -------------------------------------------- | ------------------ | --------------- | -------------------------- |
| Log every bash command                       | `PreToolUse`       | `"bash"`        | empty stdout (`continue`)  |
| Deny `rm -rf` even if permissions allowed it | `PreToolUse`       | `"bash"`        | JSON `block` with `reason` |
| Run prettier after edit / write              | `PostToolUse`      | `"edit,write"`  | empty stdout (`continue`)  |
| Append a tool result note                    | `PostToolUse`      | `"*"`           | plain-text stdout          |
| Inject branch / cwd into the prompt          | `UserPromptSubmit` | (omit)          | plain-text stdout          |
| Cancel a turn that mentions a forbidden word | `UserPromptSubmit` | (omit)          | JSON `block` with `reason` |
| Warm a cache at session start                | `SessionStart`     | (omit)          | fire-and-forget            |
| Post a summary at session end                | `Stop`             | (omit)          | fire-and-forget            |
