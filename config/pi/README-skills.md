# pi skills

Auto-loaded skills for pi, wired in via the `skills` array in [`settings-baseline.json`](./settings-baseline.json).

Lives at `config/pi/README-skills.md` (one level above the `skills/` directory) so pi's skill loader — which validates
every `.md` it finds under the scanned directory — doesn't try to treat this index as a skill.

Each skill lives in its own `skills/kebab-case/SKILL.md` folder. The frontmatter `description` is the trigger surface:
pi decides whether to load the body based on WHAT + WHEN + DO-NOT shape. See
[`../../node_modules/@public-projects/agents-tooling/guides/skill-authoring-guide.md`](../../node_modules/@public-projects/agents-tooling/guides/skill-authoring-guide.md)
for the authoring rules these skills follow.

## Index

| Skill                                                                                | Companion extension                                                                                                                    | Policy summary                                                                                     |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`skills/ai-fetch-web/SKILL.md`](./skills/ai-fetch-web/SKILL.md)                     | — (CLI on `$PATH`)                                                                                                                     | WHEN to reach for the `ai-fetch-web` CLI over raw `curl` or harness-native fetch tools.            |
| [`skills/grep-before-read/SKILL.md`](./skills/grep-before-read/SKILL.md)             | [`read-without-limit-nudge`](./extensions/read-without-limit-nudge.md), [`read-reread-detector`](./extensions/read-reread-detector.md) | Default to `rg -n` for discovery; use `read` only after you know the target lines.                 |
| [`skills/iterate-until-verified/SKILL.md`](./skills/iterate-until-verified/SKILL.md) | [`iteration-loop`](./extensions/iteration-loop.ts)                                                                                     | Declare a `check` for artifact-producing tasks; edit → run → verdict until passed or budget spent. |
| [`skills/memory-first/SKILL.md`](./skills/memory-first/SKILL.md)                     | [`memory`](./extensions/memory.md)                                                                                                     | WHEN to persist durable notes via `memory` — and, critically, what NOT to save.                    |
| [`skills/plan-first/SKILL.md`](./skills/plan-first/SKILL.md)                         | [`todo`](./extensions/todo.md)                                                                                                         | Plan multi-step work with `todo` up front so it survives compaction.                               |
| [`skills/subagent-background/SKILL.md`](./skills/subagent-background/SKILL.md)       | [`subagent`](./extensions/subagent.md)                                                                                                 | Lifecycle for `run_in_background: true`: fan-out, polling, steering, abort criteria.               |
| [`skills/subagent-delegation/SKILL.md`](./skills/subagent-delegation/SKILL.md)       | [`subagent`](./extensions/subagent.md)                                                                                                 | WHEN to delegate, which agent type to pick, and how to write a zero-context task prompt.           |

## Related docs

- [README.md](./README.md) — pi config overview and index.
- [extensions/README.md](./extensions/README.md) — extensions that provide the tools these skills teach.
- [agents/README.md](./agents/README.md) — subagent definitions callable from the skills.
