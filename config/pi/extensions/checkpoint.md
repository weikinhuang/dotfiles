# checkpoint

Claude-Code-style code **checkpoint / rewind**, built on pi's own conversation tree instead of a parallel history.

pi already navigates its session tree non-destructively - go back, roll forward, fork. It just never moves _code_ in
lockstep. `checkpoint` snapshots the files its `write` / `edit` / `apply_patch` tools touch per user message, anchors
each snapshot to the session-tree entry the message hung off, and - when you navigate or fork the tree - opens an
**interactive review** to restore files to match the destination. Restore is never silent.

## The model: code follows the conversation

- **Boundary = one user message.** A manifest opens on `agent_start` (the only per-user-message signal; `turn_start` is
  per LLM iteration) anchored to the current leaf entry id, accumulates the files the write tools touch, and commits on
  `agent_end`. A message that wrote nothing leaves no manifest.
- **Anchored by session entry id.** Entry ids are stable across a fork (fork rechains `parentId` but preserves `id`), so
  the anchor resolves under both navigation and fork. Leaf ids are volatile - the restore is always recomputed from the
  `oldLeafId` / `newLeafId` each `session_tree` event hands over, never a cached leaf.
- **`before` + `after` blobs.** Each entry stores the file's content hash before the write (for undo) and after (for
  conflict detection _and_ forward redo). Content is deduped by sha256, so `after[N]` and `before[N+1]` collapse to one
  blob - the after-snapshots are nearly free.
- **Undo + redo via the common ancestor.** Any move (backward, forward, cross-branch) is treated uniformly: undo the
  old-leaf→ancestor leg (apply `before`), then redo the ancestor→new-leaf leg (apply `after`). Backward nav has an empty
  redo leg; "roll forward to latest" has an empty undo leg.

## The review flow

Triggered by tree navigation (`session_tree`), a fork landing (`session_start { reason: "fork" }`), or `/rewind`:

1. **Dry-run.** Resolve the per-file target state, then classify each file against its current bytes on disk: `no-op`
   (disk already at target), `clean-restore` (disk matches the expected old state), or `conflict` (disk matches
   neither - edited out-of-band). No writes yet.
2. **Summary (list).** A scrollable, multi-select list: `[x] path/to/file   +12 -3   ⚠ conflict`. Filename + counts
   only. `no-op` rows are hidden; `conflict` rows default unchecked (opt-in); clean rows default checked. `space`
   toggles, `a` toggles all, `⏎`/`→` drills into the file.
3. **Detail.** The full colorized diff (current → target) via pi's `renderDiff`, scrollable (`↑/↓`, `PgUp/PgDn`,
   `Home/End`); `←`/`esc` returns to the list.
4. **Apply / cancel.** `y` restores the **checked** files only; `esc`/`q` cancels. If a restore leaves any file out of
   sync (cancelled or partial), the out-of-sync widget appears (`⚠ code ahead of conversation - /rewind to review`),
   cleared once disk matches the leaf.

`autoReviewOnNavigate` controls step 2's trigger: `review` (default) auto-opens when the plan is non-empty, `auto`
applies the default-checked set silently, `off` only shows the widget. An empty plan is always a silent no-op.

## `/rewind`

- `/rewind` - recompute the plan for the **current leaf vs disk** and reopen the review. This is the change-your-mind /
  deferred-apply path (cancelled earlier, want it back) and the code-only escape hatch - it never moves the conversation
  leaf.
- `/rewind list` - list message checkpoints (anchor entry id · time · file count).
- `/rewind <entryId>` - review/restore to that anchor without moving the conversation.

## Modes

- **`tool`** (default) - snapshot only the files the write tools touch. The snapshot set is exactly "files my tools
  wrote," so restore never reasons about gitignore or risks deleting user-authored files. **Bash-made changes (`sed -i`,
  `mv`, `rm`, redirects) are invisible in this mode** - pi leans on bash more than Claude Code, so reach for `full` if
  you want those reversible.
- **`full`** (opt-in, `mode: "full"`) - additionally snapshots the whole work-tree per message into a **side git-dir**
  (`<store>/git`, outside your `.git`; never touches your refs / index / stash / history; works in a non-git cwd). The
  review is then derived from the git tree diff, so bash-made changes show up as rows too.

### The untracked-files contract (full mode)

- **Untracked but not ignored** → captured (`git add -A`), managed; restore brings them back and removes ones created
  since.
- **Ignored** (`node_modules/`, `dist/`, `.env`, secrets, large binaries) → **never snapshotted, never touched**;
  changes to them are not reversible.
- Restore uses `git clean -fd` (never `-x`, which would nuke ignored files), scoped to the selected paths and gated
  behind a confirmation that previews exactly what would be removed (`full.confirmClean`).
- **Caps**: if `git add -A` would stage more than `full.maxStagedFiles` files or `full.maxStagedBytes` bytes, the tree
  snapshot is skipped (the cap is the backstop behind the gitignore exclusion). The message is still tool-snapshotted.

## Storage

Project-scoped under the agent dir, so it survives a fork's new session file:

```text
<agentDir>/checkpoints/<basename>-<shorthash-of-root>/
  blobs/<sha256>      # deduped before- AND after-content blobs
  <entryId>.json      # one manifest per user message
```

The project key is the git toplevel when in a repo, else the realpath'd cwd. Manifests + blobs older than
`retentionDays` are pruned (mark-sweep) on `session_start`; `0` keeps them forever.

## Configuration

All tunables live in `checkpoint.json` (project `.pi/checkpoint.json` wins over user `<agentDir>/checkpoint.json` over
env over the built-in default; the nested `full` block deep-merges). See
[`../checkpoint-example.json`](../checkpoint-example.json) for the annotated schema. Nothing is hardcoded - every value
is a key.

Environment escape hatches: `PI_CHECKPOINT_DISABLED=1` disables the extension entirely; `PI_CHECKPOINT_DISABLE_FULL=1`
forces `mode: "tool"` regardless of config.

## Not to be confused with…

`context-trim` / `tool-collapse` / `message-edit` overlay the model's _context window_ (what it sees), reversibly.
`checkpoint` moves _files on disk_. They are orthogonal: trimming context never touches your code, and rewinding code
never touches the conversation transcript (only `session_tree` navigation, which pi owns, does).
