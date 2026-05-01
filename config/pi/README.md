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
- [`extensions/subdir-agents.ts`](#extensionssubdir-agentsts) — Claude Code / Codex / opencode-style lazy loader for
  subdirectory `AGENTS.md` / `CLAUDE.md` files. Pi only walks UP from cwd at startup; this extension walks DOWN on every
  `read` / `write` / `edit` so nested context files (e.g. `tests/AGENTS.md`) apply when the model edits files in that
  subtree.
- [`extensions/todo.ts`](#extensionstodots) — planning + tracking tool tuned for weak-model support: richer status
  states, auto-injection of the active plan into the system prompt every turn, and a completion-claim guardrail that
  re-prompts the model if it signs off while todos are still open.
- [`extensions/stall-recovery.ts`](#extensionsstall-recoveryts) — auto-retry when an agent turn ends without producing
  work (empty response or provider error). Companion to [`todo.ts`](#extensionstodots) — they handle orthogonal failure
  modes and compose naturally. Especially useful for weaker local models and flaky provider transports.
- [`extensions/scratchpad.ts`](#extensionsscratchpadts) — unstructured working-notes tool + auto-injection under a
  `## Working Notes` header. Companion to [`todo.ts`](#extensionstodots): where `todo` holds the typed plan,
  `scratchpad` holds free-form carry-over (decisions, file paths, test commands) that should survive compaction.
- [`extensions/verify-before-claim.ts`](#extensionsverify-before-claimts) — generalization of the todo completion-claim
  guardrail. Detects verification claims (“tests pass”, “lint is clean”, “it builds”, …) in the model’s final message
  and, when no matching bash invocation ran this turn, nudges the model to run the check or retract.
- [`extensions/context-budget.ts`](#extensionscontext-budgetts) — surfaces the model’s own context-window usage inside
  the system prompt each turn, with tone bands that escalate as usage climbs. Optional edge-triggered auto-compaction at
  a configurable percent.
- [`extensions/tool-output-condenser.ts`](#extensionstool-output-condenserts) — head+tail condensing of noisy tool
  results (bash by default) so large outputs don’t eat the session. Full output is stashed to a tempfile the model can
  re-`read` with `--offset` / `--limit`.
- [`extensions/tool-arg-recovery.ts`](#extensionstool-arg-recoveryts) — parses `Validation failed for tool “…”` errors
  from pi-ai, cross-references the tool’s TypeBox schema, and appends a recovery block with each failed path, the
  expected type, what was received, and a concrete corrected-example JSON payload. Targets the small-model failure
  mode of retrying the same wrong argument shape after seeing only the raw validation error.
- [`extensions/read-reread-detector.ts`](#extensionsread-reread-detectorts) — tracks `(absPath, mtime, size)` per
  session; on a repeat `read` of an unchanged file appends a nudge that names the slice, the turn it was first read,
  and points at `scratchpad` for carry-over. Complements [`loop-breaker`](#extensionsloop-breakerts) (which only
  catches identical `(tool, input)` repeats) by catching “same file, possibly different window, across turns”.
- [`extensions/read-without-limit-nudge.ts`](#extensionsread-without-limit-nudgets) — when a `read` call without
  `offset`/`limit` lands on a file over ~400 lines or ~20 KB, appends a short steer recommending `rg -n`, a targeted
  windowed `read`, or `ls`/`head`/`tail` for structural orientation. Uses pi’s own `details.truncation` when present,
  falls back to a `statSync` byte count.
- [`extensions/btw.ts`](#extensionsbtwts) — Claude Code `/btw`-style ephemeral side-question command. Answers a
  one-shot question from the session's already-loaded context without persisting the Q&A and without letting the
  model call tools; reuses the active model, system prompt, and conversation prefix for prompt-cache reuse.
- [`../../lib/node/pi/`](../../lib/node/pi) — pure helpers (no pi imports) shared between the extensions and unit-tested
  under [`../../tests/lib/node/pi/`](../../tests/lib/node/pi). Hoisted out of `extensions/` so they get type-checked by
  the repo's root `tsconfig.json`.
- [`skills/plan-first/SKILL.md`](#skillsplan-first) — global skill that teaches models WHEN to reach for the `todo` tool
  and how to keep the plan accurate. Companion to [`extensions/todo.ts`](#extensionstodots).
- [`skills/grep-before-read/SKILL.md`](#skillsgrep-before-read) — teaches models to default to `rg -n` for discovery
  instead of `read`ing whole files. Ships seven recipes (definition lookup, call-site search, path-restricted search,
  etc.), a concrete before/after demonstrating the context savings, and a quick-reference table. Complements
  [`extensions/read-without-limit-nudge.ts`](#extensionsread-without-limit-nudgets) and
  [`extensions/read-reread-detector.ts`](#extensionsread-reread-detectorts).
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
  [`lib/node/pi/git-worktree.ts`](../../lib/node/pi/git-worktree.ts). Only rendered when `.git` is a pointer file
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
  State is shared between the two extensions via [`lib/node/pi/session-flags.ts`](../../lib/node/pi/session-flags.ts),
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

## `extensions/subdir-agents.ts`

Lazy loader for `AGENTS.md` / `CLAUDE.md` files nested **below** `ctx.cwd`. Replicates the discovery behaviour of Claude
Code, Codex, and opencode on top of pi.

### Why

Pi's built-in context-file loader walks **upward** from cwd at startup: `~/.pi/agent/AGENTS.md` + every `AGENTS.md` /
`CLAUDE.md` along the path from the filesystem root down to cwd. Anything **below** cwd — e.g. `tests/AGENTS.md`,
`packages/frontend/AGENTS.md`, `docs/AGENTS.md` — is never picked up automatically, even when the model is actively
editing files in that subdirectory. Other agents discover those files on file access; pi doesn't.

This extension fills in the downward direction. It watches `read` / `write` / `edit` tool calls, walks from each target
file's directory up to `ctx.cwd`, and — for every directory that has an `AGENTS.md` or `CLAUDE.md` not already loaded —
injects the file contents as a steered user message. The model sees the injected context after the current assistant
turn's tool calls complete and before its next response, which is exactly when it's about to reason about the file it
just touched.

### Scope

- **Tools watched:** `read`, `write`, `edit`. `bash` paths are too noisy to parse reliably; `grep` / `find` / `ls` don't
  imply the model is about to DO anything with the listed files.
- **Directory scope:** only files inside `ctx.cwd`. Files outside the workspace are pi's existing upward-walk problem,
  not this extension's.
- **Filenames:** `AGENTS.md`, `CLAUDE.md`. Override with `PI_SUBDIR_AGENTS_NAMES`.
- **Dedup:** both the startup-loaded baseline (captured on first `before_agent_start`) and anything this extension has
  already injected are tracked so the same file is never surfaced twice. Symlinked aliases (e.g.
  `CLAUDE.md -> AGENTS.md`) are deduped via `realpath`.
- **Size cap:** each file is capped at 16 KB of UTF-8 before injection, cut on a code-point boundary. The truncation
  notice tells the model to re-`read` the full file if it needs more.

### Delivery

The injection is a `custom`-role message with `customType: "subdir-agents"`, delivered via
`pi.sendMessage({ deliverAs: "steer" })`. In pi's internal conversion, `custom` messages become synthetic `user`
messages when serialized for the LLM, so the model genuinely sees the AGENTS.md content alongside whatever tool results
came back in that turn.

Content format:

```text
**Subdirectory context file(s) discovered:** `tests/AGENTS.md`

You just accessed files under a subdirectory with its own `AGENTS.md` / `CLAUDE.md`. These
instructions apply to work in that subtree and supplement — not replace — the project-root
context already loaded at startup.

<context file="tests/AGENTS.md">
... file contents ...
</context>
```

Multiple newly discovered files are batched into a single injection, shallowest-first, so the model reads parent
guidance before any child overrides.

### TUI rendering

The raw `content` field that the LLM consumes includes the full AGENTS.md text, which would be noisy and redundant to
print verbatim in the TUI — the user just asked to read a file in that subtree, they don't need the AGENTS.md body
echoed back at them. A `registerMessageRenderer("subdir-agents", …)` renderer collapses each injection to a compact
status line driven by `details.files`:

```text
[subdir-agents] loaded tests/AGENTS.md (3.9 KB)
[subdir-agents] loaded 2 context files (5.1 KB total)
```

When the message is expanded (`e` on the focused message in pi's TUI) and contains more than one file, the renderer also
lists the individual paths + sizes. The full file body stays in the serialized session and in the LLM's message stream —
only the user-facing rendering is trimmed.

### Commands

- `/subdir-agents` — list the startup-loaded baseline and every file this extension has injected this session.

### Environment variables

- `PI_SUBDIR_AGENTS_DISABLED=1` — skip the extension entirely.
- `PI_SUBDIR_AGENTS_NAMES=a,b,c` — comma-separated filenames to discover in each ancestor directory (default
  `AGENTS.md,CLAUDE.md`).

### Hot reload

Edit [`extensions/subdir-agents.ts`](./extensions/subdir-agents.ts) or
[`lib/node/pi/subdir-agents.ts`](../../lib/node/pi/subdir-agents.ts) and run `/reload` in an interactive pi session.

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
   (`looksLikeCompletionClaim` in [`lib/node/pi/todo-prompt.ts`](../../lib/node/pi/todo-prompt.ts)) while `in_progress`,
   `review`, or `pending` todos still exist, the extension injects a follow-up user message nudging it to finish,
   verify, or `block` the open items. Idempotent — the steer carries a sentinel marker and is skipped if the previous
   user message already bore one, so the loop terminates even if the model ignores it.

3. **Compaction resilience.** Each successful tool call mirrors the post-action state to a `customType: 'todo-state'`
   session entry in addition to `toolResult.details`. Pi's `/compact` can summarize old tool-result messages away, but
   the custom entry travels with the branch so the reducer can still reconstruct the plan on `session_start` /
   `session_tree`.

4. **Branch awareness.** Because state is reconstructed from the branch by
   [`reduceBranch`](../../lib/node/pi/todo-reducer.ts), `/fork`, `/tree`, and `/clone` automatically show the correct
   plan for that point in history. No external files, no cross-branch leakage.

### Environment variables

- `PI_TODO_DISABLED=1` — skip the extension entirely.
- `PI_TODO_DISABLE_AUTOINJECT=1` — keep the tool but don't append the active plan to the system prompt.
- `PI_TODO_DISABLE_GUARDRAIL=1` — don't fire the `agent_end` re-prompt when the model claims done with open todos.
- `PI_TODO_MAX_INJECTED=N` — cap on `pending` items rendered inside the injected block (default `10`).

### Hot reload

Edit [`extensions/todo.ts`](./extensions/todo.ts) (or the helpers under [`lib/node/pi/`](../../lib/node/pi)) and run
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
[`classifyAssistant()`](../../lib/node/pi/stall-detect.ts). Detection is deliberately conservative:

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
[`lib/node/pi/stall-detect.ts`](../../lib/node/pi/stall-detect.ts) and run `/reload` in an interactive pi session.

## `extensions/scratchpad.ts`

Unstructured working-notes tool + system-prompt auto-injection. Companion to [`todo.ts`](#extensionstodots): where
`todo` holds the typed plan (pending / in_progress / review / completed / blocked), `scratchpad` holds free-form
carry-over the model benefits from remembering turn to turn — decisions, file paths it keeps rediscovering, test / lint
commands, user answers to clarifying questions.

### What the tool does

Registers a single `scratchpad` tool the LLM can call and a `/scratchpad` command for the user. Actions:

| Action   | Required                     | Optional                | Purpose                                                                                |
| -------- | ---------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `list`   | —                            | —                       | Dump the current notebook.                                                             |
| `append` | `body`                       | `heading`               | Add a note. `heading` groups related notes in the injected block.                      |
| `update` | `id` (+ `body` or `heading`) | `body` and/or `heading` | Modify a note’s body and/or heading. Empty heading clears it.                          |
| `remove` | `id`                         | —                       | Delete a note. `nextId` does **not** rewind — prevents id collisions on later appends. |
| `clear`  | —                            | —                       | Wipe the notebook.                                                                     |

Notes are trimmed on write; attempting to `update` a note with an empty body returns an error (pointing at `remove`).

### Weak-model affordances

1. **System-prompt auto-injection** (`before_agent_start`). The notebook is rendered under a `## Working Notes` header
   with a soft character cap (default 2000) so long sessions don’t eat the prompt. Notes are grouped by heading in
   first-seen order; ungrouped notes render first under an implicit “Notes” header. When the cap is hit we emit a
   trailer telling the model to call `scratchpad` with action `list` for the rest.

2. **Compaction resilience.** Each successful tool call mirrors the post-action state to a
   `customType: 'scratchpad-state'` session entry in addition to `toolResult.details`. Pi’s `/compact` can summarize old
   tool-result messages away; the custom entry travels with the branch so the reducer in
   [`lib/node/pi/scratchpad-reducer.ts`](../../lib/node/pi/scratchpad-reducer.ts) can still reconstruct the notebook on
   `session_start` / `session_tree`.

3. **Branch awareness.** Because state is reconstructed from the branch, `/fork`, `/tree`, and `/clone` automatically
   show the correct notes for that point in history. No external files, no cross-branch leakage.

### Commands

- `/scratchpad` (or `/scratchpad list`) — raw state dump of every note id / heading / body on the current branch.
- `/scratchpad preview` — shows the exact `## Working Notes` block that would be appended to the next turn's system
  prompt (respecting `PI_SCRATCHPAD_MAX_INJECTED_CHARS`). Surfaces a clear "nothing would be injected" message when the
  notebook is empty or `PI_SCRATCHPAD_DISABLE_AUTOINJECT=1` is set, so you can quickly answer "is the extension doing
  anything this turn?" without reading extension code.

### Environment variables

- `PI_SCRATCHPAD_DISABLED=1` — skip the extension entirely.
- `PI_SCRATCHPAD_DISABLE_AUTOINJECT=1` — keep the tool but don’t append the notebook to the system prompt.
- `PI_SCRATCHPAD_MAX_INJECTED_CHARS=N` — soft cap on the injected block in characters (default `2000`, floor `200`).

### Hot reload

Edit [`extensions/scratchpad.ts`](./extensions/scratchpad.ts) or the helpers under
[`lib/node/pi/scratchpad-reducer.ts`](../../lib/node/pi/scratchpad-reducer.ts) /
[`lib/node/pi/scratchpad-prompt.ts`](../../lib/node/pi/scratchpad-prompt.ts) and run `/reload` in an interactive pi
session to pick up changes without restarting.

## `extensions/verify-before-claim.ts`

Generalization of the todo completion-claim guardrail. Catches the very common failure mode where weaker models (and
some stronger ones in a hurry) sign off with a _verification_ claim — “tests pass”, “lint is clean”, “it builds”, “tsc
is happy” — without actually having run the check in the current turn.

Composes cleanly with the other `agent_end` extensions:

|                             | Signal                                                                          |
| --------------------------- | ------------------------------------------------------------------------------- |
| `todo` guardrail fires when | Assistant signs off as “done” with open todos still around.                     |
| `stall-recovery` fires when | Turn produced no text and no tool calls, or the turn has an explicit error.     |
| `verify-before-claim` fires | Assistant claimed a check passes AND no matching bash invocation ran this turn. |

All three use distinct sentinel markers and an idempotency check on the latest user message, so they never re-trigger on
their own nudges. They **can** fire together on the same turn; each reaches the model separately.

### Detection

On `agent_end`, [`lib/node/pi/verify-detect.ts`](../../lib/node/pi/verify-detect.ts):

1. Pulls the last assistant text and scans the **tail** (~600 chars) for typed claim phrases via `extractClaims`. Claim
   kinds: `tests-pass`, `lint-clean`, `types-check`, `build-clean`, `format-clean`, `ci-green`. Questions and
   conditionals (“if the tests pass…”, “hopefully the build is clean”) are rejected outright.

2. Walks the branch backward to the most recent user message, collecting every bash command that ran in between —
   assistant `toolCall` parts with `name === 'bash'`, `toolResult` entries with `toolName === 'bash'`, and
   `bashExecution` messages (user-invoked `!cmd`).

3. Partitions claims into `(verified, unverified)` using liberal per-kind command patterns: e.g. `tests-pass` matches
   `jest`, `vitest`, `mocha`, `pytest`, `cargo test`, `cargo nextest run`, `go test`, `bats`, `node --test`, `npm test`,
   `pnpm run test`, `./dev/test-docker.sh`, etc. `lint-clean` matches `eslint`, `shellcheck`, `ruff`, `rubocop`,
   `cargo clippy`, `golangci-lint`, `./dev/lint.sh`, and more. Matching is deliberately liberal — false positives merely
   suppress a nudge, false negatives merely produce one extra nudge.

4. If `unverified.length > 0` AND the most recent user message doesn’t already carry the `⚠ [pi-verify-before-claim]`
   sentinel, injects a follow-up user message via `pi.sendUserMessage(..., { deliverAs: 'followUp' })`:

   > You claimed “all tests pass” (tests pass), but I don’t see a tool call that would have verified it in this turn.
   > Either run the check and report the real outcome, or retract the claim and tell the user what you actually did.

### Command-match anchoring

Patterns require a command-start anchor (`^` / whitespace / `&|;(`) AND a command-end lookahead (whitespace / end of
string / `&|;)<>`). The end anchor explicitly excludes `.` so `cat jest.config.js` does **not** match `jest` and
`eslint.config.mjs` does **not** match `eslint`. Both are common false-positive vectors the unit tests pin down.

### Environment variables

- `PI_VERIFY_DISABLED=1` — skip the extension entirely.
- `PI_VERIFY_VERBOSE=1` — emit a `ctx.ui.notify` on every detection / decision. Useful for tuning the claim regexes
  against a noisy local model.

### Hot reload

Edit [`extensions/verify-before-claim.ts`](./extensions/verify-before-claim.ts) or
[`lib/node/pi/verify-detect.ts`](../../lib/node/pi/verify-detect.ts) and run `/reload` in an interactive pi session.

## `extensions/context-budget.ts`

Surfaces the model’s own context-window usage **inside its system prompt** each turn. Pi’s statusline already shows
`N% left` to the user, but the model doesn’t see the statusline — it only sees the system prompt. Without this
extension, weaker models happily chain a dozen broad `read`s / `rg` calls until the window is nearly full. With it, each
turn’s system prompt ends with a one-line advisory that both reports the number AND points at the remediation.

### Tone bands

Rendered by [`lib/node/pi/context-budget.ts`](../../lib/node/pi/context-budget.ts). Percent is computed from
`ctx.getContextUsage()` (`tokens / contextWindow`). Thresholds are configurable via env vars.

| Usage                    | Injected? | Tone                                                                                                               |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `< minPercent` (<50%)    | no        | Casual chats and early-session work don’t need the nag.                                                            |
| `min–warn` (50–80%)      | yes       | “Context: N% used (… tokens left of K). Prefer targeted `rg` with patterns over broad reads; use `read --offset`…” |
| `warn–critical` (80–90%) | yes       | “… Be efficient with tool output — favor targeted `rg`/`grep` over broad reads…”                                   |
| `≥ critical` (≥90%)      | yes       | “… You are running out of context — finish what’s essential now … Consider `/compact` if you need more room.”      |

One-line format keeps signal-per-token high; token counts render via `formatTokens` (e.g. `45k`, `1.23M`) so they match
the statusline.

### Optional auto-compaction

When `PI_CONTEXT_BUDGET_AUTO_COMPACT_PERCENT` is set, the extension calls `ctx.compact()` once when usage
**edge-triggers** across the threshold (previous turn below, current turn at or above). Edge-triggering protects against
re-compacting every turn while sitting above the line. After a successful compaction drops usage back below the
threshold, the trigger re-arms for long sessions. Off by default — auto-compact is a big hammer; the advisory line is
often enough on its own.

### Commands

- `/context-budget` (or `/context-budget preview`) — shows the current usage, thresholds, auto-compact state, and the
  **exact advisory line** that would be appended to the next turn's system prompt (or an explanatory "no advisory would
  be injected (reason: usage X% is below min-percent Y%)" message when silent). Useful for answering "am I actually
  below the threshold?" and "which tone band am I in right now?" without reading extension code.

### Environment variables

- `PI_CONTEXT_BUDGET_DISABLED=1` — skip the extension entirely.
- `PI_CONTEXT_BUDGET_MIN_PERCENT=N` — start injecting at `N%` (default `50`).
- `PI_CONTEXT_BUDGET_WARN_PERCENT=N` — switch to “be efficient” tone at `N%` (default `80`).
- `PI_CONTEXT_BUDGET_CRITICAL_PERCENT=N` — switch to “running out” tone at `N%` (default `90`).
- `PI_CONTEXT_BUDGET_AUTO_COMPACT_PERCENT=N` — auto-compact when usage edge-crosses `N%`. Unset = off.
- `PI_CONTEXT_BUDGET_AUTO_COMPACT_INSTRUCTIONS=TEXT` — extra instructions passed to `ctx.compact()` when auto-triggered.

### Hot reload

Edit [`extensions/context-budget.ts`](./extensions/context-budget.ts) or
[`lib/node/pi/context-budget.ts`](../../lib/node/pi/context-budget.ts) and run `/reload` in an interactive pi session.

## `extensions/tool-output-condenser.ts`

Tighter head+tail truncation for noisy tool results so large outputs don’t eat the session. Pi’s built-in `bash` tool
already caps at 50KB / 2000 lines to keep processes sane; this extension applies a tighter head+tail budget on top
(default 12KB / 400 lines, 80 head + 80 tail) so the model sees the useful part of each command’s output — invocation
banner and first errors on top, summary / exit banner / final error on the bottom — without the boilerplate middle.

The full output is stashed to a tempfile via `mkdtemp` + `writeFile`; the condensed text ends with a breadcrumb:

```text
⟨ [pi-tool-output-condenser] ⟩ bash output was condensed: kept 161 of 5000 lines (11.9KB of 210.4KB); omitted 4839
lines (198.5KB). Full output saved to: /tmp/pi-bash-condensed-XXXX/output.txt — re-read with the `read` tool
(`offset` / `limit`) if you need specific lines.
```

### Why it compounds

Smaller session ⇒ less frequent compaction ⇒ the [`todo`](#extensionstodots) / [`scratchpad`](#extensionsscratchpadts)
auto-injection stays visible across more turns; the [`context-budget`](#extensionscontext-budgetts) line stays in the
neutral band longer. For weak models chained across many bash calls this is one of the biggest per-turn wins available.

### Design notes

- Hooks `tool_result`, not `tool_call` — the command still executes with full output; only the **session-stored** copy
  is condensed.
- Only text content parts are touched; image parts pass through unchanged.
- Reuses pi’s existing `fullOutputPath` when the built-in bash tool already wrote one, so the model never sees two
  competing breadcrumbs.
- Records condenser metadata on `details.condenser` (`truncated`, `originalBytes`, `originalLines`, `outputBytes`,
  `outputLines`, `fullOutputPath`) for downstream renderers / debugging.
- Errors writing the tempfile log a `ctx.ui.notify` warning but **do not** block the result — the extension returns the
  condensed text without a breadcrumb rather than failing the tool call.

### Environment variables

- `PI_CONDENSER_DISABLED=1` — skip the extension entirely.
- `PI_CONDENSER_TOOLS=t1,t2,...` — comma list of tool names to condense (default `bash`; case-insensitive). Add `rg`,
  `grep`, or any custom tool that produces large text output.
- `PI_CONDENSER_MAX_BYTES=N` — byte cap on the condensed body (default `12288` = 12 KB; floor `512`).
- `PI_CONDENSER_MAX_LINES=N` — line cap on the condensed body (default `400`; floor `20`).
- `PI_CONDENSER_HEAD_LINES=N` — lines kept from the head (default `80`; floor `1`).
- `PI_CONDENSER_TAIL_LINES=N` — lines kept from the tail (default `80`; floor `1`).

### Hot reload

Edit [`extensions/tool-output-condenser.ts`](./extensions/tool-output-condenser.ts) or
[`lib/node/pi/output-condense.ts`](../../lib/node/pi/output-condense.ts) and run `/reload` in an interactive pi session.

## `extensions/btw.ts`

Claude Code `/btw`-style ephemeral side-question command. Type `/btw <question>` to ask something about the current
session without saving the Q&A to history and without letting the model call tools.

### Why

Quick questions during a long session — "what file did we edit three turns ago?", "summarize the plan in two
bullets", "which approach did we rule out?" — don't need a new user turn. They don't need tool access. They
shouldn't clutter the transcript. Claude Code bundles this as `/btw`; this extension replicates the UX on pi.

### Mechanism

Pi's extension API doesn't expose a "call the LLM out of band" primitive — `pi.sendMessage` /
`pi.sendUserMessage` both append to the session and trigger turns. `/btw` therefore reaches through the API and
calls [`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai)'s `complete()` function
directly, using pi's own helpers to reconstruct the branch context that would otherwise be sent next turn:

1. Grab the current branch: `ctx.sessionManager.getBranch()`.
2. Convert entries → LLM messages: `buildSessionContext(entries)` (exported from `pi-coding-agent`).
3. Append the side question as a synthetic user message with a short directive (no tools, not persisted).
4. Resolve creds: `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)`.
5. Call `complete(model, { systemPrompt, messages, tools: [] }, { apiKey, headers, sessionId, cacheRetention: "short", signal })`.
6. Render the answer via `ctx.ui.notify` with a one-line footer (model · tokens · cached · out · $cost · duration · `ephemeral`).
7. Do **not** call `pi.sendMessage` / `pi.sendUserMessage` / `pi.appendEntry` — that's what keeps the Q&A ephemeral.

### What's inherited from the main turn

- **Model** — `ctx.model`, including any `/model` switch the user did mid-session. Override with `PI_BTW_MODEL`.
- **System prompt** — `ctx.getSystemPrompt()`, which includes every extension's injected sections.
- **Messages** — the branch's full message list, so the side question sees everything the main turn would have.
- **`sessionId` + `cacheRetention: "short"`** — these are the load-bearing knobs for prompt-cache reuse.
- **API key + custom headers** — via `ModelRegistry.getApiKeyAndHeaders()`, so OAuth / basic-auth / proxies work.
- **`signal`** — the session's abort signal, so Ctrl+C cancels the side question cleanly.

### What's NOT inherited

`temperature`, `maxTokens`, `timeoutMs`, `maxRetries`, `metadata`, and per-provider options (Anthropic's thinking
display, Google's `thinkingBudgets`, Bedrock options) are not reachable from `ExtensionContext`. pi-ai's defaults
apply. For the typical Anthropic / OpenAI / local-OpenAI-compatible case prompt caching still works because the
request prefix is unchanged; for exotic provider-specific setups cache reuse is best-effort.

### Ephemeral footer

Every answer ends with a one-line stats footer so the user can verify which model answered, whether caching
engaged, and how much the call cost:

```text
[model: claude-opus-4-7 · 3.6k tokens · 2.9k cached · 180 out · $0.0023 · 1.2s · ephemeral]
```

Fields render only when present (e.g. `cached` is omitted when zero, `$` is omitted when cost is 0). The trailing
`ephemeral` is always shown as a reminder that the Q&A was not saved.

### Commands

- `/btw <question>` — answer a side question. With no argument, prints the usage help.

### Environment variables

- `PI_BTW_DISABLED=1` — skip the extension entirely (no `/btw` command registered).
- `PI_BTW_MODEL=provider/modelId` — answer side questions with a specific model instead of the session's current
  one. Useful for pairing a big reasoning model on the main turn with a cheaper fast model on side questions.
  Falls back to the current model with a warning if the override isn't registered.
- `PI_BTW_INCLUDE_TOOLS=1` — pass the currently-active tools to the side-question call instead of `[]`. Escape
  hatch for debugging; defeats the whole point of the command.

### Hot reload

Edit [`extensions/btw.ts`](./extensions/btw.ts) or [`lib/node/pi/btw.ts`](../../lib/node/pi/btw.ts) and run
`/reload` in an interactive pi session to pick up changes without restarting.

## `extensions/tool-arg-recovery.ts`

Targeted recovery block for TypeBox validation failures — the `edit-recovery`-style pattern applied to every tool
call, not just `edit`.

When the LLM emits a tool call whose arguments don’t match the tool’s TypeBox schema, pi-ai’s `validateToolArguments`
throws a canonical message (`Validation failed for tool "X":\n  - <path>: <message>\n\nReceived arguments: {...}`),
which pi wraps via `createErrorToolResult(error.message)`. Small self-hosted models read that raw error, guess at a
fix, and retry with the same wrong shape — because the error tells them WHAT’s wrong but not what a working payload
looks like.

This extension intercepts `tool_result` on validation failures, cross-references the tool’s schema via
`pi.getAllTools()`, and appends a second text part with:

- each failed argument path (e.g. `` `items.0.body` ``)
- the rule that was violated (e.g. `Expected string`)
- a short description of the expected type (`number`, `"list" | "add" | "start"`, `object[]`, …)
- a short description of what was received (`` `"1"` (string)``, `` `{…}` (object)``)
- a concrete corrected-example JSON payload when a schema is available (placeholders like `<string>` / `0` where the
  model still has to supply real values)
- a “do not retry with the same arguments” footer

Pi’s original error stays intact at index 0; the recovery block is appended as a second text part, matching
[`extensions/edit-recovery.ts`](./extensions/edit-recovery.ts)’s composition pattern. No auto-retry — surfacing the
mistake keeps [`verify-before-claim`](#extensionsverify-before-claimts),
[`loop-breaker`](#extensionsloop-breakerts), and [`stall-recovery`](#extensionsstall-recoveryts) honest.

Example output for a `todo` call with `id: "1"` (string instead of number):

```text
⚠ [pi-tool-arg-recovery] tool=todo

Problems with the arguments:
  - `id`: Expected number. expected number. got `"1"` (string).

Corrected example (replace placeholders, then retry):
```json
{
  "action": "start",
  "id": 0
}
```

Do NOT retry with the same arguments. Fix the types/fields above, then call the tool again with a corrected payload.
```

### Environment variables

- `PI_TOOL_ARG_RECOVERY_DISABLED=1` — skip the extension entirely.
- `PI_TOOL_ARG_RECOVERY_DEBUG=1` — `ctx.ui.notify` on every decision.
- `PI_TOOL_ARG_RECOVERY_TRACE=<path>` — append one line per decision to `<path>` (useful in `-p` / RPC mode).
- `PI_TOOL_ARG_RECOVERY_MAX_EXAMPLE_CHARS=N` — cap on the serialized corrected example (default `1500`). Past the cap
  the fenced block is omitted; the diagnosis still renders.

### Hot reload

Edit [`extensions/tool-arg-recovery.ts`](./extensions/tool-arg-recovery.ts) or
[`lib/node/pi/tool-arg-recovery.ts`](../../lib/node/pi/tool-arg-recovery.ts) and run `/reload` in an interactive pi
session.

## `extensions/read-reread-detector.ts`

Second-layer companion to [`loop-breaker`](#extensionsloop-breakerts). That extension catches identical
`(toolName, input)` hashes repeating inside a short window; this one catches the broader small-model failure mode of
`read`-ing the same file 3–5 times across a task — once to orient, again after forgetting, again after a follow-up
prompt.

For every successful `read`, the extension `statSync`s the file and records a `(absPath, mtimeMs, size)` signature
plus the offset/limit the model asked for and the current turn. On any subsequent `read` of the same path we classify:

- **first-time** — unseen path → pass through.
- **same-slice** — same path + unchanged signature + same offset/limit → append a nudge naming the slice, when it
  was first read, and pointing at `scratchpad` for carry-over.
- **different-slice** — same path + unchanged signature + different window → softer nudge suggesting
  `rg -n "<pattern>" <path>` or `scratchpad` for incremental capture.
- **changed** — mtime or size differs → silent, update the signature.

The turn counter only bumps on REAL user input — extension-synthesized messages (`source: "extension"`) don’t count,
so “N turns ago” stays semantically correct when other extensions inject steers between turns.

Pure logic (history store, classification, nudge formatting) lives in
[`lib/node/pi/read-reread.ts`](../../lib/node/pi/read-reread.ts) so it can be unit-tested under `vitest` without pulling
in the pi runtime.

### Environment variables

- `PI_READ_REREAD_DISABLED=1` — skip the extension entirely.
- `PI_READ_REREAD_MAX_ENTRIES=N` — cap on tracked files (default `256`, insertion-order eviction).
- `PI_READ_REREAD_DEBUG=1` — `ctx.ui.notify` on every decision.
- `PI_READ_REREAD_TRACE=<path>` — append one line per decision to `<path>`.

### Hot reload

Edit [`extensions/read-reread-detector.ts`](./extensions/read-reread-detector.ts) or
[`lib/node/pi/read-reread.ts`](../../lib/node/pi/read-reread.ts) and run `/reload` in an interactive pi session.

## `extensions/read-without-limit-nudge.ts`

Low-false-positive steer for `read` calls that skip `offset`/`limit` on files large enough to warrant a targeted
approach. Pi’s `read` tool already caps output at 2000 lines / 50 KB; this extension tells the model “for files this
size, `rg -n` or a windowed `read` would have been the better first move” so the NEXT call is tighter.

Signal sources (in priority order):

1. Pi’s own `details.truncation.totalLines` / `.totalBytes`. Populated when pi truncated or the user’s `limit` stopped
   early — the strongest signal.
2. Fallback: when pi didn’t populate truncation (file fit inside the default caps), `statSync` the file and
   synthesize a `TruncationLike` from byte size. Line count isn’t cheap without re-reading, so the fallback path is
   byte-only.

Decision rules (OR together — whichever triggers first):

- Skip when `offset` or `limit` is already present, or pi already reported truncation (pi’s own
  `[Showing lines X-Y of Z…]` footer already steers).
- Nudge when `totalLines >= minLines` (default `400`) OR `totalBytes >= minBytes` (default `20480`).

The nudge is appended as a second text part, leaving pi’s original content untouched at index 0. Composes with
[`extensions/read-reread-detector.ts`](#extensionsread-reread-detectorts) (which also appends) and with
[`extensions/tool-output-condenser.ts`](#extensionstool-output-condenserts) (which rewrites only the first text
part).

### Environment variables

- `PI_READ_LIMIT_NUDGE_DISABLED=1` — skip the extension entirely.
- `PI_READ_LIMIT_NUDGE_MIN_LINES=N` — nudge threshold in lines (default `400`).
- `PI_READ_LIMIT_NUDGE_MIN_BYTES=N` — nudge threshold in bytes (default `20480` = 20 KB).
- `PI_READ_LIMIT_NUDGE_DEBUG=1` — `ctx.ui.notify` on every decision.
- `PI_READ_LIMIT_NUDGE_TRACE=<path>` — append one line per decision to `<path>`.

### Hot reload

Edit [`extensions/read-without-limit-nudge.ts`](./extensions/read-without-limit-nudge.ts) or
[`lib/node/pi/read-limit-nudge.ts`](../../lib/node/pi/read-limit-nudge.ts) and run `/reload` in an interactive pi
session.

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

## `skills/grep-before-read`

Companion skill to [`extensions/read-without-limit-nudge.ts`](#extensionsread-without-limit-nudgets) and
[`extensions/read-reread-detector.ts`](#extensionsread-reread-detectorts). Where those extensions catch the failure
mode after the fact, this skill teaches the up-front pattern: default to `rg -n` for discovery, reach for `read` only
once you know the target region.

Contents ([`skills/grep-before-read/SKILL.md`](./skills/grep-before-read/SKILL.md)):

- Seven recipes covering the common discovery goals (symbol definition, call sites, path / language filters, fixed
  strings, counts, filelists, only-changed-files via `git diff --name-only | xargs rg`).
- A concrete before/after example showing the context difference (≈ 40k tokens vs ≈ 800 tokens for the same answer
  on a medium repo).
- Post-grep follow-up workflow: `read --offset --limit` on the target, record the location in `scratchpad`.
- Anti-patterns (don’t `read` without `offset`/`limit` on files over ~400 lines, don’t re-grep the same pattern in a
  turn, avoid `find | xargs grep` in favor of `rg -g`, don’t `rg | head`).
- A quick-reference table at the end the model can scan when partially loaded.

Same auto-triggering rationale as [`skills/plan-first`](#skillsplan-first): the skill description matches requests
implying discovery (“where is X”, “who uses Y”, “find the bug”, unfamiliar repos) so weaker models pull the full
instructions into context when it matters, without the user having to remember `/skill:grep-before-read`.

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
