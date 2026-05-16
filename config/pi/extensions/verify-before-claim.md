# `verify-before-claim.ts`

Generalization of the todo completion-claim guardrail. Catches the very common failure mode where weaker models (and
some stronger ones in a hurry) sign off with a _verification_ claim — “tests pass”, “lint is clean”, “it builds”, “tsc
is happy” — without actually having run the check in the current turn.

Composes cleanly with the other `agent_end` extensions:

|                             | Signal                                                                          |
| --------------------------- | ------------------------------------------------------------------------------- |
| `todo` guardrail fires when | Assistant signs off as “done” with open todos still around.                     |
| `stall-recovery` fires when | Turn produced no text and no tool calls, or the turn has an explicit error.     |
| `verify-before-claim` fires | Assistant claimed a check passes AND no matching bash invocation ran this turn. |

All three use distinct sentinel markers and an idempotency check on the latest user message, so they never re-trigger on
their own nudges. They **can** fire together on the same turn; each reaches the model separately.

## Detection

On `agent_end`, [`lib/node/pi/verify-detect.ts`](../../../lib/node/pi/verify-detect.ts):

1. Pulls the last assistant text and scans the **tail** (~600 chars) for typed claim phrases via `extractClaims`. Claim
   kinds: `tests-pass`, `lint-clean`, `types-check`, `build-clean`, `format-clean`, `ci-green`. Questions and
   conditionals (“if the tests pass…”, “hopefully the build is clean”) are rejected outright.

2. Walks the branch backward to the most recent user message, collecting every bash command that ran in between —
   assistant `toolCall` parts whose name is `bash` or `bg_bash` (the latter from [`./bg-bash.ts`](./bg-bash.md) — only
   the `start` action carries a `command` arg, the others fall through), `toolResult` entries with the same `toolName`
   filter, and `bashExecution` messages (user-invoked `!cmd`).

3. Partitions claims into `(verified, unverified)` using liberal per-kind command patterns: e.g. `tests-pass` matches
   `jest`, `vitest`, `mocha`, `pytest`, `cargo test`, `cargo nextest run`, `go test`, `bats`, `node --test`, `npm test`,
   `pnpm run test`, `./dev/test-docker.sh`, etc. `lint-clean` matches `eslint`, `shellcheck`, `ruff`, `rubocop`,
   `cargo clippy`, `golangci-lint`, `./dev/lint.sh`, and more. Matching is deliberately liberal — false positives merely
   suppress a nudge, false negatives merely produce one extra nudge.

4. If `unverified.length > 0` AND the most recent user message doesn’t already carry the `⚠ [pi-verify-before-claim]`
   sentinel, injects a follow-up user message via `pi.sendUserMessage(..., { deliverAs: 'followUp' })`:

   > You claimed “all tests pass” (tests pass), but I don’t see a tool call that would have verified it in this turn.
   > Either run the check and report the real outcome, or retract the claim and tell the user what you actually did.

## Command-match anchoring

Patterns require a command-start anchor (`^` / whitespace / `&|;(`) AND a command-end lookahead (whitespace / end of
string / `&|;)<>`). The end anchor explicitly excludes `.` so `cat jest.config.js` does **not** match `jest` and
`eslint.config.mjs` does **not** match `eslint`. Both are common false-positive vectors the unit tests pin down.

## Pre-commit hook auto-detection

In most modern JS/TS repos, a successful `git commit` runs `eslint` / `oxfmt` / `prettier` / `markdownlint` / etc. via
Husky + lint-staged. Without help, this extension can't see those runs — it only sees the outer `git commit` command —
and nags on any "lint is clean" / "formatting is clean" sign-off that followed the commit.

[`lib/node/pi/verify-hook-detect.ts`](../../../lib/node/pi/verify-hook-detect.ts) closes that gap. At `session_start`
the detector inspects the project for pre-commit hook configurations and synthesizes a `commandSatisfies` rule crediting
`git commit` with whatever claim kinds the detected tools satisfy.

Files it consults (all optional, missing-file is silent):

| File                                            | Handling       | Purpose                                                                            |
| ----------------------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `.husky/pre-commit`                             | text scan      | Husky v7+ shell script; catches direct tool invocations.                           |
| `lint-staged.config.{mjs,cjs,js,ts}`            | text scan      | JS / TS configs — never evaluated, only searched.                                  |
| `.lintstagedrc{.mjs,.cjs,.js}`                  | text scan      | Dotfile JS variants.                                                               |
| `.lintstagedrc`, `.lintstagedrc.json`, `.jsonc` | parsed (JSONC) | JSON shapes — walked per-glob, each command string fed back through the text scan. |
| `package.json` → `lint-staged`                  | parsed         | Inline lint-staged config.                                                         |
| `package.json` → `husky.hooks['pre-commit']`    | parsed         | Husky v4 legacy shape.                                                             |

**Not** supported in this MVP: `.pre-commit-config.yaml` (pre-commit.com framework) — the repo has no YAML parser today.
Users of that framework can still add explicit `commandSatisfies` rules via `verify-before-claim.json` as a fallback.

The synthesized rule's regex is:

```regex
/^git\s+commit\b(?!.*(?:--no-verify|\s-n\b))/
```

which matches plain `git commit`, `git commit -am`, `git commit --amend` — but **not** `git commit --no-verify` / `-n`
which skip the hook and therefore skip the verification the rule is crediting.

The detector is liberal: finding a tool token anywhere in the config counts. False positives merely suppress a
legitimate nudge, false negatives produce a noisy retry — same asymmetry as the bash-command matcher.

Explicit config in `verify-before-claim.json` still stacks on top; the two lists are concatenated at load time so a
per-project override can credit tools the detector doesn't know about (custom CI wrappers, shell scripts that run things
behind a `case` statement).

## Per-project / per-user explicit overrides

JSONC, all optional, at `~/.pi/agent/verify-before-claim.json` and `<cwd>/.pi/verify-before-claim.json`:

```jsonc
{
  "commandSatisfies": [
    { "pattern": "^\\./dev/lint\\.sh\\b", "kinds": ["lint-clean", "format-clean"] },
    { "pattern": "^make\\s+check\\b", "kinds": ["tests-pass", "lint-clean", "types-check"] },
  ],
}
```

Rules augment (don't replace) both the built-in command matchers AND the hook auto-detector. Order within the merged
list doesn't matter — `verifyingCommandMatches` short-circuits on the first match regardless.

## Environment variables

- `PI_VERIFY_DISABLED=1` — skip the extension entirely.
- `PI_VERIFY_VERBOSE=1` — emit a `ctx.ui.notify` on every detection / decision. Useful for tuning the claim regexes
  against a noisy local model.
- `PI_VERIFY_TRACE=<path>` — append one line per `agent_end` decision AND one line per `session_start` config load
  (including auto-detected tool list) to `<path>`. Useful in `-p` / RPC modes where `ctx.ui.notify` is silent.

## Hot reload

Edit [`extensions/verify-before-claim.ts`](./verify-before-claim.ts),
[`lib/node/pi/verify-detect.ts`](../../../lib/node/pi/verify-detect.ts), or
[`lib/node/pi/verify-hook-detect.ts`](../../../lib/node/pi/verify-hook-detect.ts) and run `/reload` in an interactive pi
session. The hook-detect sweep re-runs at the next `session_start` — note that `/reload` does NOT trigger
`session_start`, so to pick up changes in a running session you'd need to restart it (same as the rest of the extension
state that's loaded at session_start).
