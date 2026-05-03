---
name: grep-before-read
description:
  Default to `rg`/`grep` for discovery instead of reading whole files. Use whenever you're hunting for a symbol,
  function, pattern, or a specific line in a repo you don't already have fully loaded in context — especially on files
  over ~400 lines, unknown codebases, or when the user asks "where is X defined/used?". Read only after you know the
  target lines; use `offset`/`limit` to pull just the region you need.
---

# Grep Before Read

Reading a whole file to find one function is the small-model version of `cat | grep`. `rg -n` goes straight to the lines
that matter, returns five orders of magnitude less text, and costs almost no context. Make it your default discovery
move. `read` is for when you already know which region to look at.

## When to grep first

Trigger `rg -n` (preferred) or `grep -rn` as the FIRST move when any of these is true:

- You're looking for a **symbol**: function name, class, const, type, CLI flag, env var.
- The user asks **"where"**, **"who uses"**, **"all callers of"**, **"find the bug in"**.
- You're in an **unfamiliar repo** and don't know the file layout yet.
- The file is **over ~400 lines** (the pi `read-without-limit-nudge` will call this out anyway).
- You're doing a **repo-wide refactor** (rename, migration, API change).

Skip grep and `read` directly only when:

- The file was handed to you by path AND is short (≤ ~300 lines).
- You've already grepped once and know the exact line range you want.
- You're reading a well-known config you can't easily grep (`.env`, `tsconfig.json`, `package.json`).

## Recipes

Pick the first one that describes your goal. They're ordered by how often they solve the problem.

### 1. Find where a symbol is defined

```bash
# Function / class / const definition (ripgrep respects .gitignore).
rg -n "^(export\s+)?(function|class|const|interface|type)\s+MySymbol\b"

# Fallback if rg isn't available.
grep -rn -E "^(export\s+)?(function|class|const|interface|type)\s+MySymbol\b" .
```

Why: anchoring at the line start skips every import and call site, leaving only declarations.

### 2. Find all call sites / references

```bash
# Every mention, with 2 lines of context.
rg -nC 2 "MySymbol"

# Restrict to a language / path.
rg -n --type ts "MySymbol"
rg -n -g 'src/**/*.ts' "MySymbol"
```

Then `read path --offset <line> --limit 40` on the most promising hits.

### 3. Search only changed / untracked files

```bash
# Things you're currently working on.
git diff --name-only | xargs rg -n "MySymbol"

# Same but including untracked.
git ls-files --modified --others --exclude-standard | xargs rg -n "MySymbol"
```

### 4. Exclude noise (build output, vendored code, tests)

```bash
rg -n "MySymbol" \
  -g '!dist/**' -g '!node_modules/**' -g '!external/**' -g '!*.min.*'

# Only tests:
rg -n "MySymbol" -g '**/*.spec.*' -g '**/*.test.*'
```

### 5. Find a specific text phrase (error message, TODO, FIXME)

```bash
rg -n "Cannot read properties of undefined"
rg -n "TODO|FIXME|XXX"
```

Fixed strings (no regex) are faster and avoid surprises with `.` or `[`:

```bash
rg -Fn "some.literal.string[with](chars)"
```

### 6. Count occurrences before deciding to `read`

```bash
rg -c "MySymbol"            # per-file counts
rg -c "MySymbol" | sort -t: -k2 -n -r | head
```

A file with 40 hits is probably where `MySymbol` lives; a file with 1 is probably an import.

### 7. List files that match / don't match

```bash
rg -l "MySymbol"            # files that contain
rg --files-without-match "MySymbol"  # the inverse
```

## Before / after

**Before (small-model pattern):**

1. `read src/api/search.ts` → 1,842 lines, ~22k tokens of output.
2. `read src/api/validation.ts` → 900 lines, ~11k tokens.
3. `read src/lib/ratelimit.ts` → 600 lines, ~7k tokens.
4. "I found the handler at line 412 of search.ts."

Total spend: ~40k tokens to answer one "where is X" question.

**After:**

1. `rg -n "searchHandler" -g '!dist/**'` → 6 hits, ~200 tokens.
2. `read src/api/search.ts --offset 405 --limit 40` → ~600 tokens.
3. "`searchHandler` is defined at search.ts:412, called from 3 places."

Total spend: ~800 tokens. Same answer.

## After you find the target

Once `rg` points you at a specific file and line range:

1. `read <path> --offset <line> --limit <small_window>` — pull only the region you need.
2. Record the location in `scratchpad` ("`searchHandler` @ src/api/search.ts:412") so you don't re-grep next turn.
3. Only widen the `limit` or drop it entirely if the first window was obviously too small.

## Anti-patterns

- **Don't `read` a file over 400 lines without `offset`/`limit`.** The `read-without-limit-nudge` extension will point
  this out anyway; pre-empt it.
- **Don't grep the same pattern twice in a turn.** If the first `rg` result was useful, note it in `scratchpad`; if it
  was useless, adjust the pattern (add anchors, restrict paths, escape metacharacters) — don't rerun unchanged.
- **Don't `rg | head`-pattern in pi.** `rg` already caps its own output, and piping can mask errors. If the result set
  is huge, tighten the regex or add `-g` globs.
- **Don't reach for `find -name X | xargs grep`.** `rg` already walks the tree respecting `.gitignore`, and
  `rg -g 'glob'` handles the name filter in one process.

## Quick reference

| Goal                | Command                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| Symbol definition   | `rg -n "^(export\s+)?(function\|class\|const\|interface\|type)\s+NAME\b"` |
| All references      | `rg -nC 2 "NAME"`                                                         |
| Restrict by type    | `rg -n --type ts "NAME"`                                                  |
| Restrict by path    | `rg -n -g 'src/**/*.ts' "NAME"`                                           |
| Exclude paths       | `rg -n "NAME" -g '!dist/**' -g '!node_modules/**'`                        |
| Fixed string        | `rg -Fn "literal.string"`                                                 |
| Files containing    | `rg -l "NAME"`                                                            |
| Per-file counts     | `rg -c "NAME"`                                                            |
| Only modified files | `git diff --name-only \| xargs rg -n "NAME"`                              |
