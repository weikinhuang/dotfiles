# pi config

Configuration, custom extensions, and themes for
[pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Files

- [`settings-baseline.json`](#settings-baselinejson) — mirrors `~/.pi/agent/settings.json`.
- [`session-usage.ts`](#session-usagets) — CLI that walks `~/.pi/agent/sessions/` and summarizes session token/cost/tool
  usage.
- [`extensions/statusline.ts`](#extensionsstatuslinets) — two-line status line rendered at the bottom of every pi
  session.
- [`extensions/bash-permissions.ts`](#extensionsbash-permissionsts) — Claude Code–style approval gate for `bash`
  tool calls.
- [`extensions/protected-paths.ts`](#extensionsprotected-pathsts) — session-scoped approval gate for `write` /
  `edit` touching `.env` files, `node_modules/`, or anything outside the current workspace.
- [`extensions/lib/`](./extensions/lib) — pure helpers (no pi imports) shared between the extensions and unit-tested
  under [`tests/`](./tests).
- [`tests/`](./tests) — `node --test` unit tests for the pure extension helpers. See [`tests/README.md`](./tests/README.md).
- [`themes/`](#themes) — JSON themes loadable by name from `settings.json`.

Pi auto-discovers [`extensions/`](./extensions) and [`themes/`](./themes) via the `extensions` / `themes` arrays in
[`settings-baseline.json`](./settings-baseline.json). Paths accept `~`, absolute paths, and globs. See
[pi settings docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md#resources) for
the full list of resource directories pi scans — the settings entries are additive to the built-in
`~/.pi/agent/{extensions,themes}` and `.pi/{extensions,themes}` auto-discovery paths, not a replacement.

## `extensions/statusline.ts`

Two-line Claude Code–style footer for pi. Ports the data exposed by
[`../claude/statusline-command.sh`](../claude/statusline-command.sh) onto pi's extension API (`ctx.ui.setFooter`,
`ctx.sessionManager`, `ctx.getContextUsage`).

### Example

```text
[user#host pi-test (main) 82% left $0.042 §a0cd2e69] claude-opus-4-7
 ↳ M(3):↑1k/↻ 12k/↓180 | S:↑4k/↻ 48k/↓720 | ⚒ S:6(~3k)
```

### Line 1 — shell-style context

- **`user#host`** — `os.userInfo()` + short `os.hostname()`.
- **`cwd`** — `basename(ctx.cwd)`, OSC8 hyperlinked to `file://…` (skipped on SSH / WSL-translated on WSL).
- **`(branch)`** — `footerData.getGitBranch()` with a live change watcher.
- **`N% left`** — `100 − ctx.getContextUsage().percent`.
- **`$N.NNN`** — sum of `message.usage.cost.total` across the session branch.
- **`§xxxxxxxx`** — first 8 chars of `ctx.sessionManager.getSessionId()`.
- **`<model>`** — `ctx.model.id`.

### Line 2 — token and tool totals

- **`M(N):↑in/↻ cached/↓out`** — most recent assistant message's usage. `N` = user-prompt turn count.
- **`S:↑in/↻ cached/↓out`** — cumulative session totals.
- **`⚒ S:n(~tokens)`** — tool-call count; paren value is estimated tool-result tokens (bytes / 4).

Subagent (`A(n):…`) and Pro/Max rate-limit segments from the Claude script are intentionally omitted — pi has no
equivalent data sources.

### Environment variables

- `PI_STATUSLINE_DISABLED=1` — restore pi's built-in footer.
- `PI_STATUSLINE_DISABLE_HYPERLINKS=1` or `DOT_DISABLE_HYPERLINKS=1` — skip OSC8 hyperlinks (same knob as
  [`../claude/statusline-command.sh`](../claude/statusline-command.sh)).

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

| Layer | Source | Scope |
| --- | --- | --- |
| Session | in-memory, cleared on `session_shutdown` | current pi session only |
| Project | `.pi/bash-permissions.json` (resolved against `ctx.cwd`) | one repo |
| User | `~/.pi/bash-permissions.json` | all projects |

File schema (JSONC — `//` and `/* */` comments are allowed, trailing commas are not):

```jsonc
{
  // Things I'm OK letting pi run without asking
  "allow": [
    "git status",
    "git log*",              // any args
    "npm test",
    "re:^npm (test|run \\w+)$",
    "/^docker ps( |$)/"      // regex: prefix form
  ],
  /* Belt-and-suspenders for the hardcoded denylist */
  "deny": [
    "rm -rf*",
    "sudo*"
  ]
}
```

Malformed rule files log one `console.warn` per unique path+error (so a typo doesn't silently wipe out your
ruleset) and are otherwise treated as empty. Missing files are silent.

Pattern semantics (checked in this order):

- `re:<regex>` — JS regex, no flags. Config-file only. Anchor with `^`/`$` for whole-command matches
  (`RegExp.test()` is substring-matching by default).
- `/<regex>/<flags>` — JS regex with flags (`gimsuy`). Config-file only. Strings that merely *start* with `/`
  (for example `/usr/bin/true`) fall back to plain exact match unless the portion after the last `/` is all flag
  chars, so real absolute-path commands are safe. Use `re:^/opt/foo/gi$` to escape the ambiguity.
- Trailing `*` — token-aware prefix match (`git log*` matches `git log` and `git log -1` but **not** `git logs`).
- Plain string — exact match (`npm test` matches only `npm test`, not `npm test foo`).

Invalid regex patterns never match and print a single `console.warn` per unique pattern so typos are
discoverable. Regex rules are intended for hand-edited config files — the `/bash-allow` command and the
approval dialog's save-rule options only produce exact / prefix strings.

Compound commands joined by `&&`, `||`, or `;` are split and every sub-command must pass independently. Pipes
(`|`) are intentionally left intact.

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

  | Still applies | Skipped |
  | --- | --- |
  | Hardcoded denylist (`rm -rf /`, fork bomb, `mkfs`, `dd` to raw disk, `curl \| sh`, …) | The approval prompt for unknown commands |
  | Explicit user/project/session deny rules | |
  | `protected-paths` (writes to `.env`, `node_modules/`, or outside the workspace) — separate extension | |

  Auto-mode state is session-scoped and reset on `session_shutdown` / `/reload` / `/new`, so you always re-opt-in
  after a restart. While on, the custom [`statusline.ts`](./extensions/statusline.ts) renders a `⚡` indicator
  in the footer. State is shared between the two extensions via [`extensions/lib/session-flags.ts`](./extensions/lib/session-flags.ts),
  which anchors a singleton on `globalThis` because pi's extension loader (jiti with `moduleCache: false`) gives each
  extension its own copy of imported helper modules.

### Environment variables

- `PI_BASH_PERMISSIONS_DISABLED=1` — bypass the gate entirely.
- `PI_BASH_PERMISSIONS_DEFAULT=allow` — in non-interactive mode, allow unknown commands instead of blocking.

### Hot reload

Rule files are re-read on every tool call, so edits to `bash-permissions.json` take effect immediately. Edits to the
extension itself need `/reload`.

## `extensions/protected-paths.ts`

Session-scoped approval gate for pi's built-in `write` and `edit` tools. Complements
[`extensions/bash-permissions.ts`](#extensionsbash-permissionsts) (which owns the `bash` channel).

### What's protected

A prompt fires when `write` / `edit` targets any of these:

| Category | Matches |
| --- | --- |
| `.env` files | basename equal to `.env` or matching `.env.*`, at any depth |
| `node_modules/` | any path segment equal to `node_modules` (inside the workspace) |
| Outside workspace | path that resolves outside `ctx.cwd` after lexical normalization |
| Extra globs | basename matches any glob in `PI_PROTECTED_PATHS_EXTRA_GLOBS` (comma-separated, `*` / `?`) |

A leading `~` in the tool's `path` argument is expanded to the current user's home directory before
classification (`~/.env` → `$HOME/.env`), so tilde paths can't sneak past the `.env` or outside-workspace
checks. `~user/` syntax isn't supported — it's almost never emitted by an LLM and would need a password-db
lookup.

Symlink-following is intentionally **not** attempted: the classifier uses `path.resolve()` (lexical), so a
symlink inside the workspace pointing outside of it will still be treated as "inside." Fix that with
file-watcher-grade logic if you need it.

### Approval flow

Session-scoped only — there's no persistent allowlist, because these paths are almost always incidental and you
rarely want pi touching them silently forever.

1. Allow once
2. Allow `<path>` for this session
3. Deny
4. Deny with feedback…

In non-interactive mode (`-p`, JSON, RPC without UI) the gate blocks by default; set
`PI_PROTECTED_PATHS_DEFAULT=allow` to override.

### Commands

- `/protected-paths` — list the active protection rules and the current session allowlist.

### Environment variables

- `PI_PROTECTED_PATHS_DISABLED=1` — bypass the gate entirely.
- `PI_PROTECTED_PATHS_DEFAULT=allow` — in non-UI mode, allow unknown paths instead of blocking.
- `PI_PROTECTED_PATHS_EXTRA_GLOBS=a,b,c` — extra basename globs to protect (supports `*` and `?`).

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
