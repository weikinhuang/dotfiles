# pi config

Configuration, custom extensions, and themes for
[pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Files

- [`settings-baseline.json`](#settings-baselinejson) — mirrors `~/.pi/agent/settings.json`.
- [`extensions/statusline.ts`](#extensionsstatuslinets) — two-line status line rendered at the bottom of every pi
  session.
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
