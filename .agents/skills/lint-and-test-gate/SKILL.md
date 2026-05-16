---
name: lint-and-test-gate
description:
  'WHAT: After editing shell / bats / TypeScript in this repo, run the matching gate command (`./dev/lint.sh`,
  `./dev/test-docker.sh`, or `npm test`) before claiming the change is done, and quote the pass output. WHEN: Any
  finished edit in dotenv/, plugins/, tests/, config/, or lib/node/. DO-NOT: Run the local `./dev/test.sh` when
  `./dev/test-docker.sh` is available; skip the gate because "it''s a small change"; claim done without quoting the pass
  tail.'
---

# Lint and Test Gate

Every change to shell, bats, or TypeScript in this repo has a specific gate command. Run it, quote the last few lines of
pass output, then claim the change is done. This is the repo-specific instance of the harness-agnostic
`verify-before-claim` skill.

## The gate table

Match what you touched to the command you run:

| Touched                                               | Gate command                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Any `.sh` file (dotenv, plugins, config, bin scripts) | `./dev/lint.sh`                                                              |
| Any `.bats` file (added or edited)                    | `./dev/test-docker.sh tests/<changed-path>.bats` then `./dev/test-docker.sh` |
| Any `lib/node/**/*.ts` or `lib/node/**/*.spec.ts`     | `npm test`                                                                   |
| Anything that changed shell AND added/changed a test  | Run both gates above.                                                        |
| A public-surface doc change (REFERENCE.md, README.md) | No gate - but confirm the change is consistent with the code.                |

Always prefer a focused run first (single file / single path), then a full-suite run to catch ordering breakage.

## Docker is the default for bats

Run `./dev/test-docker.sh`, not `./dev/test.sh`, unless Docker is unavailable. Docker pins the bats, bats-support, and
bats-assert versions and bypasses host drift. `-q` mutes pass noise, which is useful when you're running the full suite:

```bash
./dev/test-docker.sh -q
./dev/test-docker.sh tests/dotenv/bin/git-sync.bats     # focused
./dev/test-docker.sh tests/plugins/                      # subtree
```

## Quote the pass tail

When the gate passes, copy the last 3-6 lines of output into your reply. For bats that's the summary line
(`<N> tests, 0 failures`); for shellcheck it's silent on success so `./dev/lint.sh` exiting 0 is the signal - say so
explicitly.

Good:

> Ran `./dev/lint.sh` - exited 0 (no shellcheck or shfmt findings).
>
> Ran `./dev/test-docker.sh tests/dotenv/bin/git-sync.bats`:
>
> ```text
> 12 tests, 0 failures
> ```

Bad:

> Tests pass, looks good.

## When you can skip the gate

Only when the change has no executable impact the gate could catch:

- Pure documentation edits (README, REFERENCE, AGENTS.md).
- A skill / agent config file that isn't code.
- The user explicitly said "don't run tests, I'll run them".

If in doubt, run the gate. The cost is small; the cost of claiming done on a broken change is large.

## Lint-staged and pre-commit

If `lint-staged` / git hooks are wired in, they run a subset of gates on commit. That's backup, not a substitute - run
the gate yourself first so you can react to failures without a broken commit in progress.

## Anti-patterns

- **"I only touched one line, no need to test."** Pass the gate anyway; one-line changes have bitten this repo before.
- **Running just the focused test and skipping the suite on a refactor.** Cross-file changes need the full suite to
  catch ordering / isolation bugs.
- **Using `./dev/test.sh` because Docker feels slow.** Docker is the reference environment. If it's slow, run focused
  tests during development and the full suite before claiming done.
- **Claiming pass without quoting the output.** Users shouldn't have to rerun to confirm.
- **Running `npm test` when only shell changed.** Wrong gate - it won't catch shell issues and wastes time.
- **Ignoring shellcheck findings.** They're treated as errors, not warnings, by `./dev/lint.sh`. Fix them.

## Quick reference

| Change                                      | Run this                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| Tiny shell tweak                            | `./dev/lint.sh`                                                           |
| New / edited bats test                      | `./dev/test-docker.sh tests/<path>.bats` then `./dev/test-docker.sh -q`   |
| New bin script (script + completion + test) | `./dev/lint.sh` and `./dev/test-docker.sh tests/dotenv/bin/<script>.bats` |
| New plugin                                  | `./dev/lint.sh` and `./dev/test-docker.sh tests/plugins/<name>.bats`      |
| TypeScript helper in `lib/node/`            | `npm test`                                                                |
| Mixed shell + TS                            | All three: `./dev/lint.sh`, `./dev/test-docker.sh -q`, `npm test`         |
