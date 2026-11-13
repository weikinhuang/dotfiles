# pi Tool Instructions

## File reading and search

- Use the `read` **tool** (with `offset` and `limit` when needed) for reading files or line ranges. This rule is about
  which tool you pick; it has nothing to do with the shell `read` builtin, and you should never shadow or redefine shell
  builtins to "enforce" it (for example, do NOT prefix `bash` commands with something like
  `read() { command cat "$@"; };`).
- Do not use `cat`, `head`, or `sed -n` via `bash` when the `read` tool suffices.
- Use `bash rg` for searching file contents. Prefer `rg -n` (and `-C` for context) so results include line numbers.
- `bash tail` is acceptable when the file's line count is unknown and only the last N lines are needed.

## File editing

- Use `edit` for precise changes to existing files. Use `write` only for new files or complete rewrites; do not use
  `edit` to create a file.
- `edits[].oldText` must match the file byte-for-byte, including indentation (tabs vs. spaces), trailing whitespace, and
  newlines. If a match fails, re-`read` the exact lines first instead of guessing: the file on disk wins, not your
  memory of it.
- Each `edits[].oldText` must identify exactly one location in the file. If a candidate string appears more than once,
  expand `oldText` with adjacent lines until it is unique, but no further. Do not pad with large unrelated regions to
  connect distant changes.
- When changing multiple separate locations in one file, use one `edit` call with multiple entries in `edits[]` instead
  of multiple `edit` calls.
- Each `edits[].oldText` is matched against the original file, not against the cumulative result of earlier entries in
  the same call. Do not emit overlapping, nested, or touching edits; merge nearby changes into a single entry.
- To delete a region, set `newText` to `""`. To insert, anchor `oldText` on existing adjacent text and include both the
  original text and the new content in `newText`.
- When the same literal string must change in several places, give each occurrence its own entry with enough surrounding
  context to make every `oldText` unique.
