---
name: minimal-diff
description:
  'WHAT: Keep edits narrow — change only the lines the task requires, preserve surrounding formatting, and never rewrite
  a file when a targeted edit suffices. WHEN: Any modification to an existing file. DO-NOT: Reformat unrelated regions,
  reorder imports or keys for tidiness, normalize whitespace outside the edit, or rewrite a file with a whole-file write
  when a small replacement would do.'
---

# Minimal Diff

When editing an existing file, change only what the task requires. Surrounding code, formatting, import order, and
whitespace stay exactly as they were. A good patch reads like a sniper shot, not a renovation.

## The rule

If a line isn't part of the requested change, it doesn't move, doesn't reformat, and doesn't get "cleaned up".

This applies to:

- Whitespace and indentation outside the edit.
- Import order, key order in objects / dicts, and field order in structs.
- Trailing newlines, blank-line counts between functions.
- Quoting style (single vs double quotes), comment style, hoisted vs inline declarations.
- "While I'm here" unrelated refactors.

## When this applies

Any modification to an existing file. Especially important when:

- The file is under version control and the diff will be reviewed.
- The repo has an auto-formatter — formatter churn should be its own commit, never mixed with a logic change.
- You're fixing a bug or adding a small feature in a large file.

Skip this skill when the user explicitly asks for one of:

- "Rewrite this file", "reformat this file", "reorganize these imports".
- A dedicated refactor/tidy pass that is itself the task.

## How to apply

1. Identify the smallest region that must change. Prefer a targeted replacement (diff-style edit) over a whole-file
   rewrite.
2. Preserve the exact indentation style (spaces vs tabs, width), quoting style, and trailing punctuation (trailing
   commas, semicolons) used by surrounding code in the file.
3. If your tooling would auto-format on save and that would touch lines outside the edit, either disable format-on-save
   for this file or manually undo the unrelated hunks before committing.
4. Before finalizing, diff the file against the pre-edit state and confirm every hunk is justified by the task.

## Decision prompts

Ask yourself before finalizing:

- "Does this hunk exist because the task required it?" If no, revert the hunk.
- "Did I reorder imports or keys?" If yes, was the reorder requested? Revert if not.
- "Did I change quoting, trailing commas, or spacing outside the edit region?" Revert.
- "Did I use a whole-file write when a 3-line replacement would work?" Switch to the targeted edit.

## Anti-patterns

- **"While I'm here" renames.** Rename in a separate commit with a clear message.
- **Re-alphabetizing imports / keys for tidiness.** If the file's existing order is inconsistent, leave it — a dedicated
  sort commit is the right place for that.
- **Running a formatter mid-edit and committing the combined diff.** The formatter's hunks and your logic hunks should
  never share a commit.
- **Whole-file rewrite as the default.** Even for a 10-line file, a targeted replacement makes the intent obvious.
- **Converting quoting style, tab/space, or line endings opportunistically.** These changes are invisible in casual
  review and bloat the diff.
- **Leaving trailing whitespace or blank-line changes from an editor.** Strip those before committing.

## Quick self-check

Before declaring the edit finished, run a diff preview (e.g. `git diff <path>`) and count the hunks. If the number of
hunks is larger than the number of distinct changes the task required, you have non-minimal diff to revert.
