# `apply-patch.ts`

Codex-format diff-native edit tool that coexists with `edit` / `write`. Aimed at opus-class models on multi-file or
large diffs: one tool call, one parse, one all-or-nothing commit. Small models keep using [`edit`](./edit-recovery.md) —
the [`apply-patch-format`](../skills/apply-patch-format/SKILL.md) skill teaches WHEN to reach for each.

## What the tool does

Registers a single `apply_patch` tool the LLM can call with `params.patch` — the full Codex-format string from
`*** Begin Patch` to `*** End Patch`. The tool runs four phases in order:

1. **Parse.** [`lib/node/pi/apply-patch/parse.ts`](../../../lib/node/pi/apply-patch/parse.ts) tokenises the patch into
   ops. Malformed markers (`**Begin Patch`, missing path on `*** Add File:`, hunk before any op header, …) bail with a
   1-based line number and short message.
2. **Validate + plan.** [`lib/node/pi/apply-patch/apply.ts`](../../../lib/node/pi/apply-patch/apply.ts) walks every op
   against the on-disk snapshot, locates hunks via the whitespace-insensitive matcher from
   [`lib/node/pi/edit-recovery.ts`](../../../lib/node/pi/edit-recovery.ts), and stages a write plan in memory.
   **All-or-nothing**: even one per-op error (hunk miss, overwrite-existing on Add, missing source on Delete / Move)
   aborts the whole patch with concatenated recovery blocks.
3. **Filesystem gate.** Each affected absolute path (every write target and every delete / move source) runs through the
   same [`classifyWrite`](../../../lib/node/pi/filesystem-policy/classify.ts) +
   [`askForPermission`](../../../lib/node/pi/approval-prompt.ts) pipeline that [`filesystem.ts`](./filesystem.md) uses
   for `write` / `edit`. A `Deny` on any one path aborts before any write touches disk.
4. **Commit.** Move sources are removed first; then every write goes through
   [`atomic-write.ts`](../../../lib/node/pi/atomic-write.ts) (tempfile + `rename(2)`); then `Delete File` ops run. A
   failed write mid-batch is rare in practice — the previous moves and writes have already landed.

The plan is staged entirely in memory before any I/O touches the destination tree, so a hunk-mismatch on op #4 of a
five-op patch leaves ops #1-3 unwritten too. That's the atomicity guarantee `apply_patch` exists for.

## Patch format

Four op kinds, each introduced by a sentinel header. The format is Codex's own — not unified-diff. Markers must match
exactly modulo trailing whitespace.

### `*** Add File: <path>`

Creates a new file. The body is `+`-prefixed lines (one per file line), joined with `\n`. Refuses to overwrite an
existing path — use `*** Update File:` for that.

```text
*** Begin Patch
*** Add File: src/greet.ts
+export function greet(name: string): string {
+  return `Hello, ${name}!`;
+}
+
*** End Patch
```

### `*** Update File: <path>`

In-place edit. One or more `@@` hunks; each hunk's old-side (` ` context + `-` removed) must locate against the current
file. Context lines must match verbatim modulo aggressive whitespace normalisation (tabs ↔ spaces, collapsed runs, smart
quotes); the locator borrows the same fuzzy primitives `edit-recovery.ts` uses.

```text
*** Begin Patch
*** Update File: src/greet.ts
@@
 export function greet(name: string): string {
-  return `Hello, ${name}!`;
+  return `Hi, ${name}!`;
 }
*** End Patch
```

### `*** Delete File: <path>`

Removes the file. Body is empty. Refuses to delete a missing file (use the locator's diagnostics to figure out the right
path).

```text
*** Begin Patch
*** Delete File: src/obsolete.ts
*** End Patch
```

### `*** Move File: <from> -> <to>`

Renames `from` to `to`. Optional `@@` hunks apply against the OLD path's content; the result is written at the NEW path
and the old path is removed. One op per move - no `Delete File` + `Add File` workaround.

```text
*** Begin Patch
*** Move File: src/util.ts -> src/helpers.ts
@@
 export function noop(): void {}
+
+export function identity<T>(value: T): T {
+  return value;
+}
*** End Patch
```

### Multi-op patches

Ops are applied left-to-right against a single snapshot of the working tree. A second op touching the same path as a
prior op is rejected as a plan conflict — splice the changes into one `Update File` op instead.

```text
*** Begin Patch
*** Add File: src/lib.ts
+export const VERSION = '1.0.0';
*** Update File: src/index.ts
@@
 import { foo } from './foo';
+import { VERSION } from './lib';
*** Delete File: src/obsolete.ts
*** End Patch
```

## Composition with other extensions

- **[`filesystem.ts`](./filesystem.md) — applies per-write.** Each path in the staged plan runs through the same
  `classifyWrite` + `askForPermission` library helpers the `filesystem` extension uses. A path inside `~/.ssh/`,
  `~/.aws/`, `.git/hooks/`, or outside `write.allow.paths` hits the same dialog (or the same non-UI
  `PI_FILESYSTEM_DEFAULT=deny` fallback) that a `write` / `edit` to that path would. `apply_patch` carries its OWN
  session allowlist (not shared with `filesystem`'s) — approving the same path under one tool does not auto-vouch it for
  the other. This is a deliberate v1 limitation; if it bites in practice we'll hoist the allowlist into a shared bus.
- **[`edit-recovery.ts`](./edit-recovery.md) — does NOT engage.** `edit-recovery` hooks `tool_result` on the `edit` tool
  specifically; it sees nothing on `apply_patch`. Hunk-locate failures are formatted by
  [`format-recovery.ts`](../../../lib/node/pi/apply-patch/format-recovery.ts) and returned as a second text part on the
  tool result, mirroring `edit-recovery`'s visual style (line numbers, `>>` markers, N lines of context) so the model
  sees a consistent recovery shape across both tools.
- **[`tool-output-condenser.ts`](./tool-output-condenser.md) — composes downstream.** `apply_patch` returns one or two
  text parts; the condenser (alphabetically later in the dotfiles extension dir) sees the augmented result and applies
  its usual head+tail truncation when the output is long. A multi-block recovery on a large file therefore still fits
  the model's context.

## Atomicity

The pipeline is "validate everything, gate everything, then commit everything", which gives strong but not perfect
atomicity:

- **Strong:** any per-op parse, validate, or locate failure aborts BEFORE any write hits disk. A five-op patch with one
  bad hunk leaves nothing on disk and returns recovery blocks for every failing op (not just the first).
- **Strong:** any filesystem-gate denial aborts BEFORE any write hits disk. The plan is fully staged in memory before
  the gate runs.
- **Best-effort:** commit-phase I/O errors (disk full, EACCES on a write target, concurrent unlink racing the
  move-source removal) surface as `isError: true`, but earlier writes in the same patch have already landed. This
  matches `write` / `edit`'s behaviour — pi has no transactional FS — and is the trade-off for sticking to the host
  `atomic-write.ts` primitive.

## Recovery output

On any per-op failure the tool returns `isError: true` with two text parts:

1. A summary header: `apply_patch: N op error(s):` followed by one bulleted line per failing op (`op[i]: <message>`).
2. The concatenated recovery blocks, one per failing hunk: heading `apply-patch op[i] (Update File: <path>), hunk[j]`,
   then a per-candidate snippet (line range, `>>` marker, ±2 lines of context). Identical visual style to
   [`edit-recovery.ts`](./edit-recovery.md) so the model doesn't have to learn two formats.

A `*** Add File:` over an existing path, `*** Delete File:` on a missing file, or `*** Move File:` whose target already
exists is reported as a single op error without a recovery block (these aren't hunk-locate failures — the fix is to pick
a different op).

## Environment variables

- `PI_APPLY_PATCH_DISABLED=1` — skip the extension entirely.
- `PI_APPLY_PATCH_MAX_BYTES=<n>` — per-file size cap when reading existing content (default `1048576` = 1 MB). Files
  over the cap throw, surfaced as an `isError: true` result; raise the cap or split the patch.
- `PI_APPLY_PATCH_DEBUG=1` — `ctx.ui.notify` each gate / commit decision.
- `PI_APPLY_PATCH_TRACE=<path>` — append one line per decision to `<path>`. Works in `-p` / RPC mode where notifications
  go nowhere.
- `PI_FILESYSTEM_DEFAULT=allow` — shared with `filesystem.ts`. In non-UI mode (subagents, RPC) the gate falls through to
  `allow` instead of blocking. Use sparingly.

## Limitations

- **Text only.** `*** Add File:` body is a sequence of `+`-prefixed lines; there's no binary / base64 path. Codex
  sidesteps this too; binary-file support stays a follow-up if you need it.
- **No git-diff conversion.** Codex's format is its own thing; `apply_patch` does NOT parse `diff --git` /
  `@@ -1,3 +1,4 @@` headers. Hand-write the Codex shape (or generate it from the `apply-patch-format` skill).
- **No streaming.** The full patch is parsed in memory before any I/O. Multi-megabyte patches are not a target use case
  — split them.

## Hot reload

Edit [`extensions/apply-patch.ts`](./apply-patch.ts) or the pure helpers under
[`lib/node/pi/apply-patch/`](../../../lib/node/pi/apply-patch) and run `/reload` in an interactive pi session to pick up
changes without restarting.
