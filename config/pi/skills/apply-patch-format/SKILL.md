---
name: apply-patch-format
description:
  'WHAT: WHEN to reach for the `apply_patch` tool over `edit` / `write`, plus the strict Codex patch shape (`*** Begin
  Patch` / `*** Add File` / `*** Update File` / `*** Delete File` / `*** Move File`, `@@` hunks with ` ` / `-` / `+`
  line prefixes) the parser accepts. WHEN: User asks for a multi-file refactor, a rename + edit combo, a large diff
  against one file, or any task an opus-class model is driving where the model would otherwise stack many `edit` calls
  in a row. DO-NOT: Use `apply_patch` for single-line targeted edits (`edit` is shorter and feedback is tighter); use it
  for binary content (the format is text-only); hand-write the format from memory (the markers and hunk prefixes are
  strict and the parser will reject a paraphrase); skip context lines (each `@@` hunk needs unique surrounding context
  so the locator finds the right region).'
---

# Apply-Patch Format

The `apply_patch` extension registers a single `apply_patch` tool that takes one big Codex-format patch string and
applies it atomically. This skill teaches WHEN to reach for it and HOW to shape the patch so the strict parser accepts
it on the first try.

Reference: [`config/pi/extensions/apply-patch.md`](../../extensions/apply-patch.md) is the full spec (format, gate
composition, env vars, limitations). Read it once before authoring a non-trivial patch.

## Decision: `apply_patch` vs `edit` vs `write`

| You're about to…                                                        | Use                              |
| ----------------------------------------------------------------------- | -------------------------------- |
| Tweak one line in one file                                              | `edit`                           |
| Replace the entire contents of one file (or write a new file)           | `write`                          |
| Make changes across two or more files in a single coherent step         | **`apply_patch`**                |
| Rename a file (`Move File`), with or without an in-flight edit          | **`apply_patch`**                |
| Make a large diff against one file (many hunks, > ~10 lines changed)    | **`apply_patch`**                |
| You're an opus-class model and the task is "refactor X across the repo" | **`apply_patch`**                |
| You're a small / fast model paraphrasing whitespace                     | `edit` (lean on `edit-recovery`) |

Reach for `apply_patch` when **any** of these hold:

- The change spans more than one file and you want all-or-nothing atomicity.
- The change is large enough that emitting it as a sequence of `edit` calls would burn many turns.
- You need a rename (`Move File`) — `edit` cannot rename and a `Delete File` + `Add File` pair is not the same thing
  (the plan explicitly forbids it).
- An opus-class model is driving and the change is non-trivial.

Stay with `edit` when:

- The change is a one-liner.
- You're a small or fast model. `edit` + [`edit-recovery`](../../extensions/edit-recovery.md) tolerates whitespace
  paraphrase; `apply_patch`'s parser is strict.
- You don't have the file content in front of you and would have to invent context lines. Re-`read` first.

## Patch shape (the parser is strict)

The format is Codex's own — not unified-diff. Markers must match exactly modulo trailing whitespace.

```text
*** Begin Patch
<one or more ops>
*** End Patch
```

### Op headers

| Header                          | Body                               | Effect                              |
| ------------------------------- | ---------------------------------- | ----------------------------------- |
| `*** Add File: <path>`          | `+`-prefixed lines                 | Create file. Refuses to overwrite.  |
| `*** Update File: <path>`       | One or more `@@` hunks             | In-place edit.                      |
| `*** Delete File: <path>`       | (empty)                            | Remove file.                        |
| `*** Move File: <from> -> <to>` | Optional `@@` hunks against `from` | Rename + (optional) edit in one op. |

Inside an `@@` hunk, every line begins with one of:

- A single space ` ` — unchanged context line. Required at least once above and once below each change.
- A minus `-` — line to remove from the file.
- A plus `+` — line to add to the file.

A wholly-empty line inside a hunk is treated as a blank context line (the leading space is easy to lose). Anything else
inside a hunk is a parse error.

### Worked example — multi-file, mixed ops

```text
*** Begin Patch
*** Add File: src/lib.ts
+export const VERSION = '1.0.0';
+
*** Update File: src/index.ts
@@
 import { foo } from './foo';
+import { VERSION } from './lib';
@@
 export function main(): void {
-  console.log('start');
+  console.log(`start v${VERSION}`);
 }
*** Move File: src/util.ts -> src/helpers.ts
@@
 export function noop(): void {}
+
+export function identity<T>(value: T): T {
+  return value;
+}
*** Delete File: src/obsolete.ts
*** End Patch
```

## Author the hunks so the locator hits

The hunk locator (mirrored from [`edit-recovery`](../../extensions/edit-recovery.md)'s fuzzy pass) runs exact-match
first, then whitespace-insensitive. Two things make the hit reliable:

1. **Unique context.** Include 2-3 lines above and below the change. If the surrounding lines aren't unique in the file,
   add another anchor line. The locator refuses to guess when matches are ambiguous and returns a recovery block listing
   every candidate.
2. **Verbatim context.** Copy context lines from the actual file content, not a paraphrase. Tabs vs spaces, trailing
   whitespace, smart vs straight quotes — the fuzzy pass handles these, but the more the model deviates, the more likely
   the wrong region matches.

If you don't have the file content in front of you, `read` (or `grep -n`) the target region first. Inventing context
from memory is the #1 source of locator failures.

## On a hunk-locate failure

`apply_patch` returns `isError: true` with two text parts:

1. A summary listing each failing op: `apply_patch: 2 op error(s):` followed by `op[i]: …`.
2. The concatenated recovery blocks, one per failing hunk, each showing the line range and ±2 lines of context around
   every candidate the locator found (or `Near line N:` snippets when no candidate hit).

The recovery block looks just like `edit-recovery`'s output, so you can apply the same fix recipe: copy the context
lines from the snippet verbatim into a fresh hunk and retry. DO NOT re-emit the same patch — the parser will reject the
same bytes a second time.

## Anti-patterns

- **Hand-writing the format from training data.** The markers (`*** Begin Patch`, `*** Update File`, `@@`) are exact
  strings. A paraphrase (`** Begin Patch`, `*** UpdateFile:`, `@`) will hit the parse-error path with a line number.
- **Using `apply_patch` for a single-line edit.** `edit` is shorter, gives tighter feedback, and the recovery story
  (`edit-recovery`) is just as good for one-liners.
- **Using `Delete File` + `Add File` to rename.** The plan explicitly mandates `Move File` for rename + edit combos so
  the gate sees one op, not two; `Delete` + `Add` will also fail the plan-conflict check if the paths overlap.
- **Skipping context lines.** A hunk with zero ` ` (space-prefixed) context is rejected; one with too little context to
  be unique will hit the `ambiguous` locator path.
- **Patching binary files.** `Add File` body is text only (`+`-prefixed lines). For binary or large blobs use a separate
  workflow — base64-encoded blobs are not supported.
- **Mixing `apply_patch` with concurrent `edit` calls in the same turn.** The plan stages against the on-disk snapshot
  at execute time; an `edit` between read and commit invalidates the snapshot. Pick one tool per change set.

## Quick reference

| You want to…                                    | Op shape                                                      |
| ----------------------------------------------- | ------------------------------------------------------------- |
| Create a new file                               | `*** Add File: <path>` + `+`-prefixed lines                   |
| Edit one file in N places                       | `*** Update File: <path>` + multiple `@@` hunks               |
| Rename a file                                   | `*** Move File: <from> -> <to>` (no hunks needed)             |
| Rename + edit in one shot                       | `*** Move File: <from> -> <to>` + `@@` hunks against `<from>` |
| Delete a file                                   | `*** Delete File: <path>` (empty body)                        |
| Multi-file change with all-or-nothing atomicity | Multiple ops between one `*** Begin Patch` / `*** End Patch`  |
