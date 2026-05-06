# `deep-research.ts`

Long-horizon web-research extension: registers a `/research` slash command and an LLM-callable `research` tool that
drive a plan → fanout → synth → two-stage-review pipeline, writing a fully-cited markdown report under
`./research/<slug>/`.

## What it does

Thin pi-coupled wiring layer over the pure pipeline modules under `../../../lib/node/pi/deep-research-*.ts`. On
`session_start` it loads subagent definitions from [`../agents/`](../agents/) via
[`subagent-loader.ts`](../../../lib/node/pi/subagent-loader.ts). A module-scope
[`ResearchSessionFlag`](../../../lib/node/pi/deep-research-tool.ts) enforces one active run per session, shared by the
command and tool.

Pipeline stages (driven by [`runResearchPipeline`](../../../lib/node/pi/deep-research-pipeline.ts)):

1. **Planner** (+ self-critic) — decomposes the question into sub-questions; writes `plan.json`.
2. **Planning-critic** — [`research-planning-critic`](../agents/research-planning-critic.md) subagent reviews the plan;
   rejection is a checkpoint (user edits `plan.json` and reruns).
3. **Fanout** — sync spawner runs one [`web-researcher`](../agents/web-researcher.md) per sub-question via
   [`runOneShotAgent`](../../../lib/node/pi/subagent-spawn.ts), fetching via the MCP `fetch_web` CLI client
   ([`research-ai-fetch-web-cli-client.ts`](../../../lib/node/pi/research-ai-fetch-web-cli-client.ts)). Progress feeds a
   live statusline.
4. **Synth + merge** — per-section render then merge into `report.md`.
5. **Two-stage review** — structural check
   ([`deep-research-structural-check.ts`](../../../lib/node/pi/deep-research-structural-check.ts)) then subjective
   critic, wired via [`deep-research-review-wire.ts`](../../../lib/node/pi/deep-research-review-wire.ts) /
   [`deep-research-review-loop.ts`](../../../lib/node/pi/deep-research-review-loop.ts); refinement through
   [`deep-research-refine.ts`](../../../lib/node/pi/deep-research-refine.ts).

Observability: every phase event feeds a pure reducer
([`deep-research-statusline.ts`](../../../lib/node/pi/deep-research-statusline.ts)) rendered into
`ctx.ui.setWidget("deep-research", …)` with an 80 ms spinner and 8 s auto-dismiss. Cost hooks
([`research-cost-hook.ts`](../../../lib/node/pi/research-cost-hook.ts)) route per-turn USD into a live budget
([`research-budget-live.ts`](../../../lib/node/pi/research-budget-live.ts)) that appends a `cost report` to
`journal.md`.

Artifacts under `./research/<slug>/` (paths from [`research-paths.ts`](../../../lib/node/pi/research-paths.ts)):
`plan.json`, `fanout.json`, `findings/`, `snapshots/sections/<id>.md`, `rubric-structural.md`, `rubric-subjective.md`,
`report.md`, `journal.md`.

The `research` tool registers a TypeBox schema accepting `question` plus optional overrides (see below), validated by
[`validateToolOverrides`](../../../lib/node/pi/research-command-args.ts). The tool rejects a second concurrent call, and
returns a one-screen summary plus a structured `outcome` (`report-complete` / `fanout-complete` / `planner-stuck` /
`checkpoint` / `error`).

## Commands

- `/research <question>` — run the full pipeline. On slug collision with a prior run, prompts resume/fresh/cancel
  (interactive) or errors with a resume hint (print/RPC).
- `/research --list` — table of prior runs via [`runListCommand`](../../../lib/node/pi/research-runs.ts).
- `/research --selftest` — canned fixture via [`selftestDeepResearch`](../../../lib/node/pi/research-selftest.ts).
- `/research --resume [--run-root <path>] [--from plan-crit|fanout|synth|review] [--sq <id>[,<id>…]]` — resume an
  existing run. Stage auto-detected from on-disk state ([`detectResumeStage`](../../../lib/node/pi/research-resume.ts))
  unless `--from` is pinned; defaults to the most-recent run when `--run-root` is omitted. `--sq` is only valid with
  `--from=fanout` (or alone, which implies it).
- Question-mode flags (any order): `--model`, `--plan-crit-model`, `--fanout-model`, `--critic-model`,
  `--fanout-max-turns`, `--critic-max-turns`, `--review-max-iter`, `--fanout-parallel`, `--wall-clock`. Parsed by
  [`parseResearchCommandArgs`](../../../lib/node/pi/research-command-args.ts). `--wall-clock` accepts a bare integer
  (seconds) or a suffixed duration (`90s` / `30m` / `2h`; clamp 24h).

## Tool: `research`

- `question` _(required, string)_ — the research question; drives the whole pipeline.
- `model` _(string, `provider/id`)_ — parent-session model override; inherit-mode subagents inherit it.
- `planCritModel` _(string)_ — override for the `research-planning-critic` spawn only (precedence over `model`).
- `fanoutModel` _(string)_ — override for every `web-researcher` fanout spawn only.
- `criticModel` _(string)_ — override for the subjective critic spawn only.
- `fanoutMaxTurns` _(int 1–1000)_ — `maxTurns` cap for each fanout spawn (agent default 20).
- `criticMaxTurns` _(int 1–1000)_ — `maxTurns` cap for planning-critic + subjective critic spawns.
- `reviewMaxIter` _(int 1–1000, default 4)_ — cap on cross-stage review iterations; also honored by `--resume` to extend
  a prior `budget-exhausted` run.
- `fanoutParallel` _(int 1–64)_ — cap on simultaneous web-researcher fanout workers. Overrides
  `plan.budget.maxSubagents` for this run only. Set to `1` when fanout points at a single local model (llama.cpp /
  Ollama) that can't handle concurrent requests.
- `wallClockSec` _(int 1–86_400)_ — wall-clock override for the fanout, in seconds. Overrides `plan.budget.wallClockSec`
  for this run only. Typical local-model shape: `wallClockSec: 7200` (2h). Slash-command equivalent `--wall-clock`
  additionally accepts `h` / `m` / `s` suffixes.

## Subagents dispatched

Agents loaded from [`../agents/`](../agents/) via `defaultAgentLayers`:

- [`web-researcher`](../agents/web-researcher.md) — one spawn per sub-question; fetches + extracts cited findings.
- [`research-planning-critic`](../agents/research-planning-critic.md) — structural critique of `plan.json`; may halt the
  pipeline at the plan-crit checkpoint.
- [`critic`](../agents/critic.md) — subjective reviewer invoked inside the review loop via `runDeepResearchReview` /
  `buildCriticTask` ([`iteration-loop-check-critic.ts`](../../../lib/node/pi/iteration-loop-check-critic.ts)).

The planner, self-critic, rewrite, synth, merge, and refine turns run directly on the parent `AgentSession` (no
dedicated subagent); structural checking is a pure module, not a subagent.

## Environment variables

- `PI_DEEP_RESEARCH_DISABLED=1` — skip the extension entirely (no `/research` command or `research` tool registered).

Additional env vars are consumed indirectly by
[`createAiFetchWebCliClientFromEnv`](../../../lib/node/pi/research-ai-fetch-web-cli-client.ts) for the MCP fetch-web
client; see that module for specifics.

## Hot reload

Edit [`extensions/deep-research.ts`](./deep-research.ts) or any companion under
[`lib/node/pi/deep-research-*.ts`](../../../lib/node/pi/) / [`lib/node/pi/research-*.ts`](../../../lib/node/pi/) and run
`/reload` in an interactive pi session to pick up changes without restarting.
