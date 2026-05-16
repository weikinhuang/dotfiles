---
name: error-before-guess
description:
  'WHAT: When a command fails, quote the literal error line from its stderr/stdout before proposing a fix, and re-read
  the exact source (file + line, env var, config key) the error points at. WHEN: Any non-zero exit from a build, test,
  lint, install, or runtime command. DO-NOT: Skip straight to "let me try X"; do not silently retry the same command; do
  not guess at the cause when the error names the file, symbol, or value that is wrong.'
---

# Error Before Guess

When a command fails, the error message almost always names the file, line, symbol, or value that is wrong. Read it
before touching anything. The fix starts with the error text, not with a hunch.

## The contract

After any non-zero exit:

1. **Echo the error verbatim in your reply.** Paste the literal failing line - including file path, line/column numbers,
   and any error codes (e.g. `SC2086`, `TS2322`, `E9999`). Not a paraphrase, not a summary: copy the bytes. If your
   reply contains only a description like "an unquoted variable" or "a type error" without the raw error line, you
   failed the skill. The error text is the evidence; the paraphrase is a commentary on it.
2. **Parse it.** From the quoted text, identify the file path, line number, symbol, type name, env var, or config key it
   points at.
3. **Open it.** Read the referenced location in the source before proposing a fix. If the error points at a file+line,
   open that file at that line.
4. **Then fix.** Your proposed fix must explicitly connect to the quoted error: "The error `<verbatim line>` at
   `file:line` means Y; the fix is Z."

## When this applies

- A build / compile / type-check fails.
- A test case fails.
- A lint / format check fails.
- A runtime command exits non-zero.
- A package install / dependency resolution fails.
- A script's `set -e` kicks in mid-execution.

Skip this skill when:

- The failure is expected and the user already told you to ignore it.
- The error text is literally absent (e.g. a silent `exit 1` with no output - in which case rerun with `-v` / `--debug`
  / `set -x` to surface one).

## Common error shapes and where to look

| Error shape                                         | Where to look                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `file.ts:42:10: error TS2322: ...`                  | Open `file.ts` at line 42, col 10.                                    |
| `ModuleNotFoundError: No module named 'foo'`        | Check the package is installed; check the Python/Node path.           |
| `command not found: foo`                            | Check `$PATH`; check the install step ran; check shell restart.       |
| `Permission denied (publickey)`                     | SSH agent / key / `~/.ssh/config` - NOT the code.                     |
| `EACCES: permission denied, open '/path'`           | Filesystem permission on `/path`, not the program.                    |
| `jq: error (at <stdin>:1): ...`                     | The input JSON, not the jq expression (usually).                      |
| `bash: line N: X: unbound variable` (with `set -u`) | Variable `X` at line N of the script.                                 |
| `assertion failed: expected X, got Y`               | The assertion site - the gap between expected and actual IS the clue. |
| Stack trace                                         | Bottom-of-stack frame that is still YOUR code, not library code.      |

## Anti-patterns

- **"Let me try something" without reading the error.** That's guessing. Quote first.
- **Retrying the same command.** If nothing changed, the result won't. Read the error, change one thing, rerun.
- **Paraphrasing the error in the reply.** Paraphrase loses the exact symbol / path the user needs to see. Quote
  verbatim, then paraphrase if needed.
- **Fixing the wrong layer.** `Permission denied` on a file is not a bug in your function; don't rewrite the function.
- **Treating a long stack trace as opaque.** Scroll to the first frame that is your code, not framework code. That's the
  line to open.
- **Swallowing the error with a retry loop or `|| true` to "move on".** You'll debug the same thing later with less
  context.

## Worked example

Bad:

> The test failed. Let me try restructuring the function.

Good:

> The test failed with:
>
> ```text
> AssertionError: expected 3, got 5
>   at tests/math.spec.ts:17:12
> ```
>
> Opening `tests/math.spec.ts:17`: the assertion is `expect(sum([1,2])).toBe(3)`. The function returned 5, which
> suggests `sum` is concatenating strings rather than adding numbers. Reading `src/math.ts:sum` now to confirm.

The good version: quoted the error, named the file+line, stated the hypothesis that connects them, and announced the
next concrete read before editing.
