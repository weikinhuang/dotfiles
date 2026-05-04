# pi subagent definitions

Agent definitions dispatched by [`../extensions/subagent.ts`](../extensions/subagent.ts) (the `subagent(agent, task)`
tool) and discovered via the `agents` array in [`../settings-baseline.json`](../settings-baseline.json). Each child runs
with its own fresh context, tool allowlist, and optional model override. The parent sees only the final answer text.

The subagent loader ([`../../../lib/node/pi/subagent-loader.ts`](../../../lib/node/pi/subagent-loader.ts)) ignores
`README.md` / `readme.md` so this index doesn't have to carry agent frontmatter.

For WHEN to delegate and HOW to write a zero-context `task` prompt, see
[`../skills/subagent-delegation/SKILL.md`](../skills/subagent-delegation/SKILL.md) and
[`../skills/subagent-background/SKILL.md`](../skills/subagent-background/SKILL.md).

## Index

| Agent                                                          | Tools                                | Purpose                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| [`critic.md`](./critic.md)                                     | `read` only                          | Rubric-graded judge used by [`iteration-loop`](../extensions/iteration-loop.ts) `check run` with `kind: critic`.  |
| [`explore.md`](./explore.md)                                   | `read`, `grep`, `find`, `ls`         | Read-only code exploration — "find X across the codebase", "summarize this module".                               |
| [`general-purpose.md`](./general-purpose.md)                   | default set (bash + read/write/edit) | Catch-all delegate for subtasks that need to read, modify, and run commands while keeping the parent clean.       |
| [`plan.md`](./plan.md)                                         | `read`, `grep`, `find`, `ls`         | Turn a vague problem statement into a concrete file-level implementation plan.                                    |
| [`research-planning-critic.md`](./research-planning-critic.md) | `read` only                          | Rubric judge for research plans / experiment hypotheses BEFORE expensive downstream fanout runs.                  |
| [`tiny-helper.md`](./tiny-helper.md)                           | minimal                              | Narrow non-research plumbing (slug gen, title normalization, URL classification). Never touches research content. |
| [`web-researcher.md`](./web-researcher.md)                     | `fetch-web` CLI + filesystem         | Per-sub-question researcher used by the `/research` fanout; writes a strict-schema `findings/<subq-id>.md`.       |

## Related docs

- [../README.md](../README.md) — pi config overview and index.
- [../extensions/subagent.md](../extensions/subagent.md) — `subagent` tool surface, context inheritance, worktree
  sandbox.
- [../skills/subagent-delegation/SKILL.md](../skills/subagent-delegation/SKILL.md) — delegation policy.
- [../skills/subagent-background/SKILL.md](../skills/subagent-background/SKILL.md) — async lifecycle policy.
