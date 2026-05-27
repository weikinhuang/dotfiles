# `cross-session-history.ts`

Brings Claude Code-style cross-session prompt history to pi's input editor: pressing `up` at the top of an empty editor
scrolls back through prompts you submitted in **prior** sessions of the same project, not just the current session.

## What it does

1. On every `session_start`, the extension reads `ctx.sessionManager.getSessionDir()` -- the project-scoped session
   bucket pi already maintains under `~/.pi/agent/sessions/<slug>/` -- and walks the `*.jsonl` files newest-first.
2. [`loadCrossSessionHistory`](../../../lib/node/pi/cross-session-history.ts) parses each session in document order,
   pulls user-typed prompts (`role: "user"`), and concatenates them into a single chronological list (oldest -> newest).
3. The list is capped to the `N` most recent prompts (default 100; matches the editor's internal ring cap).
4. The current session's file (`ctx.sessionManager.getSessionFile()`) is excluded so pi's per-session
   `editor.addToHistory` calls aren't double-counted.
5. The extension installs an editor factory via `ctx.ui.setEditorComponent`. When pi instantiates the editor, the
   factory calls `editor.addToHistory(prompt)` for every cached prompt before pi binds the editor to input. From the
   user's perspective, arrow-up just works -- the current session's history sits on top, then prior sessions in
   reverse-chronological order.

## Cross session, not cross project

Pi's session storage is already bucketed per cwd: each project gets its own `~/.pi/agent/sessions/<slugified-cwd>/`
directory. The extension calls `ctx.sessionManager.getSessionDir()` and reads only that directory -- so prompts from
another project never leak in.

Limitation: if the same project is reachable through multiple paths (e.g. a real path plus a symlink alias), pi may slug
each form into a different bucket and the extension only sees the bucket the current session lives in. That's a pi
runtime concern, not an extension one.

## Composition with custom editors

Several extensions
([modal-editor in pi's examples](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/examples/extensions/modal-editor.ts),
hypothetical vim-mode plugins, etc.) install their own editor factory via `ctx.ui.setEditorComponent`. This extension
composes with them rather than fighting:

- On `session_start`, if `ctx.ui.getEditorComponent()` returns a foreign factory, we capture it, then install our own
  factory which delegates to the foreign one before layering `addToHistory` calls on top.
- Our factory carries a `Symbol.for("pi-cross-session-history-factory")` marker so a subsequent `/reload` or
  `session_start` can recognize itself and avoid chain-wrapping.
- If the inner editor instance does not expose `addToHistory` (i.e. a bespoke editor that doesn't extend `pi-tui`'s
  `Editor`), the extension silently skips history pre-population for it.

If you install another editor extension AFTER this one, pi's last-write-wins semantics apply -- whichever extension's
`session_start` ran last owns the editor. Re-order extension load if that matters.

## Environment variables

- `PI_CROSS_SESSION_HISTORY_DISABLED=1` -- skip the extension entirely.
- `PI_CROSS_SESSION_HISTORY_MAX_PROMPTS=N` -- cap on prompts loaded into the editor's history (default `100`). The
  editor's internal ring also caps at 100, so values above 100 silently truncate.
- `PI_CROSS_SESSION_HISTORY_MAX_FILES=N` -- max session files scanned per startup (default `100`, newest-first by
  mtime). Bound on disk I/O for projects with very long session histories.
- `PI_CROSS_SESSION_HISTORY_DEBUG=1` -- `ctx.ui.notify` how many prompts were loaded each session start. Useful for
  verifying the extension is firing.

The helper also accepts `maxFileBytes` (default 5MB) and `maxPromptLength` (default 4000 chars) caps that aren't plumbed
through env vars; raise them in [`lib/node/pi/cross-session-history.ts`](../../../lib/node/pi/cross-session-history.ts)
if you regularly paste megabytes into prompts you actually want to scroll back to.

## Hot reload

Edit [`extensions/cross-session-history.ts`](./cross-session-history.ts) or
[`lib/node/pi/cross-session-history.ts`](../../../lib/node/pi/cross-session-history.ts) and run `/reload` in an
interactive pi session. The next `session_start` event refreshes the cached prompt list and re-installs the editor
factory.
