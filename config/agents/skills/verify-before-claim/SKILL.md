---
name: verify-before-claim
description:
  'WHAT: Before telling the user a code change is done, actually run a verification command (tests, lint, a smoke
  invocation) and paste the pass output into the reply. WHEN: Any multi-file edit, new script, rename, bug fix, or
  refactor where the user expects working code at the end. DO-NOT: Claim "done" / "should work" / "ready" without a
  fresh pass output this turn; do not substitute "I reviewed the diff" for actually running the verifier.'
---

# Verify Before Claim

Never say a code change is "done", "ready", or "should work" without running a verification command in the same turn and
quoting the pass output in the reply. Reading the diff is not verification. Compiling in your head is not verification.
The verifier is.

## When this applies

Use this skill any time all of these are true:

- You edited code, config, or tests.
- The edit is meant to leave the project in a working state.
- A verification command exists for the change: test suite, linter, type-checker, smoke invocation, `--help`,
  `--dry-run`, or a short script that exercises the new behavior.

Skip it when:

- The user explicitly asked for a draft, sketch, or commentary — not a finished change.
- The change has no executable surface (pure documentation, a README edit, a comment-only diff).
- A separate iteration loop (e.g. a declared `check` task) already owns the verification — the loop's pass verdict is
  sufficient.

## How to pick the verification command

Pick the narrowest command that can reject the change.

| Change shape                            | Verification command                                               |
| --------------------------------------- | ------------------------------------------------------------------ |
| New or edited function with a unit test | Run the single test (e.g. `npm test -- <file>`, `bats <file>`).    |
| Edit to a shell script                  | `shellcheck <path>` + a smoke invocation with representative args. |
| Config / JSON / YAML edit               | The tool's validator: `jq -e .`, `yamllint`, `tsc --noEmit`.       |
| Refactor touching multiple files        | The full project test/lint command.                                |
| New CLI flag                            | Run the CLI with the flag and paste the output.                    |
| Bug fix with a reproducer               | Run the reproducer before (optional) and after; both pastes help.  |

If no verifier exists yet, either (a) write one as part of the change, or (b) downgrade the claim: say "written but
unverified — please run X to confirm" instead of "done".

## The contract

1. Make the edit.
2. Run the verification command in the same turn as the claim.
3. Quote the relevant pass output (exit 0, "OK", "42 passed", etc.) in the reply — not as a screenshot of your plan, but
   as the literal tail of the command output.
4. Only then say "done" / "ready" / equivalent.

## Claim phrases that trigger this skill

If you find yourself about to write any of these, you owe the reader a verifier run first:

- "should work now"
- "this is done"
- "ready to commit"
- "all tests should pass"
- "the fix is in place"
- "you can merge this"

Without a fresh pass output, rewrite as: "edit is written; run `<command>` to confirm before merging."

## Anti-patterns

- **Claiming on "the diff looks right".** The diff looking right is a necessary precondition, not the check itself.
- **Running the verifier and forgetting to quote it.** If the user can't see the pass output, they'll rerun it anyway —
  paste the last few lines.
- **Running a broader verifier when a narrow one exists.** A single-file test run that passes is a stronger signal than
  a big suite whose tail got truncated.
- **Running the verifier in a separate background job and claiming done before it finishes.** If you used a background
  runner, wait for exit and quote the result before the claim.
- **Claiming a negative result ("the test now fails correctly") without showing the failure text.** Same rule —
  reproduce it in-turn.
