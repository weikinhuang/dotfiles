# `message-edit.ts`

Browse, edit, compare, and restore user/assistant text **for future model context**, without losing later turns. One of
three extensions on the shared [`context-edit` core](../../../lib/node/pi/context-edit); siblings are
[`context-trim`](./context-trim.md) (remove bulky content) and [`tool-collapse`](./tool-collapse.md) (collapse a tool
call and its result).

## Overlay semantics

The original transcript remains unchanged. Edits are branch-local overlays applied in the `context` hook, persisted as
`message-edit-state` custom entries, and recovered on reload, resume, and tree navigation. Unlike branching back to an
earlier message, an overlay keeps later turns on the active path. Branching does not delete the other recorded path.

- Saving changes future model requests; it does not regenerate a response or replay later tool calls.
- Only text changes. Images, thinking, tool calls, other non-text blocks, metadata, and content-block positions remain
  intact. Multiple text blocks are merged into the first text slot; subsequent text slots are blanked.
- Original and current previews refer to the current session projection before/after this extension's overlays, not a
  guarantee that other context-transforming extensions leave those bytes untouched.
- Edits remain active until restored. Re-editing a message replaces its existing edit, not an undo-history stack.
- Failed persistence leaves the previous overlay active and retains the unsaved draft for retry. Sessions without a
  backing file cannot preserve edits across exit; saving in such a session reports that limitation.
- Compaction can remove edited targets. These edits appear as **stale**, undo-only rows; restoring them removes the
  directive, not the compaction. Compaction summaries are built from the recorded session and are not guaranteed to
  incorporate these context-hook edits.

## Commands

| Command                          | Behavior                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/context-edit`                  | Open the searchable browser, initially focused on the latest editable assistant reply, or the latest message if none exists. |
| `/context-edit <handle>`         | Open the explicit-save editor for a message such as `msg2`.                                                                  |
| `/context-edit <search words>`   | Open the browser with a prefilled search, including multiword queries.                                                       |
| `/context-edit list`             | Open the browser filtered to active edits, with target snippets, directive IDs, and stale markers.                           |
| `/context-edit sort order\|size` | Choose chronological (default) or current-text-size order for this session. Bare `sort` reports the preference.              |
| `/context-edit restore <id>`     | Restore one edit; both `7` and `#7` are accepted. IDs must be positive safe integers without suffixes or extra arguments.    |
| `/context-edit clear`            | Restore all message edits, leaving trim/collapse directives alone.                                                           |
| `/context-edit help`             | Print usage; `--help`, `-h`, and `?` are equivalent.                                                                         |

Handles are assigned from original messages before overlays, so an empty edit stays reachable and restoring an edit
cannot renumber later messages. Handles remain local to the current context: compaction and branch changes can alter
them. Stored directives use message targets rather than the displayed ordinal.

Argument completion includes roles, snippets, and edit IDs. It reconstructs candidates from the current session leaf,
not the pre-response context snapshot, so the latest reply is available immediately, including after reload or branch
navigation. Content completion starts at three characters; the browser searches the full original and current text at
any query length. Every word in a multiword query must fuzzy-match; browser results retain the chosen listing order.

Custom screens require an interactive terminal and an idle agent. In print/RPC modes, bare `/context-edit` and `list`
retain textual informational output; editing reports that a terminal UI is required. Restore, clear, sort, and help do
not require a custom screen.

## Browser controls

| Key                                | Action                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------ |
| Type                               | Search full original/current message text while search has focus.        |
| Up/Down, PageUp/PageDown, Home/End | Navigate messages; with preview focus, scroll the preview independently. |
| Enter                              | Edit the selected message; stale rows are restore-only.                  |
| Tab                                | Switch focus between search/list and preview.                            |
| Ctrl+T                             | Cycle all/user/assistant roles.                                          |
| Ctrl+E                             | Toggle edited-only filtering.                                            |
| Ctrl+O                             | Toggle original/current preview.                                         |
| Ctrl+R                             | Restore the selected edit without leaving the browser.                   |
| Escape                             | Close the browser.                                                       |

Navigation uses pi's configured selection keys where applicable. Saving, cancelling, and restoring return to the same
browser with search, filters, and selection retained where the selected row still matches. The selected message and
controls stay visible in a bounded overlay; long previews have their own scroll position.

## Editor controls

| Key                          | Action                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Enter                        | Insert a newline. **Never saves.**                                                                                                    |
| Ctrl+S                       | Explicitly save the draft and return to the browser.                                                                                  |
| Cmd+S                        | Save when the terminal forwards Super+S, or maps Cmd+S to Ctrl+S.                                                                     |
| Ctrl+G                       | Open the draft in `$VISUAL` / `$EDITOR` (pi's configurable external-editor binding). Returning updates the draft, not the saved edit. |
| Escape                       | Cancel an unchanged draft; for a dirty draft, ask whether to discard.                                                                 |
| Ctrl+D at the discard prompt | Discard unsaved changes and return to the browser.                                                                                    |
| Escape at the discard prompt | Keep editing the draft.                                                                                                               |

Ctrl+S is local to this editor; no global pi keybindings change. Cmd+S is conditional on terminal configuration and
keyboard protocol support. If the terminal consumes it, map Cmd+S to the Ctrl+S byte (`0x13`). Saving does not trim the
draft and expands bracketed-paste markers before persistence. An unchanged buffer is a no-op.

The editor shows the handle, role, unsaved state, preserved non-text-part count, and overlay semantics. Successful saves
display the restore command; failures keep the editor and draft open. If the active branch changes while a draft is
open, saving is rejected until the browser is reopened.

## Implementation

- [`message-edit.ts`](./message-edit.ts): command/lifecycle wiring and append-before-publish state changes.
- [`messages.ts`](../../../lib/node/pi/context-edit/messages.ts): pure browser rows, filtering, and ID parsing.
- [`message-edit-overlay.ts`](../../../lib/node/pi/ext/message-edit-overlay.ts): browser, preview, editor, focus,
  explicit save, and discard controls, reusing the shared modal/windowing/external-editor helpers.
- [`apply.ts`](../../../lib/node/pi/context-edit/apply.ts): non-destructive text overlay pass.

## Environment variables

- `PI_MESSAGE_EDIT_DISABLED=1` skips the extension entirely.

## Hot reload

Change the extension or its helpers and run `/reload` in an interactive pi session. Persisted edits are recovered from
the active branch; browser filters and sort preference are UI-local and reset on extension reload.
