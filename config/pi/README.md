# pi config

Configuration, custom extensions, and themes for
[pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Files

- [`settings-baseline.json`](#settings-baselinejson) — mirrors `~/.pi/agent/settings.json`.
- [`session-usage.ts`](#session-usagets) — CLI that walks `~/.pi/agent/sessions/` and summarizes session token/cost/tool
  usage.
- [`extensions/statusline.ts`](#extensionsstatuslinets) — up-to-three-line status line rendered at the bottom of every
  pi session.
- [`extensions/bash-permissions.ts`](#extensionsbash-permissionsts) — Claude Code–style approval gate for `bash` tool
  calls.
- [`extensions/protected-paths.ts`](#extensionsprotected-pathsts) — session-scoped approval gate for `read`, `write`,
  and `edit` touching `.env*` / `.envrc`, `~/.ssh`, `node_modules/`, `.git/`, or anything outside the current workspace
  (writes only).
- [`extensions/todo.ts`](#extensionstodots) — planning + tracking tool tuned for weak-model support: richer status
  states, auto-injection of the active plan into the system prompt every turn, and a completion-claim guardrail that
  re-prompts the model if it signs off while todos are still open.
- [`extensions/stall-recovery.ts`](#extensionsstall-recoveryts) — auto-retry when an agent turn ends without producing
  work (empty response or provider error). Companion to [`todo.ts`](#extensionstodots) — they handle orthogonal failure
  modes and compose naturally. Especially useful for weaker local models and flaky provider transports.
- [`extensions/lib/`](./extensions/lib) — pure helpers (no pi imports) shared between the extensions and unit-tested
  under [`tests/`](./tests).
- [`skills/plan-first/SKILL.md`](#skillsplan-first) — global skill that teaches models WHEN to reach for the `todo` tool
  and how to keep the plan accurate. Companion to [`extensions/todo.ts`](#extensionstodots).
- [`tests/`](./tests) — `node --test` unit tests for the pure extension helpers. See
  [`tests/README.md`](./tests/README.md).
- [`themes/`](#themes) — JSON themes loadable by name from `settings.json`.

Pi auto-discovers [`extensions/`](./extensions), [`skills/`](./skills), and [`themes/`](./themes) via the `extensions` /
`skills` / `themes` arrays in [`settings-baseline.json`](./settings-baseline.json). Paths accept `~`, absolute paths,
and globs. See
[pi settings docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md#resources) for
the full list of resource directories pi scans — the settings entries are additive to the built-in
`~/.pi/agent/{extensions,themes}` and `.pi/{extensions,themes}` auto-discovery paths, not a replacement.

## `extensions/statusline.ts`

Claude Code–style footer for pi. Ports the data exposed by
[`../claude/statusline-command.sh`](../claude/statusline-command.sh) onto pi's extension API (`ctx.ui.setFooter`,
`ctx.sessionManager`, `ctx.getContextUsage`).

### Example

```text
[user#host pi-test (main *+$%) ⎇ feature-x 82% left $0.042 §a0cd2e69] claude-opus-4-7 • high
 ↳ M(3):↑1k/↻ 12k/↓180 R 92% | S:↑4k/↻ 48k/W 1.2k/↓720 R 92% | ⚒ S:6(~3k)
plan-mode: on   preset: fast   ⠋ thinking…
```

### Line 1 — shell-style context

- **`user#host`** — `os.userInfo()` + short `os.hostname()`.
- **`cwd`** — `basename(ctx.cwd)`, OSC8 hyperlinked to `file://…` (skipped on SSH / WSL-translated on WSL).
- **`(branch…)`** — decorated git segment. When the dotfiles-vendored
  [`../../external/git-prompt.sh`](../../external/git-prompt.sh) is reachable, the extension shells out to
  `__git_ps1 " (%s)"` (same flags as [`../claude/statusline-command.sh`](../claude/statusline-command.sh):
  `GIT_PS1_SHOWDIRTYSTATE`, `SHOWSTASHSTATE`, `SHOWUNTRACKEDFILES`, `SHOWUPSTREAM=auto`), so you see `*` dirty, `+`
  staged, `$` stash, `%` untracked, and `<>=` upstream arrows — identical to the interactive `PS1` prompt. Results are
  cached per-cwd for 5 s and invalidated on `footerData.onBranchChange` (git HEAD / reftable watcher). When the helper
  can't be located or bash fails, falls back to plain `footerData.getGitBranch()`.
- **`⎇ <name>`** — linked worktree name. Mirrors Claude Code's `workspace.git_worktree` segment but derived entirely
  from on-disk metadata (no subprocess): reads `.git` / `.git/worktrees/<name>/commondir` via
  [`extensions/lib/git-worktree.ts`](./extensions/lib/git-worktree.ts). Only rendered when `.git` is a pointer file
  **and** the target lives at `<commonGitDir>/worktrees/<name>/` — submodules (which use the same pointer-file scheme
  but target `.git/modules/<name>/`) and `--separate-git-dir` repos therefore render nothing, matching what
  `git worktree list` considers a linked worktree. Cached per-cwd and invalidated alongside the branch cache on HEAD
  changes.
- **`N% left`** — `100 − ctx.getContextUsage().percent`.
- **`$N.NNN`** — sum of `message.usage.cost.total` across the session branch.
- **`§xxxxxxxx`** — first 8 chars of `ctx.sessionManager.getSessionId()`.
- **`<model>`** — `ctx.model.id`.
- **`• <level>`** — `ctx.getThinkingLevel()` when `ctx.model.reasoning` is true (one of `off`, `minimal`, `low`,
  `medium`, `high`, `xhigh`). Mirrors pi's built-in `<model> • <level>` footer suffix; omitted for non-reasoning models.

### Line 2 — token and tool totals

- **`M(N):↑in/↻ cached/↓out R pct%`** — most recent assistant message's usage. `N` = user-prompt turn count; `R pct%` is
  the per-turn cache-hit ratio so you can see whether _this_ message hit the prompt cache.
- **`S:↑in/↻ cached/W write/↓out R pct%`** — cumulative session totals.
  - **`W write`** — `cacheWrite` tokens summed across the session; omitted when zero. Lets you see cache-write spend on
    providers (Anthropic, Bedrock) that bill it separately from input.
  - **`R pct%`** — cache-hit ratio, `cacheRead / (input + cacheRead)`. Quick signal that prompt caching is engaging
    across the session; the matching `R` on `M(…)` reflects only the most recent turn.
- **`⚒ S:n(~tokens)`** — tool-call count; paren value is estimated tool-result tokens (bytes / 4).

Subagent (`A(n):…`) and Pro/Max rate-limit segments from the Claude script are intentionally omitted — pi has no
equivalent data sources.

### Line 3 — extension statuses

- Renders `footerData.getExtensionStatuses()` — values set by other extensions via `ctx.ui.setStatus(key, text)` (e.g.
  plan-mode, preset, working-indicator, [`bash-permissions.ts`](./extensions/bash-permissions.ts)).
- Because `ctx.ui.setFooter(...)` replaces pi's built-in footer, these statuses would otherwise be muted; appending them
  as a 3rd line keeps every extension's status visible.
- Entries are sorted by key for stable ordering, newlines/tabs are collapsed to single spaces, and the line is truncated
  to the terminal width. Hidden when no extension has set a status.

### Environment variables

- `PI_STATUSLINE_DISABLED=1` — restore pi's built-in footer.
- `PI_STATUSLINE_DISABLE_HYPERLINKS=1` or `DOT_DISABLE_HYPERLINKS=1` — skip OSC8 hyperlinks (same knob as
  [`../claude/statusline-command.sh`](../claude/statusline-command.sh)).
- `PI_STATUSLINE_DISABLE_GIT_PROMPT=1` — skip `__git_ps1` and always render the plain branch from
  `footerData.getGitBranch()`. Automatically a no-op when [`../../external/git-prompt.sh`](../../external/git-prompt.sh)
  can't be located.
- `DOTFILES_ROOT` — override where the statusline looks for `external/git-prompt.sh`. Defaults to walking upward from
  the extension file (resolves symlinks, so `~/.dotfiles` → real repo works).

### Colors

Uses only semantic theme tokens (`error`, `warning`, `mdListBullet`, `mdLink`, `success`, `toolTitle`, `muted`,
`accent`, `dim`, `text`), so it adapts to any pi theme — including
[`themes/solarized-dark.json`](./themes/solarized-dark.json) and
[`themes/solarized-light.json`](./themes/solarized-light.json).

### Hot reload

Edit the file and run `/reload` inside an interactive pi session to pick up changes without restarting.

## `extensions/bash-permissions.ts`

Claude Code–style approval gate for the built-in `bash` tool. Intercepts every bash tool call and checks it against
allow / deny rule sets before letting pi execute.

### Rule layers

Rules are loaded from three layers on every tool call. Deny beats allow across all layers.

| Layer   | Source                                                   | Scope                   |
| ------- | -------------------------------------------------------- | ----------------------- |
| Session | in-memory, cleared on `session_shutdown`                 | current pi session only |
| Project | `.pi/bash-permissions.json` (resolved against `ctx.cwd`) | one repo                |
| User    | `~/.pi/bash-permissions.json`                            | all projects            |

File schema (JSONC — `//` and `/* */` comments are allowed, trailing commas are not):

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

- `re:<regex>` — JS regex, no flags. Config-file only. Anchor with `^`/`$` for whole-command matches (`RegExp.test()` is
  substring-matching by default).
- `/<regex>/<flags>` — JS regex with flags (`gimsuy`). Config-file only. Strings that merely _start_ with `/` (for
  example `/usr/bin/true`) fall back to plain exact match unless the portion after the last `/` is all flag chars, so
  real absolute-path commands are safe. Use `re:^/opt/foo/gi$` to escape the ambiguity.
- Trailing `*` — token-aware prefix match (`git log*` matches `git log` and `git log -1` but **not** `git logs`).
- Plain string — exact match (`npm test` matches only `npm test`, not `npm test foo`).

Invalid regex patterns never match and print a single `console.warn` per unique pattern so typos are discoverable. Regex
rules are intended for hand-edited config files — the `/bash-allow` command and the approval dialog's save-rule options
only produce exact / prefix strings.

Compound commands joined by `&&`, `||`, or `;` are split and every sub-command must pass independently. Pipes (`|`) are
intentionally left intact.

### Approval flow

When an unknown command is about to run, pi shows a select dialog with:

1. Allow once
2. Allow `<exact cmd>` for this session
3. Always allow `<exact cmd>` (project scope — writes to `.pi/bash-permissions.json`)
4. Always allow `<first-token>*` (user scope — writes to `~/.pi/bash-permissions.json`)
5. Deny
6. Deny with feedback… — prompts for a reason that gets surfaced to the LLM as the block message

In non-interactive mode (`-p`, JSON, RPC without UI) unknown commands are blocked by default so the model can retry
differently.

### Commands

- `/bash-allow <pattern>` — add an allow rule. Writes to project scope if `.pi/bash-permissions.json` or `.pi/` already
  exists in cwd, otherwise to user scope.
- `/bash-deny <pattern>` — add a deny rule, same scoping.
- `/bash-permissions` — list every rule grouped by source (also reports current auto-mode state).
- `/bash-auto [on|off|status]` — toggle auto-allow for the current session. With no argument, flips the current state.
  Intended for "I trust pi for the next few minutes" workflows. The carve-out:

  | Still applies                                                                                                                                 | Skipped                                  |
  | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
  | Hardcoded denylist (`rm -rf /`, fork bomb, `mkfs`, `dd` to raw disk, `curl \| sh`, …)                                                         | The approval prompt for unknown commands |
  | Explicit user/project/session deny rules                                                                                                      |                                          |
  | `protected-paths` (reads of `.env*` / `~/.ssh`, writes to those plus `.git/`, `node_modules/`, or outside the workspace) — separate extension |                                          |

  Auto-mode state is session-scoped and reset on `session_shutdown` / `/reload` / `/new`, so you always re-opt-in after
  a restart. While on, the custom [`statusline.ts`](./extensions/statusline.ts) renders a `⚡` indicator in the footer.
  State is shared between the two extensions via [`extensions/lib/session-flags.ts`](./extensions/lib/session-flags.ts),
  which anchors a singleton on `globalThis` because pi's extension loader (jiti with `moduleCache: false`) gives each
  extension its own copy of imported helper modules.

### Environment variables

- `PI_BASH_PERMISSIONS_DISABLED=1` — bypass the gate entirely.
- `PI_BASH_PERMISSIONS_DEFAULT=allow` — in non-interactive mode, allow unknown commands instead of blocking.

### Hot reload

Rule files are re-read on every tool call, so edits to `bash-permissions.json` take effect immediately. Edits to the
extension itself need `/reload`.

## `extensions/protected-paths.ts`

Session-scoped approval gate for pi's built-in `read`, `write`, and `edit` tools. Complements
[`extensions/bash-permissions.ts`](#extensionsbash-permissionsts) (which owns the `bash` channel).

### What's protected

The gate has two rule categories with separate threat models:

- **`read` rules** gate the `read` tool. Aimed at files whose **contents** are sensitive (secrets, private keys).
  Reading is a plausible exfiltration path for an LLM, but reading files OUTSIDE the workspace is often legitimate
  (READMEs of nearby repos, config templates, etc.), so outside-workspace is **not** enforced for reads.
- **`write` rules** gate `write` / `edit`. Aimed at files/dirs that are dangerous to **mutate** even if reading is fine.
  The effective write rule set is `read ∪ write` — anything sensitive-to-read is trivially sensitive-to-write, so
  there's no need to duplicate entries. Outside-workspace IS enforced for writes.

Defaults:

| Category                        | `read`                     | `write` (in addition to `read`) |
| ------------------------------- | -------------------------- | ------------------------------- |
| `basenames` (glob on basename)  | `.env`, `.env.*`, `.envrc` | —                               |
| `segments` (any path segment)   | —                          | `node_modules`, `.git`          |
| `paths` (tilde-expanded prefix) | `~/.ssh`                   | —                               |
| Outside workspace               | (not enforced)             | always on                       |

`paths` is checked before outside-workspace so a write to `~/.ssh/config` reports the specific reason instead of the
generic "outside workspace." A leading `~` in the tool's `path` argument is expanded to the current user's home
directory before classification (`~/.env` → `$HOME/.env`), so tilde paths can't sneak past the basename or path-prefix
checks. `~user/` syntax isn't supported — it's almost never emitted by an LLM and would need a password-db lookup.

Symlink-following is intentionally **not** attempted: the classifier uses `path.resolve()` (lexical), so a symlink that
escapes a protected path is treated as its link path. Fix with file-watcher-grade logic if you need it.

`grep`, `find`, and `ls` are currently **not** gated. Their output is bounded by pi's built-in size limits and they
rarely exfiltrate raw secrets on their own — add them to this extension if that assumption changes for your threat
model.

### Approval flow

Session-scoped only — there's no persistent allowlist, because these paths are almost always incidental and you rarely
want pi touching them silently forever.

1. Allow once
2. Allow `<path>` for this session
3. Deny
4. Deny with feedback…

The session allowlist is **shared** across tools: approving a path for the session satisfies subsequent reads AND writes
of the same file. If you vetted a path for one, you vetted it for the other.

In non-interactive mode (`-p`, JSON, RPC without UI) the gate blocks by default; set `PI_PROTECTED_PATHS_DEFAULT=allow`
to override.

### Custom rules

Rules are additive across four layers (any match prompts — there's deliberately no "deny" escape hatch, since the point
of the gate is to make accidental access **loud**):

1. Built-in defaults (the table above)
2. User: `~/.pi/protected-paths.json`
3. Project: `.pi/protected-paths.json` inside `ctx.cwd`
4. Env var: `PI_PROTECTED_PATHS_EXTRA_GLOBS` (extra basename globs, merged into BOTH `read` and `write`)

Config files are JSONC — `//` line comments and C-style block comments are allowed. Shape:

```jsonc
{
  // Gated for the `read` tool. Put contents-sensitive files here.
  "read": {
    "basenames": ["*.key", "id_*"], // glob (`*`, `?`) on the file's basename
    "segments": [], // exact match on any path segment
    "paths": ["~/secrets"], // tilde-expanded path prefix
  },
  // Gated for `write` / `edit` IN ADDITION TO the `read` rules above.
  // Put mutation-dangerous dirs here (no need to repeat `read` entries).
  "write": {
    "basenames": [],
    "segments": [".terraform", ".vault"],
    "paths": [],
  },
}
```

Rule files are re-read on every tool call, so edits take effect immediately. Missing files are silent; malformed JSONC
logs a single `[protected-paths]` warning per unique error.

### Commands

- `/protected-paths` — list the active protection rules grouped by source and the current session allowlist.

### Environment variables

- `PI_PROTECTED_PATHS_DISABLED=1` — bypass the gate entirely.
- `PI_PROTECTED_PATHS_DEFAULT=allow` — in non-UI mode, allow unknown paths instead of blocking.
- `PI_PROTECTED_PATHS_EXTRA_GLOBS=a,b,c` — extra basename globs merged into BOTH `read` and `write` (supports `*` and
  `?`). Equivalent to adding them to the `basenames` array under both categories in `~/.pi/protected-paths.json`.

## `extensions/todo.ts`

Project-agnostic planning tool plus the weak-model guardrails that make the plan actually useful. Ships on top of pi's
stock `todo` example with richer status states, automatic system-prompt injection, and completion-claim detection.
Companion to the [`plan-first` skill](#skillsplan-first): the extension provides the mechanism, the skill teaches the
model when to use it.

### What the tool does

Registers a single `todo` tool the LLM can call, and a `/todos` command for the user. Actions:

| Action     | Required              | Optional | Purpose                                                                                                                                               |
| ---------- | --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`     | —                     | —        | Print the current plan.                                                                                                                               |
| `add`      | `text` **or** `items` | —        | Append one (or many) pending todos.                                                                                                                   |
| `start`    | `id`                  | —        | Mark a todo `in_progress`. At most one at a time. Also moves a `review` item back to `in_progress`.                                                   |
| `review`   | `id`                  | `note`   | Move an `in_progress` item to `review` (verification parking). At most one at a time — independent of the `in_progress` WIP.                          |
| `complete` | `id`                  | `note`¹  | Mark a todo done. ¹**Required** when going directly from `in_progress` (describes what verified the outcome); optional from `review` or other states. |
| `block`    | `id`, `note`          | —        | Flag a blocker; `note` is required so the reason survives.                                                                                            |
| `reopen`   | `id`                  | —        | Return a completed/blocked todo to `pending`.                                                                                                         |
| `clear`    | —                     | —        | Wipe the plan.                                                                                                                                        |

Every todo carries a status of `pending | in_progress | review | completed | blocked` plus an optional `note` (blocker
reason, review-pending verification hint, or completion annotation). The tool enforces two independent WIP=1 limits:

- **At most one `in_progress`** — trying to `start` a second item while another is active returns an error.
- **At most one `review`** — trying to `review` a second item while another is parked returns an error.

The two limits are separate, so you can have one item `in_progress` and another in `review` simultaneously (matches
kanban semantics: work on item B while item A's tests run). Serial focus is the invariant weaker models benefit most
from; silently allowing parallel work produces drift-prone plans.

The `review` column is the verification parking step: move `in_progress → review` when the change is written but the
outcome hasn't been confirmed yet, then `review → complete` once verified. This mechanizes the "verify before complete"
rule as a typed state transition rather than a prose guideline — going directly `in_progress → complete` still works,
but the tool then **requires** a `note` on `complete` spelling out what verified it.

### Weak-model affordances on top of stock pi

1. **System-prompt auto-injection** (`before_agent_start`). The active plan (in-progress + pending + blocked, capped at
   [`PI_TODO_MAX_INJECTED`](#environment-variables-3) items) is appended to the system prompt every turn. This is the
   biggest win: the plan stays visible across context compactions and long conversations without the model having to
   remember to call `list`. Omitted when there's nothing to say (empty state, or everything `completed`).

2. **Completion-claim guardrail** (`agent_end`). If the assistant signs off with a "done"-ish phrase
   (`looksLikeCompletionClaim` in [`lib/todo-prompt.ts`](./extensions/lib/todo-prompt.ts)) while `in_progress`,
   `review`, or `pending` todos still exist, the extension injects a follow-up user message nudging it to finish,
   verify, or `block` the open items. Idempotent — the steer carries a sentinel marker and is skipped if the previous
   user message already bore one, so the loop terminates even if the model ignores it.

3. **Compaction resilience.** Each successful tool call mirrors the post-action state to a `customType: 'todo-state'`
   session entry in addition to `toolResult.details`. Pi's `/compact` can summarize old tool-result messages away, but
   the custom entry travels with the branch so the reducer can still reconstruct the plan on `session_start` /
   `session_tree`.

4. **Branch awareness.** Because state is reconstructed from the branch by
   [`reduceBranch`](./extensions/lib/todo-reducer.ts), `/fork`, `/tree`, and `/clone` automatically show the correct
   plan for that point in history. No external files, no cross-branch leakage.

### Environment variables

- `PI_TODO_DISABLED=1` — skip the extension entirely.
- `PI_TODO_DISABLE_AUTOINJECT=1` — keep the tool but don't append the active plan to the system prompt.
- `PI_TODO_DISABLE_GUARDRAIL=1` — don't fire the `agent_end` re-prompt when the model claims done with open todos.
- `PI_TODO_MAX_INJECTED=N` — cap on `pending` items rendered inside the injected block (default `10`).

### Hot reload

Edit [`extensions/todo.ts`](./extensions/todo.ts) (or the helpers under [`extensions/lib/`](./extensions/lib)) and run
`/reload` inside an interactive pi session to pick up changes without restarting.

## `extensions/stall-recovery.ts`

Auto-retry when an agent turn ends without producing meaningful work. Aimed at weaker local models that stop mid-task
and transport / provider failures that leave the session mid-stride. Companion to [`todo.ts`](#extensionstodots) — both
fire on `agent_end`, but the two handle orthogonal failure modes and never double-fire on the same turn:

|              | `stall-recovery` fires when…                                                                                      | `todo` guardrail fires when…                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Signal       | Turn produced **no** text and no tool calls, **or** the turn has an explicit error.                               | Turn produced text that reads like a "done" sign-off, **and** open todos still exist. |
| Failure mode | Model stopped silently; provider errored.                                                                         | Model claimed completion prematurely.                                                 |
| Composition  | Fresh turn triggered via `sendUserMessage`; `todo`'s `before_agent_start` injection re-anchors the plan for free. | Prompts the model to finish / `block` the open items.                                 |

### Detection

On `agent_end`, the extension extracts the last assistant message from `event.messages` and classifies it via
[`classifyAssistant()`](./extensions/lib/stall-detect.ts). Detection is deliberately conservative:

1. **`empty`** — trimmed text is empty **and** no tool calls were issued in the final assistant message. This catches
   the canonical "model just stopped" case: weak locals that emit a stop token too early, reasoning models whose
   thinking phase completes without emitting content, mid-stream transport errors that leave the assistant message
   empty.
2. **`error`** — the assistant message (or event) carries an explicit error string. Covers rate limits, timeouts, and
   structured provider failures that surface via `event.messages` rather than throwing.

Hedging / punting text ("I'll look into that.") is deliberately **not** detected: the false-positive rate is too high.
If the model produces any substantive text or tool call, we trust it.

### Recovery

A follow-up user message is injected via `pi.sendUserMessage(..., { deliverAs: 'followUp' })` carrying a sentinel marker
(`⟳ [pi-stall-recovery]`). The message is short and directive — weaker models respond better to concrete instructions
than vague ones:

- **Empty stall** → "Your previous turn produced no output. The task is not complete. Continue where you left off —
  review any active todos, check the last tool result if there was one, and produce either the next tool call or the
  final answer for the user."
- **Error stall** → "Your previous turn failed with: `<error>`. Retry the same approach, or try a different one if the
  error suggests the approach was wrong."

The retry triggers a fresh agent turn; any `before_agent_start` handlers (like the todo extension's active-plan
injection) run automatically, re-anchoring the model.

### Retry budget

In-memory per-prompt counter. Default max = 2 consecutive retries per user prompt. Reset on the `input` event when the
source is **not** `extension` — i.e., a real user typed (or an RPC/API client sent) a new prompt. Synthesized messages
from this extension don't reset the counter.

When the budget is exhausted:

- `ctx.ui.notify(...)` surfaces a warning:
  `"Agent stalled N time(s) in a row (<detail>). Auto-retry paused — type to continue manually."`
- The retry status is cleared from the footer.
- The extension stops firing until the user sends a real prompt.

Loop prevention is layered: the budget alone would bound retries, but the `input` handler additionally ignores any
prompt that itself carries the stall marker (defense against replay scenarios).

### UI

While a retry is in flight, the footer shows:

```text
⟳ Auto-retrying stalled turn (1/2)…
```

Rendered by [`statusline.ts`](#extensionsstatuslinets) on the third line alongside other extension statuses. Cleared
when the next turn produces meaningful work.

### Environment variables

- `PI_STALL_RECOVERY_DISABLED=1` — skip the extension entirely.
- `PI_STALL_RECOVERY_MAX_RETRIES=N` — consecutive retries allowed per user prompt (default `2`). `N=0` disables the
  retry loop (the classifier still runs and the first stall triggers a notify).
- `PI_STALL_RECOVERY_VERBOSE=1` — emit a `ctx.ui.notify` on every detection + retry decision. Useful for tuning when
  running against a noisy local model.

### Hot reload

Edit [`extensions/stall-recovery.ts`](./extensions/stall-recovery.ts) or
[`extensions/lib/stall-detect.ts`](./extensions/lib/stall-detect.ts) and run `/reload` in an interactive pi session.

## `skills/plan-first`

Global skill that teaches models to plan multi-step work with the [`todo`](#extensionstodots) tool before touching
anything else. Lives in [`skills/plan-first/SKILL.md`](./skills/plan-first/SKILL.md) and is discovered in every project
via the `skills` entry in [`settings-baseline.json`](./settings-baseline.json).

The extension provides the mechanism (the tool, branch-aware state, auto-injection, guardrail); the skill provides the
policy: when to plan, how to decompose a request into verifiable todos, when to `start` vs `block` vs `complete`, and
common anti-patterns (e.g. marking items complete without verification, starting a second `in_progress` item, claiming
done while todos remain open).

Auto-triggering is intentional — the skill description is written to match any request that implies multiple steps,
multiple files, or change + verify phases, so weaker models that wouldn't call `/skill:plan-first` on their own still
pull the skill's instructions into context when relevant. Stronger models that already plan well will still load it, but
the overhead is small and the instructions are consistent with how they already work.

## `themes/`

Custom pi themes. Select one via `/settings` in pi or set `"theme": "<name>"` in `~/.pi/agent/settings.json` (see
[`settings-baseline.json`](./settings-baseline.json) for an example). See
[pi themes docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/themes.md) for the schema and
the list of color tokens.

## `settings-baseline.json`

A reference baseline config for pi. Copy (or merge) its contents into `~/.pi/agent/settings.json` — pi manages a few
runtime-only keys there (e.g. `lastChangelogVersion`) that are intentionally omitted from the baseline.

The `extensions` / `themes` arrays are what wire the directories in this repo into pi; everything else is preference
(default provider/model, default thinking level, theme selection, telemetry opt-out).

## `session-usage.ts`

CLI that walks `~/.pi/agent/sessions/` and summarizes session token / cost / tool usage. Same UX as
[`../claude/session-usage.ts`](../claude/session-usage.ts) and [`../codex/session-usage.ts`](../codex/session-usage.ts)
— shares the rendering / arg-parsing harness under [`../../lib/node/ai-tooling/`](../../lib/node/ai-tooling).

### Commands

- `list` — all sessions for the current project (cwd). Default.
- `session <uuid>` — detailed single-session report. Accepts a UUID prefix.
- `totals` — usage bucketed by day or week. Scopes to the current project when `--project` is given; otherwise
  aggregates across every project.

### Options

- `--project, -p <path>` — filter by project directory (default: `$PWD`).
- `--user-dir, -u <dir>` — pi agent dir (default: `~/.pi/agent`).
- `--json` — machine-readable output.
- `--sort <field>`, `--limit, -n <N>`, `--group-by, -g <day|week>`, `--no-color` — standard across all adapters.

### Data source

Pi records per-message `usage.cost.total` on every assistant message, so unlike the Claude and Codex adapters this one
does **not** fetch or cache the LiteLLM pricing table — costs come straight from the session file. `--no-cost` and
`--refresh-prices` are accepted for interface parity with the other tools but have no effect.

Pi has no subagent concept, so the `AGENTS` column and the subagent detail section are always `0` / empty.
