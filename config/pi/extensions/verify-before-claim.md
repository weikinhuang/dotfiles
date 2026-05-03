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
   assistant `toolCall` parts with `name === 'bash'`, `toolResult` entries with `toolName === 'bash'`, and
   `bashExecution` messages (user-invoked `!cmd`).

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

## Environment variables

- `PI_VERIFY_DISABLED=1` — skip the extension entirely.
- `PI_VERIFY_VERBOSE=1` — emit a `ctx.ui.notify` on every detection / decision. Useful for tuning the claim regexes
  against a noisy local model.

## Hot reload

Edit [`extensions/verify-before-claim.ts`](./verify-before-claim.ts) or
[`lib/node/pi/verify-detect.ts`](../../../lib/node/pi/verify-detect.ts) and run `/reload` in an interactive pi session.
