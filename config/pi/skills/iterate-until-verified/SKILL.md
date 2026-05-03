---
name: iterate-until-verified
description: >-
  Use the `check` tool to run a disciplined feedback loop whenever the task is "produce an artifact and confirm it
  satisfies a verifiable contract" — render an SVG / chart / diagram, generate a config / regex / test / fixture /
  snippet that has to match a spec, write code that has to pass a test suite, produce prose a critic can rubric-judge,
  or "make a Y that does Z". Declare a check up front, let the user accept it, then edit → `check run` → read verdict →
  edit until it passes or the budget is spent. Never claim the artifact is done without a passing verdict from `check
  run` this turn.
---

# Iterate Until Verified

When the job is to produce an artifact (rendered image, SVG, chart, config file, regex, generated code, rubric-graded
prose) and a concrete pass/fail check exists, use the `check` tool to run the loop instead of eyeballing the result. The
extension tracks iterations on disk + in the session branch, enforces budgets, and catches "looks right to me" claims
you didn't actually verify.

You are the **actor**: you edit the artifact. The **check** (a bash command or a critic subagent) is the environment.
Every `check run` returns a verdict; you use it to decide the next edit — the same shape as a tight
test-driven-development loop, just formalized so weak models can follow it too.

## When to declare a check

Reach for `check` when **all** of these hold:

- You are producing a concrete artifact: a file, a diagram, a chart, a config, a generated snippet, a rendered image.
- A pass/fail contract exists or can be stated: "the file exists and contains X", "the SVG has three pie slices", "the
  regex matches these examples and rejects those", "the output validates against this schema", "the rubric says…".
- You expect to iterate at least once. If the first draft is obviously right, you still benefit — one `check run`
  catches the off-by-one case cheaper than a user round-trip.

Skip the check when:

- The deliverable IS the answer to a question ("what does this function do?"). No artifact, nothing to re-render.
- A single tool call completes the task with deterministic success (`git status`, "read line 40"). The round trip costs
  more than it saves.
- The artifact is genuinely throwaway (one-off `/tmp` scratch). If the user will look at it once and discard it, don't
  spin up the loop.
- You already have a user-facing test command you'd run anyway (`npm test`). Run it inline — the iteration-loop's bash
  kind is for cases where the check is the whole contract, not a superset of an existing suite.

## How to pick a check kind

| Check kind                  | Use when…                                                                                                                | Example                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `bash`                      | Pass/fail is fully deterministic — an exit code, a pattern match, or a JSON predicate.                                   | Verify `/tmp/hello.txt` equals `"hello"`: `cmd=test "$(cat /tmp/hello.txt)" = "hello"`, default `passOn: exit-zero`.               |
| `bash`                      | A validator / linter / schema-checker exists and is the ground truth.                                                    | `cmd=xmllint --noout out.svg`, or `cmd=jq -e . config.json` with `passOn: exit-zero`.                                              |
| `bash` (`regex:` predicate) | Want to match stdout against a pattern regardless of exit code.                                                          | `cmd=rsvg-convert --version`, `passOn: regex:^rsvg-convert 2\.`.                                                                   |
| `bash` (`jq:` predicate)    | Command outputs JSON and pass/fail is a structural check on it.                                                          | `cmd=curl -s http://localhost:8080/health`, `passOn: jq:.ok == true`.                                                              |
| `critic`                    | Pass/fail is subjective or visual — "does the chart have three clearly-labeled slices", "does the tone match the brand". | `artifact: out.svg`, `rubric: "SVG renders a pie chart with 3 slices, each labeled with its percentage, using the brand palette."` |
| `critic`                    | The artifact is visual (PNG/SVG/JPG) and you want the critic to literally look at it.                                    | `read out.png` inside the critic attaches the image; qwen3 / haiku / opus-vision all critique directly.                            |

Rules of thumb:

- Start with `bash` if any deterministic validator exists. Exit codes are cheap, zero-cost, and leave no ambiguity.
- Use `critic` when the rubric fits better as English than as code. "Three slices, correct labels, brand palette" is
  harder to express as a validator than as a rubric.
- For visual critics on cheap local models, use `modelOverride: "llama-cpp/qwen3-6-35b-a3b"` on the critic spec so the
  judge runs on a vision-capable local model instead of a strong paid one.
- SVG+vision path on this host: `magick in.svg out.png` (ImageMagick is available; `rsvg-convert` is not). Have the
  critic read the rendered PNG — vision models can't parse raw SVG reliably.

## Authorship flow

Hybrid authorship is deliberate — you draft, the user reviews, only then does the loop start.

**1. Declare.** Call `check` with `action: "declare"`:

```json
{
  "action": "declare",
  "kind": "bash",
  "artifact": "out.svg",
  "cmd": "xmllint --noout out.svg",
  "maxIter": 5,
  "maxCostUsd": 0.1
}
```

Or for a critic:

```json
{
  "action": "declare",
  "kind": "critic",
  "artifact": "out.svg",
  "rubric": "SVG is a pie chart with exactly 3 slices. Each slice has a visible label with its percentage. Uses the brand palette (red #e53, blue #36c, yellow #fd3).",
  "maxIter": 5
}
```

The tool writes `.pi/checks/<task>.draft.json`. `task` defaults to `default`; v1 supports one active task at a time.

**2. Surface the draft.** Print the draft inline so the user can review, and tell them how to start:

> Proposed check (`.pi/checks/default.draft.json`): bash `xmllint --noout out.svg`, max 5 iterations, $0.10 budget.
> Review the draft, then run `check` with `action: "accept"` (or `/check accept default`) to begin iterating.

Do NOT call `check run` before the user accepts — the tool will refuse while a draft is pending.

**3. Accept.** On user confirmation, call `check` with `action: "accept"`. The extension renames draft → active and
seeds the iteration state. The system prompt starts showing a `## Iteration Loop` block every turn from now on.

**4. Iterate.** See next section.

**5. Close.** On `stopReason: "passed"` or when the user accepts best-so-far, call `check close` with an appropriate
`reason` (`passed`, `budget-iter`, `budget-cost`, `wall-clock`, `fixpoint`, `user-closed`). The task directory archives
under `.pi/checks/archive/<timestamp>-<task>/`.

## Iteration discipline

This is where small models lose — they edit, say "looks right", and skip the verification step. The rules below
mechanize the contract.

- **After every substantive edit of the artifact, run the check.** The extension counts edits since the last
  `check run`; hitting the threshold (default 2) triggers a strict nudge at turn end.
- **Read the verdict before editing again.** Open the returned `observation_path` if you need the raw output, check the
  `issues` array, and address the highest-severity issue first (blocker → major → minor).
- **One focused edit per iteration.** Shotgun edits make verdicts hard to attribute. If multiple issues exist, fix the
  blocker, re-run, then move to the next tier.
- **Never claim "the artifact is done" without a passing `check run` this turn.** The claim-nudge extension catches
  phrases like "looks right", "matches the spec", "the chart is ready" when no successful verdict was recorded — either
  run the check or retract.
- **Honor the injected status block.** Every turn while a task is active, the system prompt ends with
  `## Iteration Loop (task: default)` carrying iteration count, last verdict, best-so-far, remaining budget, and a
  `Next step:` line. That line is your directive — follow it.
- **Budget exhaustion is not failure.** If `stopReason` comes back as `budget-iter`, `budget-cost`, or `wall-clock`, the
  extension returns best-so-far. Report it to the user and ask whether to accept, extend the budget via a new `declare`,
  or reshape the rubric.
- **Fixpoint = stop editing blindly.** `stopReason: "fixpoint"` means two consecutive iterations produced identical
  artifact bytes. Edit differently or close the loop — spinning won't help.

## Composition with `todo`

One iteration loop = one todo. Keeps the plan and the loop in sync so the user can see both in the injected blocks.

- When you `check accept`, park the matching todo in `review` with a note like `"iterating — parked on check/default"`.
- While iterating, the todo stays in `review`; individual iterations are NOT separate todos (they'd churn the plan).
- Only `complete` the todo after `check run` returns `stopReason: "passed"` (or the user accepted best-so-far on budget
  exhaustion). Completion note: `"check default passed on iter 3, score 1.00"`.
- If the loop terminates without a pass (budget-iter, fixpoint) and the user wants to retry differently, `reopen` the
  todo and `declare` a new check with adjusted rubric/budget.

Use `scratchpad` for cross-iteration context you want surviving compaction: the rendering pipeline command
(`magick in.svg out.png`), non-obvious rubric interpretations, the draft's model override. One short note per item, not
an iteration log — the extension already maintains history.

## Anti-patterns

- **Don't skip authorship because "the check is obvious."** Weak models often draft checks that look sensible and subtly
  mis-spec the rubric. The user's review catches that cheaply.
- **Don't `check run` without editing between iterations.** Wasted spin; every call snapshots the artifact and (for
  critic) burns cost. The fixpoint detector will stop you after two identical bytes, but don't make it do your job.
- **Don't rely on the claim nudge to catch edits.** The strict edit-without-check nudge exists because the claim nudge
  only fires when the model vocalizes a completion claim — and small models often skip the claim entirely. Run the check
  proactively.
- **Don't iterate without reading the prior verdict.** The `issues` array is your signal. Making a guess without opening
  it is how loops wander.
- **Don't widen the rubric mid-loop to make the check pass.** If the rubric was wrong, `check close` with
  `reason: "user-closed"`, then `declare` a corrected check. Never hand-edit `.pi/checks/default.json` mid-run to cheat
  the verdict.
- **Don't forget to `close`.** Active tasks keep injecting the status block every turn; a stale active check clutters
  every unrelated conversation until the user notices. `close` on every terminal stop-reason.
- **Don't declare a second task while one is active.** v1 enforces single-task — the second `declare` will error. Finish
  or close the first.
- **Don't use `modelOverride` on the critic without a reason.** The critic inherits by default. Override only to push
  vision grading to a cheap local model (`llama-cpp/qwen3-6-35b-a3b`) or to deliberately downshift when the judge is the
  bottleneck.

## Quick reference

| Situation                                                                         | Move                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| "Produce an SVG that …" / "Generate a chart that …" / "Make a Y that satisfies Z" | `check declare` with an appropriate kind; surface draft; iterate after `accept`.   |
| Deterministic validator exists                                                    | `kind: "bash"`, `cmd: "<validator>"`, default `passOn: "exit-zero"`.               |
| Rubric is easier in English than code                                             | `kind: "critic"`, stating the rubric as listable numbered requirements.            |
| Visual artifact (PNG / rendered SVG)                                              | `kind: "critic"` — the critic `read`s the file and pi auto-attaches the image.     |
| SVG needs rendering first                                                         | `cmd: "magick in.svg out.png && <rest>"` (on this host; `rsvg-convert` is absent). |
| Command emits JSON, pass depends on structure                                     | `passOn: "jq:<expr>"` (needs `jq` on PATH).                                        |
| You just got a verdict with issues                                                | Read the highest-severity issue first, make one focused edit, `check run` again.   |
| `stopReason: "passed"`                                                            | `check close` with `reason: "passed"`. Mark the matching todo `complete`.          |
| `stopReason: "budget-iter"` (or `budget-cost` / `wall-clock`)                     | Report best-so-far. User chooses: accept, extend budget, or reshape rubric.        |
| `stopReason: "fixpoint"`                                                          | Stop — bytes aren't changing. Edit differently or close + re-declare.              |
| Model claimed "looks right" but never ran `check run` this turn                   | Run `check run` now or retract the claim before the nudge forces the round trip.   |
| Already have a `bash` check of the same shape from a previous task                | Re-declare it. v1.5 will add recipe reuse via `memory`; for now copy the fields.   |
