---
name: deep-research-when
description:
  'WHAT: Decide when the heavy `research` deep-research pipeline (plan -> fanout -> synth -> two-stage review, writing a
  cited report under ./research/) is worth its time and token cost, versus a cheaper single fetch or subagent. WHEN: The
  user wants a thorough, multi-source, fact-checked written report on an open question. DO-NOT: Fire it for a single
  lookup, a question one `ai-fetch-web` call answers, or anything you can settle by reading the repo.'
---

# Deep research, when

The `research` tool (and `/research` command) runs a long-horizon pipeline: it decomposes a question into sub-questions,
spawns a `web-researcher` subagent per sub-question, synthesizes per-section drafts, merges them, then runs a two-stage
review (structural + subjective critic) before writing a fully-cited `report.md` under `./research/<slug>/`. It is the
heaviest tool in the kit - many subagent spawns, many fetches, real wall-clock and token spend. This skill is the policy
for when that spend pays off and when a cheaper move wins.

## When to use this skill

Reach for `research` only when most of these hold:

- **The answer needs many independent sources**, weighed against each other - not one authoritative page.
- **The deliverable is a written, cited report** the user will keep or share, not a one-line answer.
- **The question is open or comparative**: "compare the trade-offs of X vs Y vs Z for use-case W", "what is the current
  state of the art in ...", "survey the approaches to ...".
- **Getting it wrong is expensive**, so the adversarial review stage (claims fact-checked, structure critiqued) earns
  its cost.

Do NOT use `research` when a cheaper path answers the question:

- **One page answers it.** A single [`ai-fetch-web`](../ai-fetch-web/SKILL.md) fetch (or `curl`) is seconds, not
  minutes. Reach for the pipeline only when you would otherwise fan out across a dozen pages by hand.
- **It is a lookup, not a survey.** "What is the latest stable version of X?" or "what does this API return?" is a
  fetch, not a research run.
- **The answer is in the repo or local files.** Read the code, `git log`, or the docs. Pi's
  [`grep-before-read`](../grep-before-read/SKILL.md) is the move, not web research.
- **A scoped subagent suffices.** A single [`explore`-type subagent](../subagent-delegation/SKILL.md) that fetches two
  or three pages and returns a summary is far cheaper than the full pipeline.
- **The question is underspecified.** Garbage in, expensive garbage out. Narrow it first (see below).

## Workflow

1. **Try the cheap path first.** Can one fetch, one grep, or one scoped subagent answer it? If yes, do that and stop.
2. **Sharpen the question before spending.** A vague prompt produces a vague, expensive report. If scope, constraints,
   region, budget, or use-case are missing, ask 2-3 clarifying questions first - the
   [`clarify-with-questionnaire`](../clarify-with-questionnaire/SKILL.md) tool is built for exactly this. Weave the
   answers into the `question`.
3. **Right-size the run.** The tool takes optional overrides; tune them to the job instead of accepting defaults
   blindly:
   - `fanoutParallel` - cap simultaneous web-researchers. Set to `1` when fanout points at a single local model that
     cannot handle concurrent requests.
   - `wallClockSec` - hard wall-clock budget for the fanout (e.g. `7200` for a 2h local-model run).
   - `model` / `fanoutModel` / `criticModel` / `planCritModel` - per-stage model overrides; push fanout to a cheaper
     model and keep a stronger one for synthesis when that fits.
   - `reviewMaxIter` - cap on review iterations (default 4).
4. **Launch and let it checkpoint.** Only one research run is allowed per session. The planning-critic stage is a
   checkpoint: if it rejects the plan, the run halts so you can edit `plan.json` and rerun.
5. **Resume rather than restart** if a run stalls or exhausts its budget: `/research --resume` auto-detects the stage
   from on-disk state, or pin it with `--from plan-crit|fanout|synth|review`.
6. **Deliver the report.** The artifacts land under `./research/<slug>/` (`plan.json`, `findings/`, `report.md`,
   `journal.md`). Point the user at `report.md`; summarize the outcome (`report-complete` / `checkpoint` / etc.).

## Cost discipline

- The pipeline spawns one subagent per sub-question plus critics. A 10-sub-question plan is 10+ child sessions. Treat
  every run as a deliberate spend, not a default.
- Prefer a tighter `wallClockSec` and lower `fanoutParallel` on local models - an unbounded run can grind for hours.
- If the user just wants "a quick sense of X", that is a fetch or a subagent, not a research run. Say so and offer the
  cheap version first.

## Common pitfalls

- **Using `research` as a search box.** It is a report generator. For a single fact, fetch.
- **Launching on a fuzzy question.** Clarify scope first; the review stage cannot fix an ill-posed prompt.
- **Ignoring the checkpoint.** A rejected plan is a signal to fix the decomposition, not to force the run through.
- **Starting a second run mid-session.** The tool rejects concurrent runs - `wait` for or resume the first.

## Related docs

- [`deep-research.md`](../../extensions/deep-research.md) - full pipeline reference: stages, tool params, `--resume`,
  artifacts, subagents dispatched.
- [`ai-fetch-web`](../ai-fetch-web/SKILL.md) - the cheap single-fetch alternative to try first.
- [`clarify-with-questionnaire`](../clarify-with-questionnaire/SKILL.md) - narrow an underspecified question before
  spending.
- [`subagent-delegation`](../subagent-delegation/SKILL.md) - a scoped subagent is the mid-weight alternative.
