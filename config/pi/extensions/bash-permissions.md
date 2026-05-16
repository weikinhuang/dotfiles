# `bash-permissions.ts`

Claude Code–style approval gate for the built-in `bash` tool. Intercepts every bash tool call and checks it against
allow / deny rule sets before letting pi execute.

## Baseline example

[`../bash-permissions-example.json`](../bash-permissions-example.json) is a hand-curated read-only allowlist (file
inspection, search, git read-only subcommands, npm/yarn/pnpm queries, docker queries, `cd` / `pushd` / `popd`,
env/identity). Copy or merge into `~/.pi/bash-permissions.json` (user scope) or `<repo>/.pi/bash-permissions.json`
(project scope), then layer your own write/build allowances on top.

Footguns the baseline already guards against with `re:` rules:

- `find -exec` / `-execdir` / `-ok` / `-okdir` / `-delete` / `-fprint` / `-fprintf` / `-fls`
- `fd -x` / `-X` / `--exec` / `--exec-batch`
- `rg --pre` (arbitrary per-file preprocessor) - `--pretty` and `--pre-glob` still pass
- `git branch <name>` (creates), `git tag <name>` (creates), `git config key value` (writes)

Semantics are pinned by
[`tests/config/pi/bash-permissions-example.spec.ts`](../../../tests/config/pi/bash-permissions-example.spec.ts), which
runs the bundled commands through the same `matchesPattern` / `splitCompound` helpers the extension uses at runtime.

## Rule layers

Rules are loaded from three layers on every tool call. Deny beats allow across all layers.

| Layer   | Source                                                   | Scope                   |
| ------- | -------------------------------------------------------- | ----------------------- |
| Session | in-memory, cleared on `session_shutdown`                 | current pi session only |
| Project | `.pi/bash-permissions.json` (resolved against `ctx.cwd`) | one repo                |
| User    | `~/.pi/bash-permissions.json`                            | all projects            |

File schema (JSONC - `//` and `/* */` comments are allowed, trailing commas are not):

```jsonc
{
  // Things I'm OK letting pi run without asking
  "allow": [
    "git status",
    "git log*", // any args
    "npm test",
    "re:^npm (test|run \\w+)$",
    "/^docker ps( |$)/", // regex: prefix form
  ],
  /* Belt-and-suspenders for the hardcoded denylist */
  "deny": ["rm -rf*", "sudo*"],
}
```

Malformed rule files log one `console.warn` per unique path+error (so a typo doesn't silently wipe out your ruleset) and
are otherwise treated as empty. Missing files are silent.

Pattern semantics (checked in this order):

- `re:<regex>` - JS regex, no flags. Config-file only. Anchor with `^`/`$` for whole-command matches (`RegExp.test()` is
  substring-matching by default).
- `/<regex>/<flags>` - JS regex with flags (`gimsuy`). Config-file only. Strings that merely _start_ with `/` (for
  example `/usr/bin/true`) fall back to plain exact match unless the portion after the last `/` is all flag chars, so
  real absolute-path commands are safe. Use `re:^/opt/foo/gi$` to escape the ambiguity.
- Trailing `*` - token-aware prefix match (`git log*` matches `git log` and `git log -1` but **not** `git logs`).
- Plain string - exact match (`npm test` matches only `npm test`, not `npm test foo`).

Invalid regex patterns never match and print a single `console.warn` per unique pattern so typos are discoverable. Regex
rules are intended for hand-edited config files - the `/bash-allow` command and the approval dialog's save-rule options
only produce exact / prefix strings.

Compound commands joined by `&&`, `||`, or `;` are split and every sub-command must pass independently. Pipes (`|`) are
intentionally left intact.

## Approval flow

When an unknown command is about to run, pi shows a select dialog with:

1. Allow once
2. Allow `<exact cmd>` for this session
3. Always allow `<exact cmd>` (project scope - writes to `.pi/bash-permissions.json`)
4. Always allow `<first-token>*` (user scope - writes to `~/.pi/bash-permissions.json`)
5. Deny
6. Deny with feedback… - prompts for a reason that gets surfaced to the LLM as the block message

In non-interactive mode (`-p`, JSON, RPC without UI) unknown commands are blocked by default so the model can retry
differently.

## Commands

- `/bash-allow <pattern>` - add an allow rule. Writes to project scope if `.pi/bash-permissions.json` or `.pi/` already
  exists in cwd, otherwise to user scope.
- `/bash-deny <pattern>` - add a deny rule, same scoping.
- `/bash-permissions` - list every rule grouped by source (also reports current auto-mode state).
- `/bash-auto [on|off|status]` - toggle auto-allow for the current session. With no argument, flips the current state.
  Intended for "I trust pi for the next few minutes" workflows. The carve-out:

  | Still applies                                                                                                                                 | Skipped                                  |
  | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
  | Hardcoded denylist (`rm -rf /`, fork bomb, `mkfs`, `dd` to raw disk, `curl \| sh`, …)                                                         | The approval prompt for unknown commands |
  | Explicit user/project/session deny rules                                                                                                      |                                          |
  | `protected-paths` (reads of `.env*` / `~/.ssh`, writes to those plus `.git/`, `node_modules/`, or outside the workspace) - separate extension |                                          |

  Auto-mode state is session-scoped and reset on `session_shutdown` / `/reload` / `/new`, so you always re-opt-in after
  a restart. While on, the custom [`statusline.ts`](./statusline.ts) renders a `⚡` indicator in the footer. State is
  shared between the two extensions via [`lib/node/pi/session-flags.ts`](../../../lib/node/pi/session-flags.ts), which
  anchors a singleton on `globalThis` because pi's extension loader (jiti with `moduleCache: false`) gives each
  extension its own copy of imported helper modules.

## Environment variables

- `PI_BASH_PERMISSIONS_DISABLED=1` - bypass the gate entirely.
- `PI_BASH_PERMISSIONS_DEFAULT=allow` - in non-interactive mode, allow unknown commands instead of blocking.

## Hot reload

Rule files are re-read on every tool call, so edits to `bash-permissions.json` take effect immediately. Edits to the
extension itself need `/reload`.
