# `bash-permissions.ts`

Claude Code–style approval gate for the built-in `bash` tool. Intercepts every bash tool call and checks it against
allow / deny rule sets before letting pi execute.

## Baseline example

[`../bash-permissions-example.json`](../bash-permissions-example.json) is a hand-curated read-only allowlist (file
inspection, search, git read-only subcommands, npm/yarn/pnpm queries, docker queries, `cd` / `pushd` / `popd`,
env/identity). Copy or merge into `~/.pi/agent/bash-permissions.json` (user scope) or `<repo>/.pi/bash-permissions.json`
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
| User    | `~/.pi/agent/bash-permissions.json`                      | all projects            |

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
4. Always allow `<first-token>*` (user scope - writes to `~/.pi/agent/bash-permissions.json`)
5. Deny
6. Deny with feedback… - prompts for a reason that gets surfaced to the LLM as the block message

In non-interactive mode (`-p`, JSON, RPC without UI) unknown commands are blocked by default so the model can retry
differently.

### Subagent bash calls prompt the parent UI

Spawned subagent children run with `hasUI: false`, so their bash calls can't show a dialog of their own. The hook-only
factory threads the child's session id into the gate; when the `subagent` extension has published the parent's UI (its
[`parent-prompt` bridge](./subagent.md#parent-ui-approval-bridge)) and the caller is a registered subagent child, an
unknown command routes to the **parent's** approval dialog, titled `[subagent <agent> (<handle>)] Bash tool request`,
and serialized so parallel children prompt one at a time. `Allow for this session` adds to the session allowlist (shared
with the parent, so it applies session-wide). When no parent UI is available (headless `pi -p`, or the bridge is
disabled via `PI_SUBAGENT_DISABLE_PARENT_PROMPT=1`) the child falls through to `PI_BASH_PERMISSIONS_DEFAULT` (default
deny). The hardcoded denylist and explicit deny rules apply to children regardless of the prompt path.

### Non-interactive block message

Without any approval UI, an unknown command is blocked with a reason built by
[`buildNoUiDenyReason`](../../../lib/node/pi/bash-permissions/no-ui-reason.ts). It lists the commands and tells the
model that the command and variations of it will be blocked again, must not be retried, and that the permission settings
must not be changed. It names no rules file, slash command, or environment variable: an earlier version carried a
labelled "(For the user: …)" hint, and a headless qwen3-6-35b-a3b run answered it with
`export PI_BASH_PERMISSIONS_DEFAULT=allow` and `write` calls on the named rules file. The operator hint
([`buildNoUiOperatorHint`](../../../lib/node/pi/bash-permissions/no-ui-reason.ts)) goes to stderr once per load instead.
One headless qwen3-8-27b run against the original operator-only text resubmitted the same blocked command ~270 times.
Repeated identical calls are also caught by [`loop-breaker`](./loop-breaker.md), which observes calls before this gate
runs.

## Decision model

An optional layer between the rules and the prompt. When `~/.pi/agent/decision-model.json` configures a System One
endpoint (TypeSafe Jev, Cloudflare Clef, a self-hosted deployment, or anything implementing `POST /v1/systemone`), every
command the rules would prompt for is first sent to the decision model, which can only **allow** it or **abstain**:

```text
hardcoded deny / deny rules / allow rules / always-prompt  ->  decision model  ->  approval dialog / headless default
```

- Explicit allow and deny rules always win; the model never sees those commands.
- Always-prompt commands (`sudo`, `doas`, …) and hardcoded-deny patterns never auto-allow, whatever the model says.
- Abstaining means the dialog (or `PI_BASH_PERMISSIONS_DEFAULT` without a UI) runs exactly as it would without this
  layer. The model abstains on any failure: missing or invalid config, unset key env var, timeout, HTTP error, a
  response that does not match the spec, a command over `maxStateChars`, or an answer below the thresholds.
- The same layer applies to `bg_bash` and subagent bash calls, since they route through this gate.

The request asks three questions about the whole command (with the rule-unresolved sub-commands and cwd as context):

| Question     | Type   | Allows when                                                                                                                                                                   |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`     | choice | the summed probability of `shell.allowEffects` reaches `shell.threshold` (effects: `read_only`, `workspace_write`, `outside_write`, `network_write`, `destructive`, `opaque`) |
| `secrets`    | noul   | probability it reads or sends credentials is at most `shell.maxRisk`                                                                                                          |
| `obfuscated` | noul   | probability it hides what it does (eval, decoded payloads, `curl \| sh`) is at most `shell.maxRisk`                                                                           |

Defaults: `allowEffects: ["read_only", "workspace_write"]`, `threshold: 0.9`, `maxRisk: 0.1`. Command text is run
through the [`secret-redactor`](./secret-redactor.md) detectors before it is sent or logged.

Config: copy [`../decision-model-example.json`](../decision-model-example.json) to `~/.pi/agent/decision-model.json`.
The API key comes from the env var named by `provider.apiKeyEnv` when it has a value, else from a literal
`provider.apiKey` in the file. The file is **user scope only**; a project `.pi/decision-model.json` is never read,
because a cloned repo must not be able to point the gate at an endpoint that approves everything. The opencode
[`decision-gate`](../../opencode/plugins/decision-gate/README.md) plugin reads the same shape. The file is re-read on
every call, so edits apply immediately. Shared logic lives in
[`lib/node/decision-model/`](../../../lib/node/decision-model/).

### Decision log

With `"log": true` (default) each consultation appends a JSONL record to `~/.pi/agent/decision-model.jsonl` (rotated to
`.1` at 5 MiB):

- `decision`: `id`, `harness`, `kind`, question-set version, session, cwd, redacted command, unresolved parts, provider
  host, resolved model, `verdict` (`allow` / `abstain`), `reason`, latency, per-question answers with full probability
  distributions, token usage, and the error kind / status on failures. Never the API key.
- `resolution`: for an abstain, what happened next, joined by `id`: `allow` / `deny` from the dialog, or `default-allow`
  / `default-deny` without a UI.

Pairs of `abstain` + `allow` resolutions are the commands a looser threshold would have cleared; inspect them with
`jq 'select(.type=="decision")' ~/.pi/agent/decision-model.jsonl` before changing thresholds.

## Commands

- `/bash-allow <pattern>` - add an allow rule. Writes to project scope if `.pi/bash-permissions.json` or `.pi/` already
  exists in cwd, otherwise to user scope.
- `/bash-deny <pattern>` - add a deny rule, same scoping.
- `/bash-permissions` - list every rule grouped by source (also reports auto-mode and decision-model state).
- `/bash-auto [on|off|status]` - toggle auto-allow for the current session. With no argument, flips the current state.
  Intended for "I trust pi for the next few minutes" workflows. The carve-out:

  | Still applies                                                                                                                                 | Skipped                                  |
  | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
  | Hardcoded denylist (`rm -rf /`, fork bomb, `mkfs`, `dd` to raw disk, `curl \| sh`, …)                                                         | The approval prompt for unknown commands |
  | Explicit user/project/session deny rules                                                                                                      |                                          |
  | `filesystem` gate (reads of `.env*` / `~/.ssh`, writes to those plus `.git/`, `node_modules/`, or outside the workspace) - separate extension |                                          |

  Auto-mode state is session-scoped and reset on `session_shutdown` / `/reload` / `/new`, so you always re-opt-in after
  a restart. While on, the custom [`statusline.ts`](./statusline.ts) renders a `⚡` indicator in the footer. State is
  shared between the two extensions via [`lib/node/pi/session-flags.ts`](../../../lib/node/pi/session-flags.ts), which
  anchors a singleton on `globalThis` because pi's extension loader (jiti with `moduleCache: false`) gives each
  extension its own copy of imported helper modules.

## Environment variables

- `PI_BASH_PERMISSIONS_DISABLED=1` - bypass the gate entirely.
- `PI_BASH_PERMISSIONS_DEFAULT=allow` - in non-interactive mode, allow unknown commands instead of blocking.
- `PI_BASH_PERMISSIONS_NO_HARDCODED_DENY=1` - truthy flag (default off). Disable the built-in "never auto-run" denylist
  (`rm -rf /`, fork bomb, `dd` to raw disk, `mkfs`, pipe-to-shell from the network, …) that is checked first and blocks
  even a broad allow rule. Not recommended.
- `PI_BASH_PERMISSIONS_NO_ALWAYS_PROMPT=1` - truthy flag (default off). Disable the always-prompt list (`sudo`, `doas`,
  `run0`, `pkexec`, `gosu`, `su`) that forces a prompt even under `/bash-auto`. With it set, privilege escalation
  auto-allows under `/bash-auto`, which is risky. An explicit allow rule already bypasses the prompt for a specific
  command without this knob.
- `PI_DECISION_MODEL_DISABLED=1` - skip the [decision model](#decision-model) layer even when it is configured.
- `PI_DECISION_MODEL_CONFIG=<path>` - read the decision-model config from `<path>` instead of
  `~/.pi/agent/decision-model.json`.

## Hot reload

Rule files and `decision-model.json` are re-read on every tool call, so edits take effect immediately. Edits to the
extension itself need `/reload`.
