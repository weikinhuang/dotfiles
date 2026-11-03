# `cross-session-history.ts`

Brings Claude Code-style cross-session prompt history to pi's input editor:

- **Arrow-up** scrolls back through prompts you submitted in **prior** sessions of the same project, not just the
  current session.
- **Ctrl+R** opens a fzf-style reverse-search overlay against the same project history; type to filter, enter to insert.

## What it does

### Arrow-up history (cross-session)

1. On every `session_start`, the extension reads `ctx.sessionManager.getSessionDir()` -- the project-scoped session
   bucket pi already maintains under `~/.pi/agent/sessions/<slug>/` -- and walks the `*.jsonl` files newest-first.
2. [`loadCrossSessionHistory`](../../../lib/node/pi/cross-session-history.ts) scans each file backwards in 64 KiB
   chunks, pulls user prompts (`role: "user"`), and returns them in chronological order (oldest -> newest). It stops
   once enough recent prompts are found. Sessions larger than 5 MB remain eligible; only individual JSONL lines over 5
   MB are skipped, without buffering their full contents.
3. The list is capped to the `N` most recent prompts (default 100; matches the editor's internal ring cap).
4. The current session's file (`ctx.sessionManager.getSessionFile()`) is excluded from the disk scan. On initial
   startup, pi restores its prompts after the editor is installed. On `/new`, `/resume`, `/fork`, and `/reload`, the
   extension appends the active session's in-memory user entries itself: pi renders those messages before installing the
   replacement editor, and replacing an editor copies its text but not its history. Active prompts remain at the top of
   recall without replaying the same file twice.
5. The extension installs an editor factory via `ctx.ui.setEditorComponent`. When pi instantiates the editor, the
   factory calls `editor.addToHistory(prompt)` for every cached prompt before pi binds the editor to input. From the
   user's perspective, arrow-up just works -- the current session's history sits on top, then prior sessions in
   reverse-chronological order.

Submitted prompts are recovered from pi's session entries, not from a shutdown-only history save. Ctrl+C exit and `/new`
do not require a separate flush by this extension. Text cleared with Ctrl+C before submission is an unsent draft and is
not recorded.

### Ctrl+R reverse search

When the editor has focus, `Ctrl+R` opens a centered overlay populated with a deduplicated, most-recent-first list of
project prompts (default cap 5000; one entry per unique prompt -- the most recent occurrence wins). The pool includes
active-session prompts present at `session_start`, even when they have no persisted session file yet. It is refreshed on
startup, session switches, and `/reload`, not on every submission. Inside the overlay:

- Type to fuzzy-match. The matcher in [`lib/node/pi/fuzzy-match.ts`](../../../lib/node/pi/fuzzy-match.ts) is a
  subsequence ranker (fzf-style), case-insensitive with a small bonus for case-exact matches, with bonuses for
  consecutive runs and word-start positions. Matched characters are highlighted in the accent color.
- `↑` / `↓` (or `Ctrl+P` / `Ctrl+N`) move the selection. `PageUp` / `PageDown` jump by a page (the visible-row count).
- `Ctrl+R` cycles to the next match -- bash-style "press again to find next older."
- `enter` accepts the highlighted prompt and replaces the editor's current text with it.
- `escape` or `Ctrl+C` cancels.

The overlay is intentionally simple: it shows the first line of each prompt truncated to terminal width, with no preview
pane. Multi-line prompts are matched against their first line only, so what you can see is what you can match. The
visible-result count is capped at ten but shrinks to the terminal height (a short pane shows fewer rows and scrolls the
selection) so the overlay never renders taller than the viewport.

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

The pure helper also accepts an optional whole-file `maxFileBytes` cap (unset by default) and a `maxPromptLength` cap
(default 4000 chars); neither is plumbed through env vars. Its per-line memory cap is `DEFAULT_MAX_LINE_BYTES` (default
5 MB) in [`lib/node/pi/cross-session-history.ts`](../../../lib/node/pi/cross-session-history.ts). A prompt in an
oversized JSONL line, such as a user message with very large inline images, is still skipped. Oversized tool or
assistant lines no longer hide other prompts from the same session.

## Hot reload

Edit [`extensions/cross-session-history.ts`](./cross-session-history.ts),
[`lib/node/pi/cross-session-history.ts`](../../../lib/node/pi/cross-session-history.ts), or
[`lib/node/pi/fuzzy-match.ts`](../../../lib/node/pi/fuzzy-match.ts) and run `/reload` in an interactive pi session. On
reload the `session_shutdown` handler hands the editor back to the previously-installed factory (the foreign editor, or
pi's default) and drops the captured UI ref + both prompt caches, so our factory closure isn't left mounted. The next
`session_start` then rebuilds the caches from disk and re-installs the editor factory cleanly.
