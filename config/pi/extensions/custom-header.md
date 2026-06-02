# `custom-header.ts`

Replace pi's default multi-line mascot + keybinding-hints block with a single dim strip so the vertical space above a
new session is a single line instead of eight. Especially helpful in tiled terminals / tmux panes where the first LLM
response would otherwise start below the fold.

## What it does

On `session_start` (only when `ctx.hasUI` is true - no-op in `-p` / RPC mode) the extension installs a static header via
`ctx.ui.setHeader(...)` that renders:

```text
π pi · esc interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
```

The `π pi` brand renders in bold + accent; each hint pair uses pi's own two-tone palette (`key` in `dim`, `desc` in
`muted`) so the strip is visually indistinguishable from a hand-rolled pi default. The line is composed once and
`truncateToWidth`-clipped per render - `invalidate` is a no-op because nothing in the line is dynamic.

## Commands

- `/header` - print which header source is currently mounted (`custom` or `builtin`).
- `/header builtin` - restore pi's built-in mascot + keybinding-hints header for the rest of the session. Useful if you
  want to rediscover the full keybinding list without restarting.
- `/header custom` - re-install the compact single-line header strip (the default), e.g. after switching to the built-in
  header.

## Notes

- Keybind strings are hardcoded (not read from `KeybindingsManager`) - the header assumes vanilla keybinds.
- Falls back to pi's built-in header automatically when the environment disable flag is set, without special-casing.

## Environment variables

- `PI_CUSTOM_HEADER_DISABLED=1` - skip the extension entirely; pi's built-in header renders as normal.

## Hot reload

Edit [`extensions/custom-header.ts`](./custom-header.ts) and run `/reload` in an interactive pi session to pick up
changes without restarting. The `session_shutdown` handler calls `setHeader(undefined)` on reload, so the mounted header
(and the theme closure it captures) is released cleanly before the next `session_start` re-installs a fresh one - no
stale header survives the reload.
