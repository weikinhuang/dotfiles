# pi subagent definitions

Agent definitions dispatched by [`../extensions/subagent.ts`](../extensions/subagent.ts) (the `subagent(agent, task)`
tool) and discovered via the `agents` array in [`../settings-baseline.json`](../settings-baseline.json). Each child runs
with its own fresh context, tool allowlist, and optional model override. The parent sees only the final answer text.

The subagent loader ([`../../../lib/node/pi/subagent/loader.ts`](../../../lib/node/pi/subagent/loader.ts)) ignores
`README.md` / `readme.md` so this index doesn't have to carry agent frontmatter.

For WHEN to delegate and HOW to write a zero-context `task` prompt, see
[`../skills/subagent-delegation/SKILL.md`](../skills/subagent-delegation/SKILL.md) and
[`../skills/subagent-background/SKILL.md`](../skills/subagent-background/SKILL.md).

## Index

| Agent                                                          | Tools                                | Purpose                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`critic.md`](./critic.md)                                     | `read` only                          | Rubric-graded judge used by the [`deep-research`](../extensions/deep-research.ts) review loop.                                             |
| [`explore.md`](./explore.md)                                   | `read`, `grep`, `find`, `ls`         | Read-only code exploration - "find X across the codebase", "summarize this module".                                                        |
| [`general-purpose.md`](./general-purpose.md)                   | default set (bash + read/write/edit) | Catch-all delegate for subtasks that need to read, modify, and run commands while keeping the parent clean.                                |
| [`comfyui-enhance.md`](./comfyui-enhance.md)                   | none                                 | Refines a prompt + negative into an image model's native protocol for the [`comfyui`](../extensions/comfyui.ts) `generate_image` enhancer. |
| [`implementer.md`](./implementer.md)                           | default set (bash + read/write/edit) | Long-running (40 min / 150 turns) scoped implementation with tests; owns an explicit file list when fanned out in parallel.                |
| [`image-captioner.md`](./image-captioner.md)                   | `read` only                          | One dense caption of an image being dropped from context - auto-caption fallback for [`context-trim`](../extensions/context-trim.ts).      |
| [`plan.md`](./plan.md)                                         | `read`, `grep`, `find`, `ls`         | Turn a vague problem statement into a concrete file-level implementation plan.                                                             |
| [`research-planning-critic.md`](./research-planning-critic.md) | `read` only                          | Rubric judge for research plans / experiment hypotheses BEFORE expensive downstream fanout runs.                                           |
| [`roleplay-event.md`](./roleplay-event.md)                     | none                                 | Proposes one short in-world complication for the [`roleplay`](../extensions/roleplay.ts) `/roleplay event` system.                         |
| [`roleplay-summarizer.md`](./roleplay-summarizer.md)           | none                                 | Folds the span pi evicts at compaction into one rolling scene recap for the [`roleplay`](../extensions/roleplay.ts) `summary` record.      |
| [`tiny-helper.md`](./tiny-helper.md)                           | minimal                              | Narrow non-research plumbing (slug gen, title normalization, URL classification). Never touches research content.                          |
| [`waveform-phraser.md`](./waveform-phraser.md)                 | none                                 | One present-participle phrase (<=25 chars) for the waveform-indicator's dynamic head. No tools, no reasoning.                              |
| [`web-researcher.md`](./web-researcher.md)                     | `ai-fetch-web` CLI + filesystem      | Per-sub-question researcher used by the `/research` fanout; writes a strict-schema `findings/<subq-id>.md`.                                |

## Picking an agent and model for implementation work

- **`general-purpose`** (10 min, 50 turns) fits small edit-and-verify tasks. **`implementer`** (40 min, 150 turns) fits
  multi-file changes that must pass a test suite. Either can be stretched per call with `timeoutMs` (clamped to the
  `maxTimeoutMs` ceiling, default 1 h) and `maxTurns`.
- When a child stops early (timeout, turn cap, abort, error) the result's first line says so and lists the files it
  tried to write; the child's last message trails as `Last message:`. Check those files before re-delegating.
- Parallel implementers in a shared checkout must own disjoint files - say which files each task owns.
- Every shipped agent uses `model: inherit`, so a delegated child costs as much per token as the parent. For mechanical
  work (applying a known call-site change, spec fixups, renames) pass a cheaper model per call - a Haiku-class hosted
  model or a local coder model - e.g.
  `subagent({ agent: "implementer", task, modelOverride: "<provider>/<cheap-id>" })`, or set a project default in
  `.pi/subagent.json` (`{ "model": "provider/id" }`). Keep design-heavy or ambiguous tasks on the parent model.

## Related docs

- [../README.md](../README.md) - pi config overview and index.
- [../extensions/subagent.md](../extensions/subagent.md) - `subagent` tool surface, context inheritance, worktree
  sandbox.
- [../skills/subagent-delegation/SKILL.md](../skills/subagent-delegation/SKILL.md) - delegation policy.
- [../skills/subagent-background/SKILL.md](../skills/subagent-background/SKILL.md) - async lifecycle policy.
