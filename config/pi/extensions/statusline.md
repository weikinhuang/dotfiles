# `statusline.ts`

Claude Code–style footer for pi. Ports the data exposed by
[`../claude/statusline-command.sh`](../../claude/statusline-command.sh) onto pi's extension API (`ctx.ui.setFooter`,
`ctx.sessionManager`, `ctx.getContextUsage`).

## Example

```text
[user#host pi-test (main *+$%) ⎇ feature-x 82% left $0.042 §a0cd2e69] claude-opus-4-7 • high persona:plan
 ↳ M(3):↑1k/↻ 12k/↓180 R 92% | S:↑4k/↻ 48k/W 1.2k/↓720 R 92% | ⚒ S:6(~3k)
preset: fast   ⠋ thinking…
```

## Line 1 - shell-style context

- **`user#host`** - `os.userInfo()` + short `os.hostname()`.
- **`cwd`** - `basename(ctx.cwd)`, OSC8 hyperlinked to `file://…` (skipped on SSH / WSL-translated on WSL).
- **`(branch…)`** - decorated git segment. When the dotfiles-vendored
  [`../../external/git-prompt.sh`](../../../external/git-prompt.sh) is reachable, the extension shells out to
  `__git_ps1 " (%s)"` (same flags as [`../claude/statusline-command.sh`](../../claude/statusline-command.sh):
  `GIT_PS1_SHOWDIRTYSTATE`, `SHOWSTASHSTATE`, `SHOWUNTRACKEDFILES`, `SHOWUPSTREAM=auto`), so you see `*` dirty, `+`
  staged, `$` stash, `%` untracked, and `<>=` upstream arrows - identical to the interactive `PS1` prompt. Results are
  cached per-cwd for 5 s and invalidated on `footerData.onBranchChange` (git HEAD / reftable watcher). When the helper
  can't be located or bash fails, falls back to plain `footerData.getGitBranch()`.
- **`⎇ <name>`** - linked worktree name. Mirrors Claude Code's `workspace.git_worktree` segment but derived entirely
  from on-disk metadata (no subprocess): reads `.git` / `.git/worktrees/<name>/commondir` via
  [`lib/node/pi/git-worktree.ts`](../../../lib/node/pi/git-worktree.ts). Only rendered when `.git` is a pointer file
  **and** the target lives at `<commonGitDir>/worktrees/<name>/` - submodules (which use the same pointer-file scheme
  but target `.git/modules/<name>/`) and `--separate-git-dir` repos therefore render nothing, matching what
  `git worktree list` considers a linked worktree. Cached per-cwd and invalidated alongside the branch cache on HEAD
  changes.
- **`N% left`** - `100 − ctx.getContextUsage().percent`.
- **`$N.NNN`** - sum of `message.usage.cost.total` across the session branch.
- **`§xxxxxxxx`** - first 8 chars of `ctx.sessionManager.getSessionId()`.
- **`<model>`** - `ctx.model.id`.
- **`• <level>`** - `ctx.getThinkingLevel()` when `ctx.model.reasoning` is true (one of `off`, `minimal`, `low`,
  `medium`, `high`, `xhigh`). Mirrors pi's built-in `<model> • <level>` footer suffix; omitted for non-reasoning models.
- **`persona:<name>`** - set by [`./persona.ts`](./persona.ts) via `ctx.ui.setStatus('persona', ...)`. Pulled out of the
  alphabetised line-3 strip and rendered here so the active persona stays alongside the model + thinking hints it
  actually overrides. Hidden when no persona is active.

## Line 2 - token and tool totals

- **`M(N):↑in/↻ cached/↓out R pct%`** - most recent assistant message's usage. `N` = user-prompt turn count; `R pct%` is
  the per-turn cache-hit ratio so you can see whether _this_ message hit the prompt cache.
- **`S:↑in/↻ cached/W write/↓out R pct%`** - cumulative session totals.
  - **`W write`** - `cacheWrite` tokens summed across the session; omitted when zero. Lets you see cache-write spend on
    providers (Anthropic, Bedrock) that bill it separately from input.
  - **`R pct%`** - cache-hit ratio, `cacheRead / (input + cacheRead)`. Quick signal that prompt caching is engaging
    across the session; the matching `R` on `M(…)` reflects only the most recent turn.
- **`⚒ S:n(~tokens)`** - tool-call count; paren value is estimated tool-result tokens (bytes / 4).

Subagent (`A(n):…`) and Pro/Max rate-limit segments from the Claude script are intentionally omitted - pi has no
equivalent data sources.

## Line 3 - extension statuses

- Renders `footerData.getExtensionStatuses()` - values set by other extensions via `ctx.ui.setStatus(key, text)` (e.g.
  preset, working-indicator, [`bash-permissions.ts`](./bash-permissions.ts)).
- The `persona` key is intentionally consumed on line 1 (next to the model + thinking level) and excluded here.
- Because `ctx.ui.setFooter(...)` replaces pi's built-in footer, these statuses would otherwise be muted; appending them
  as a 3rd line keeps every extension's status visible.
- Entries are sorted by key for stable ordering, newlines/tabs are collapsed to single spaces, and the line is truncated
  to the terminal width. Hidden when no extension has set a status.

## Environment variables

- `PI_STATUSLINE_DISABLED=1` - restore pi's built-in footer.
- `PI_STATUSLINE_DISABLE_HYPERLINKS=1` or `DOT_DISABLE_HYPERLINKS=1` - skip OSC8 hyperlinks (same knob as
  [`../claude/statusline-command.sh`](../../claude/statusline-command.sh)).
- `PI_STATUSLINE_DISABLE_GIT_PROMPT=1` - skip `__git_ps1` and always render the plain branch from
  `footerData.getGitBranch()`. Automatically a no-op when
  [`../../external/git-prompt.sh`](../../../external/git-prompt.sh) can't be located.
- `DOTFILES_ROOT` - override where the statusline looks for `external/git-prompt.sh`. Defaults to walking upward from
  the extension file (resolves symlinks, so `~/.dotfiles` → real repo works).

## Colors

Uses only semantic theme tokens (`error`, `warning`, `mdListBullet`, `mdLink`, `success`, `toolTitle`, `muted`,
`accent`, `dim`, `text`), so it adapts to any pi theme - including
[`themes/solarized-dark.json`](../themes/solarized-dark.json) and
[`themes/solarized-light.json`](../themes/solarized-light.json).

## Hot reload

Edit the file and run `/reload` inside an interactive pi session to pick up changes without restarting.
