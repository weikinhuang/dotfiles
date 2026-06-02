# `cross-session-history.ts`

Brings Claude Code-style cross-session prompt history to pi's input editor:

- **Arrow-up** scrolls back through prompts you submitted in **prior** sessions of the same project, not just the
  current session.
- **Ctrl+R** opens a fzf-style reverse-search overlay against the same project history; type to filter, enter to insert.

## What it does

### Arrow-up history (cross-session)

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

### Ctrl+R reverse search

When the editor has focus, `Ctrl+R` opens a centered overlay populated with a deduplicated, most-recent-first list of
project prompts (default cap 5000; one entry per unique prompt -- the most recent occurrence wins). Inside the overlay:

- Type to fuzzy-match. The matcher in [`lib/node/pi/fuzzy-match.ts`](../../../lib/node/pi/fuzzy-match.ts) is a
  subsequence ranker (fzf-style), case-insensitive with a small bonus for case-exact matches, with bonuses for
  consecutive runs and word-start positions. Matched characters are highlighted in the accent color.
- `↑` / `↓` (or `Ctrl+P` / `Ctrl+N`) move the selection. `PageUp` / `PageDown` jump by ten.
- `Ctrl+R` cycles to the next match -- bash-style "press again to find next older."
- `enter` accepts the highlighted prompt and replaces the editor's current text with it.
- `escape` or `Ctrl+C` cancels.

The overlay is intentionally simple: it shows the first line of each prompt truncated to terminal width, with no preview
pane. Multi-line prompts are matched against their first line only, so what you can see is what you can match.

Ctrl+R is intercepted **inside the editor** (`HistoryEditor extends CustomEditor`), so it doesn't conflict with the
global `app.session.rename` binding -- that binding only fires inside the session-selector overlay.

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
- **Ctrl+R is only intercepted when WE own the editor.** When a foreign factory is composed in, key dispatch belongs to
  it -- we don't subclass an arbitrary returned `Component` to monkey-patch `handleInput`. If you want reverse search
  while running a vim-mode editor, the vim editor needs to surface Ctrl+R itself.

If you install another editor extension AFTER this one, pi's last-write-wins semantics apply -- whichever extension's
`session_start` ran last owns the editor. Re-order extension load if that matters.

## Environment variables

- `PI_CROSS_SESSION_HISTORY_DISABLED=1` -- skip the extension entirely.
- `PI_CROSS_SESSION_HISTORY_MAX_PROMPTS=N` -- cap on prompts loaded into the editor's arrow-up history (default `100`).
  The editor's internal ring also caps at 100, so values above 100 silently truncate.
- `PI_CROSS_SESSION_HISTORY_MAX_FILES=N` -- max session files scanned per startup (default `100`, newest-first by
  mtime). Bound on disk I/O for projects with very long session histories.
- `PI_CROSS_SESSION_HISTORY_SEARCH_SIZE=N` -- max prompts in the Ctrl+R reverse-search pool, before deduplication
  (default `5000`). Independent of the arrow-up cap.
- `PI_CROSS_SESSION_HISTORY_DEBUG=1` -- `ctx.ui.notify` how many prompts were loaded each `session_start` (both pools).
  Useful for verifying the extension is firing.

The pure helper also accepts `maxFileBytes` (default 5MB) and `maxPromptLength` (default 4000 chars) caps that aren't
plumbed through env vars; raise them in
[`lib/node/pi/cross-session-history.ts`](../../../lib/node/pi/cross-session-history.ts) if you regularly paste megabytes
into prompts you actually want to scroll back to.

## Hot reload

Edit [`extensions/cross-session-history.ts`](./cross-session-history.ts),
[`lib/node/pi/cross-session-history.ts`](../../../lib/node/pi/cross-session-history.ts), or
[`lib/node/pi/fuzzy-match.ts`](../../../lib/node/pi/fuzzy-match.ts) and run `/reload` in an interactive pi session. On
reload the `session_shutdown` handler hands the editor back to the previously-installed factory (the foreign editor, or
pi's default) and drops the captured UI ref + both prompt caches, so our factory closure isn't left mounted. The next
`session_start` then rebuilds the caches from disk and re-installs the editor factory cleanly.
