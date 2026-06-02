---
name: notes-decision-tree
description:
  'WHAT: Choose between the three notes-ish tools - `scratchpad` (turn-to-turn free-form carry-over), `todo` (a typed
  multi-step plan), and `memory` (durable cross-session facts) - by scope and content kind. WHEN: You are about to jot
  something down to remember and are unsure which tool holds it. DO-NOT: Persist ephemeral task state into `memory`, use
  `scratchpad` for a multi-step plan, or hand-edit any of their backing files.'
---

# Notes decision tree

Pi has three places to write things down, and they are easy to confuse. `scratchpad` is free-form carry-over for the
current line of work. `todo` is a typed, status-tracked plan for a multi-step task. `memory` is durable storage that
survives session shutdown and new projects. Picking wrong means either losing context you needed (too ephemeral) or
polluting future sessions with stale junk (too durable). This skill is the decision tree.

## When to use this skill

Use it the moment you are about to record something to remember and more than one of these tools could plausibly hold
it. The two axes that decide it:

- **Scope** - how long must this outlive the moment? This turn / this session vs. this multi-step task vs. every future
  session.
- **Content kind** - free-form prose, a tracked step with a status, or a durable fact about the user / project / world.

## Decision tree

1. **Is it a step in a multi-step task you will work through?** -> `todo`. Anything with "first do X, then Y, then
   verify Z", where you need a status (`pending` / `in_progress` / `review` / `completed` / `blocked` / `cancelled`) and
   a guardrail against claiming done while items are open.
2. **Is it a durable fact that should survive this session and apply to future ones?** -> `memory`. A user preference, a
   correction you were given, a project decision, a pointer to an external system. See
   [`memory-first`](../memory-first/SKILL.md) for the four types and, critically, what NOT to save.
3. **Otherwise - free-form context you keep rediscovering this turn or this session?** -> `scratchpad`. File paths, the
   test / lint command, a decision you made, a subagent handle, the user's answer to a clarifying question.

When two seem to fit, prefer the _less durable_ tool. A misplaced `memory` pollutes every future session; a misplaced
`scratchpad` note just goes quiet when the work ends.

## The three tools

### `scratchpad` - turn-to-turn, free-form, branch-local

Unstructured working notes auto-injected into the system prompt every turn under `## Working Notes`. Survives `/compact`
and is branch-aware (`/fork`, `/tree` show the right notes), but does NOT persist past the session or leak across
branches. Actions: `append` (with optional `heading`), `update`, `remove`, `list`, `clear`.

Reach for it when:

- You keep re-deriving the same path, command, or fact and want it in front of you next turn.
- You need to park a subagent handle or a background job id so you can re-attach after compaction.
- You captured the user's answer to a clarifying question and the next few turns need it.

### `todo` - the typed multi-step plan

A status-tracked plan, also auto-injected every turn, with hard invariants (at most one `in_progress`, at most one
`review`) and a completion-claim guardrail. Branch-aware and compaction-resilient. See
[`plan-first`](../plan-first/SKILL.md) for when to plan and the block-vs-cancel distinction.

Reach for it when:

- The task has more than one or two steps and you want it to survive compaction as a checklist.
- You need to track progress and not lose the thread of what is done vs. open.

### `memory` - durable, cross-session

Single markdown files with `name` / `description` / `type` frontmatter (`user` / `feedback` / `project` / `reference`),
plus a session-scoped `note` layer. Indices are injected every turn; bodies fetched on demand. Survives session
shutdown, compaction, and new projects (global types) or returns when you re-enter the workspace (project types).

Reach for it when:

- The fact should still matter next week or in a different session: a stable preference, a blessed approach, a project
  decision, an external-system pointer.
- Read [`memory-first`](../memory-first/SKILL.md) before saving - most utterances are transient task context, not
  durable knowledge, and code / git history / CLAUDE.md must NOT be copied into memory.

## Quick reference

| You want to remember...                                  | Tool         | Scope                      |
| -------------------------------------------------------- | ------------ | -------------------------- |
| The lint command you keep re-typing                      | `scratchpad` | This session, free-form    |
| A background job id / subagent handle to re-attach       | `scratchpad` | This session, free-form    |
| The user's answer to a clarifying question (for now)     | `scratchpad` | This session, free-form    |
| The 5 steps of the refactor you are working through      | `todo`       | This task, typed + tracked |
| Which step is in progress vs. done                       | `todo`       | This task, typed + tracked |
| "User prefers terse replies" / a correction you got      | `memory`     | Cross-session (`feedback`) |
| "We're ripping out auth middleware for compliance"       | `memory`     | This project, durable      |
| "Pipeline bugs live in Linear project INGEST"            | `memory`     | This project (`reference`) |
| Context that must survive `/compact` but not the session | `memory`     | `note` (session-scoped)    |

## Common pitfalls

- **Persisting ephemeral task state into `memory`.** Use `scratchpad` / `todo` - they are branch-aware and do not
  outlive the work. Saving "the failing test is X" as a durable memory rots immediately.
- **Using `scratchpad` for a real plan.** No status tracking, no done-guardrail. A multi-step task is a `todo`.
- **Copying code / git history / CLAUDE.md into `memory`.** It lives in the repo - read it. Memory copies go stale the
  moment the source changes.
- **Hand-editing the backing files.** `MEMORY.md` is one-line-per-memory; `scratchpad` and `todo` reconstruct from
  branch entries. Let the tools manage their own state.
- **Defaulting to durable.** When unsure between session and cross-session, prefer the session tool - a stray global
  memory pollutes every future session.

## Related docs

- [`scratchpad.md`](../../extensions/scratchpad.md) - free-form working-notes tool reference.
- [`todo.md`](../../extensions/todo.md) - typed plan tool reference (states, transitions, guardrail).
- [`memory.md`](../../extensions/memory.md) - durable memory tool reference.
- [`memory-first`](../memory-first/SKILL.md) - when to save durable memory and what NOT to save.
- [`plan-first`](../plan-first/SKILL.md) - when to plan multi-step work with `todo`.
