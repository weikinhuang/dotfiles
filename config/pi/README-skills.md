# pi skills

Auto-loaded skills for pi, wired in via the `skills` array in [`settings-baseline.json`](./settings-baseline.json).

Lives at `config/pi/README-skills.md` (one level above the `skills/` directory) so pi's skill loader - which validates
every `.md` it finds under the scanned directory - doesn't try to treat this index as a skill.

Each skill lives in its own `skills/kebab-case/SKILL.md` folder. The frontmatter `description` is the trigger surface:
pi decides whether to load the body based on WHAT + WHEN + DO-NOT shape. See
[`../../node_modules/@public-projects/agents-tooling/guides/skill-authoring-guide.md`](../../node_modules/@public-projects/agents-tooling/guides/skill-authoring-guide.md)
for the authoring rules these skills follow.

The following skills carry `disable-model-invocation: true`, so they are kept out of the always-on system-prompt index
to save tokens. They stay loadable on demand via `/skill:<name>`; the model no longer auto-discovers them, so invoke
them explicitly when needed:

- The five image-model prompting skills (`anima-prompting`, `chenkin-noob-xl-prompting`, `flux2-klein-prompting`,
  `illustrious-prompting`, `noobai-vpred-prompting`) - invoke the matching one (e.g. `/skill:anima-prompting`) when
  prompting an image workflow.
- `hooks-author` - invoke (`/skill:hooks-author`) when wiring a pi user hook.

## Index

| Skill                                                                                        | Companion extension                                                                                                                    | Policy summary                                                                                                                      |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [`skills/ai-fetch-web/SKILL.md`](./skills/ai-fetch-web/SKILL.md)                             | - (CLI on `$PATH`)                                                                                                                     | WHEN to reach for the `ai-fetch-web` CLI over raw `curl` or harness-native fetch tools.                                             |
| [`skills/anima-prompting/SKILL.md`](./skills/anima-prompting/SKILL.md)                       | [`comfyui`](./extensions/comfyui.md)                                                                                                   | HOW to write Anima positive/negative prompts (tags + natural language, score/safety tags, `@artist`) when calling `generate_image`. |
| [`skills/apply-patch-format/SKILL.md`](./skills/apply-patch-format/SKILL.md)                 | [`apply-patch`](./extensions/apply-patch.md)                                                                                           | WHEN to reach for `apply_patch` over `edit` / `write` and how to shape the strict Codex format.                                     |
| [`skills/background-bash/SKILL.md`](./skills/background-bash/SKILL.md)                       | [`bg-bash`](./extensions/bg-bash.md)                                                                                                   | WHEN to run a command off-turn with `bg_bash` vs block on `bash`, and how to poll / steer / collect it.                             |
| [`skills/chenkin-noob-xl-prompting/SKILL.md`](./skills/chenkin-noob-xl-prompting/SKILL.md)   | [`comfyui`](./extensions/comfyui.md)                                                                                                   | HOW to write Chenkin Noob XL (CKXL) prompts (NoobAI-1.1 eps lineage, CKXL `aesthetic`/`excellent` vocab, CFG 5-6 + Euler a).        |
| [`skills/clarify-with-questionnaire/SKILL.md`](./skills/clarify-with-questionnaire/SKILL.md) | [`questionnaire`](./extensions/questionnaire.md)                                                                                       | WHEN to ask the user a structured question vs infer, and how to shape `single` / `multi` / `free` options.                          |
| [`skills/compute-over-bash/SKILL.md`](./skills/compute-over-bash/SKILL.md)                   | [`wasm-compute`](./extensions/wasm-compute.md)                                                                                         | WHEN to reach for the `compute` tool over `python -c` / `node -e` / `bc` for pure computation.                                      |
| [`skills/deep-research-when/SKILL.md`](./skills/deep-research-when/SKILL.md)                 | [`deep-research`](./extensions/deep-research.md)                                                                                       | WHEN the heavy `research` pipeline pays for itself vs a single fetch or scoped subagent.                                            |
| [`skills/flux2-klein-prompting/SKILL.md`](./skills/flux2-klein-prompting/SKILL.md)           | [`comfyui`](./extensions/comfyui.md)                                                                                                   | HOW to write FLUX.2 [klein] prompts (natural-language prose, the CFG-vs-negative caveat, text rendering, multi-ref edits).          |
| [`skills/grep-before-read/SKILL.md`](./skills/grep-before-read/SKILL.md)                     | [`read-without-limit-nudge`](./extensions/read-without-limit-nudge.md), [`read-reread-detector`](./extensions/read-reread-detector.md) | Default to `rg -n` for discovery; use `read` only after you know the target lines.                                                  |
| [`skills/hooks-author/SKILL.md`](./skills/hooks-author/SKILL.md)                             | [`hooks`](./extensions/hooks.md)                                                                                                       | WHEN to wire a user hook (`~/.pi/agent/hooks.json`) vs an ad-hoc command vs a full extension.                                       |
| [`skills/illustrious-prompting/SKILL.md`](./skills/illustrious-prompting/SKILL.md)           | [`comfyui`](./extensions/comfyui.md)                                                                                                   | HOW to write Illustrious-XL positive/negative prompts (Danbooru + natural language; no Pony score tags, no `@artist`).              |
| [`skills/iterate-until-verified/SKILL.md`](./skills/iterate-until-verified/SKILL.md)         | [`iteration-loop`](./extensions/iteration-loop.ts)                                                                                     | Declare a `check` for artifact-producing tasks; edit → run → verdict until passed or budget spent.                                  |
| [`skills/memory-first/SKILL.md`](./skills/memory-first/SKILL.md)                             | [`memory`](./extensions/memory.md)                                                                                                     | WHEN to persist durable notes via `memory` - and, critically, what NOT to save.                                                     |
| [`skills/noobai-vpred-prompting/SKILL.md`](./skills/noobai-vpred-prompting/SKILL.md)         | [`comfyui`](./extensions/comfyui.md)                                                                                                   | HOW to write NoobAI-XL v-pred prompts (`artist:name` syntax, anti-furry negatives, CFG 4-5 + Euler + zsnr constraints).             |
| [`skills/notes-decision-tree/SKILL.md`](./skills/notes-decision-tree/SKILL.md)               | [`scratchpad`](./extensions/scratchpad.md), [`todo`](./extensions/todo.md), [`memory`](./extensions/memory.md)                         | Choose `scratchpad` (turn-local) vs `todo` (multi-step plan) vs `memory` (cross-session) by scope and content kind.                 |
| [`skills/plan-first/SKILL.md`](./skills/plan-first/SKILL.md)                                 | [`todo`](./extensions/todo.md)                                                                                                         | Plan multi-step work with `todo` up front so it survives compaction.                                                                |
| [`skills/scheduled-prompts/SKILL.md`](./skills/scheduled-prompts/SKILL.md)                   | [`scheduled-prompts`](./extensions/scheduled-prompts.md)                                                                               | WHEN to fire a self-prompt on a timer, and which trigger: recurring (cron / interval) vs one-shot vs idle (`after`).                |
| [`skills/subagent-background/SKILL.md`](./skills/subagent-background/SKILL.md)               | [`subagent`](./extensions/subagent.md)                                                                                                 | Lifecycle for `run_in_background: true`: fan-out, polling, steering, abort criteria.                                                |
| [`skills/subagent-delegation/SKILL.md`](./skills/subagent-delegation/SKILL.md)               | [`subagent`](./extensions/subagent.md)                                                                                                 | WHEN to delegate, which agent type to pick, and how to write a zero-context task prompt.                                            |

## Related docs

- [README.md](./README.md) - pi config overview and index.
- [extensions/README.md](./extensions/README.md) - extensions that provide the tools these skills teach.
- [agents/README.md](./agents/README.md) - subagent definitions callable from the skills.
