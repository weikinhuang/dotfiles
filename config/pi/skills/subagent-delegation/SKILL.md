---
name: subagent-delegation
description: >-
  Delegate discovery, planning, and scoped edits to a `subagent` whenever the next steps would pollute the parent's
  context with intermediate tool output you won't reuse. Covers when to delegate vs. do it inline, how to write a
  zero-context `task` prompt, which agent type to pick (`explore` / `plan` / `general-purpose`), using `modelOverride`
  to push grunt work to cheaper/weaker models, structured JSON handoffs, and the anti-patterns that make subagents
  worse than inline work.
---

# Subagent Delegation

A subagent is a fresh pi session with its own context, tool allowlist, and (optionally) a different model. The parent
pays for the child's **final answer only** — every intermediate `read`, `grep`, and `bash` stays in the child's
session. That makes subagents a context-compression tool, not a parallelism gimmick.

This skill is the policy for the **parent** side of that contract: when to spawn a child, how to brief it, and what
NOT to delegate. For managing long-running children see `subagent-background`.

## When to delegate

Reach for `subagent` when at least one of these is true:

- **Noisy discovery.** The next move would `rg` / `read` a bunch of files to answer a question you need one sentence
  from. Classic fit for the `explore` agent.
- **Unknown-sized exploration.** You don't know how many files you'll have to read to answer "where does X get
  initialized?" — cap the blast radius by handing it to a child.
- **Fan-out.** Two or more independent questions/tasks that don't depend on each other. Multiple `subagent` calls in
  one assistant turn run concurrently (see `subagent-background`).
- **Cheaper model is enough.** The subtask is mechanical (grep, count, list files, summarize a doc). Push it to a
  weak local model via `modelOverride` while the parent stays on a stronger model.
- **Planning before coding.** Non-trivial change on an unfamiliar codebase — let the `plan` agent produce a file-level
  plan you can execute inline.
- **Dangerous or experimental changes.** An agent with `isolation: worktree` gives you a sandbox the parent workspace
  never sees until you decide to apply it.

Do NOT delegate when:

- You already have the file open / know the exact lines. Spawning a child to do `read path --offset N --limit 40` is
  pure overhead.
- The task needs **the parent's in-memory context** (prior tool results, user clarifications, unsaved reasoning). The
  child starts from zero — explaining all that in `task` is more expensive than doing it inline.
- The task is **one tool call**. A single `rg` or `read` is cheaper than spawning a session.
- You are a subagent. Nesting is disabled by design — the `subagent` tool is not exposed to children.

## Pick the right agent type

| Agent             | Tools                     | Thinking | Typical task                                                      |
| ----------------- | ------------------------- | -------- | ----------------------------------------------------------------- |
| `explore`         | `read`, `grep`, `find`, `ls` | low      | "Where is X defined? List all callers. Summarize this module."    |
| `plan`            | `read`, `grep`, `find`, `ls` | medium   | "Plan how to add rate-limiting to /api/search."                   |
| `general-purpose` | `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` | medium | "Add a feature and run the tests."                                |

Rules of thumb:

- Start with `explore` for any read-only question. It's the cheapest and can't damage the tree.
- Reach for `plan` before a multi-file change — a file-level plan in the parent is worth more than three rounds of
  "wait, which file?".
- Use `general-purpose` only when the child actually needs to write or run commands. Don't give it write access as
  insurance.

Run `/agents` in pi to see the currently loaded agents and their frontmatter.

## Writing the `task`

The child session starts **completely fresh**. No chat history, no prior tool output, no memory of what you've
already read. Everything it needs must be in the `task` string.

Structure every `task` with these four pieces:

1. **Goal** — one sentence saying what done looks like.
2. **Constraints** — paths to look in, paths to ignore, files that are off-limits, conventions to follow.
3. **Known context** — the handful of paths / symbols / line numbers you've already found. Saves the child from
   re-discovering them.
4. **Expected answer shape** — exactly what you want back. A list? A path + line number? A short plan? JSON?

### Good `task`

```
Find every call site of `searchHandler` in src/ and list each as
`path:line — <one-line description of the surrounding block>`.
Ignore dist/, node_modules/, and any *.test.ts files.
Known: `searchHandler` is defined at src/api/search.ts:412.
Return a bullet list, most-used file first.
```

### Bad `task`

```
look at the search code and tell me about it
```

The bad version forces the child to guess what "the search code" means, pick an arbitrary depth of exploration, and
invent an output shape. You'll get something, but it won't be what you needed.

### Tips

- **Lead with the deliverable.** "Produce a list of …" beats "please investigate …". Weak models especially lock onto
  the first directive.
- **Paste paths literally.** `src/api/search.ts:412` is cheaper to ground on than "the search handler somewhere in
  the api folder".
- **Cap the scope.** "Look only in `src/api/**/*.ts`" prevents the child from wandering into `external/`.
- **State what NOT to do.** "Do not edit files" for exploration tasks; "Do not run migrations" for db work.
- **Forbid recursion explicitly** if the child might try: "You cannot call `subagent`." (It can't — but saying so
  short-circuits attempts that burn turns.)

## `modelOverride` — push grunt work to cheap models

`modelOverride: "provider/model-id"` runs the child on a different model than the parent. The pattern that matters
for weak local models:

- **Parent on a strong model** (Claude, GPT, a big local model) handles reasoning, tool choice, and final synthesis.
- **Child on a weak/cheap model** (qwen3-6-35b-a3b, gpt-oss-20b, etc.) handles mechanical enumeration: grep, file
  listing, counting, "does this file import X?".

When to use it:

- The task is a **closed-form lookup**: "list every file matching …", "return the line number of …".
- The output is **small and structured**: a list, a count, a boolean, a single path.
- The child needs **no judgment**. If the answer requires weighing trade-offs, keep the parent's model.

When NOT to use it:

- Planning, design, or anything with "should we …?" in the prompt. Weak models will confidently pick wrong.
- Tasks that need tool-call accuracy (multi-step edits). The `tool-arg-recovery` / `verify-before-claim` extensions
  help, but strong models still win on complex tool use.
- When the child's answer will be fed straight back into a critical decision. Round-trip through the parent first.

Pair `modelOverride` with `returnFormat: "json"` and a strict schema in `task` when you need machine-readable output
from a model that loves to narrate.

## `returnFormat: "json"` — structured handoffs

Set `returnFormat: "json"` and the harness parses the child's final answer as JSON before returning. If parsing
fails, you get the raw text plus an error flag — not a crash.

Use this when:

- You'll iterate over the result (`items.forEach(...)`-style).
- You're fanning out to multiple children and need to merge results.
- The child is on a weak model and you want the harness to catch prose-leakage.

Inside `task`, specify the schema literally:

```
Return a JSON object of the form:
{ "callers": [{ "path": "...", "line": 123, "context": "..." }] }
Do not include prose before or after the JSON.
```

## Isolation

Every agent declares `isolation: shared-cwd` or `isolation: worktree`:

- **`shared-cwd`** (default for `explore` / `plan` / `general-purpose`) — child writes land in the parent's tree. Fast
  and simple; be careful with destructive tasks.
- **`worktree`** — child runs in a temporary git worktree. Use for risky refactors, experiments, or "try this and
  show me the diff" tasks. The parent sees the diff in the child's final answer.

You don't pass isolation at call time — it's baked into the agent definition. If you need worktree isolation and
the agent you want is `shared-cwd`, either author a new agent or do the work inline with clear rollback.

## Anti-patterns

- **Don't delegate a single tool call.** `rg -n foo` inline is one tool call; a subagent for the same question is a
  full session spin-up. Break-even is somewhere around "I'd need to read 3+ files to answer this."
- **Don't re-explain the parent's entire context** in `task`. If the task needs that much setup, it probably belongs
  inline.
- **Don't use `general-purpose` as a default.** Write access is a liability for read-only questions. Start with
  `explore`.
- **Don't chain subagents serially when they're independent.** Spawn them in the same turn — they run concurrently.
- **Don't abandon background children.** If you spawned with `run_in_background: true`, finish the handshake (see
  `subagent-background`). Orphans consume tokens until they exit.
- **Don't trust weak-model output without verification.** When you used `modelOverride` to downgrade, spot-check
  one or two claims with `rg` before acting on the full list.
- **Don't nest.** Subagents can't call `subagent`. If you're inside a child, return to the parent and let it fan out.

## Quick reference

| Situation                                                        | Move                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| "Where is X in this codebase?"                                   | `subagent` → `explore`                                       |
| "Plan how to add feature Y"                                      | `subagent` → `plan`                                          |
| "Add feature Y and run tests"                                    | `subagent` → `general-purpose` (or do inline + call tests)   |
| "List every file matching pattern P" (mechanical)                | `subagent` → `explore` + `modelOverride` to a cheap model    |
| "Gather data from 3 independent places"                          | 3× `subagent` in one turn (fan-out)                          |
| "Need a diff I can throw away"                                   | worktree-isolated agent                                      |
| "One `rg` answers it"                                            | Inline `bash rg`, no subagent                                |
| "I already have the file open"                                   | Inline `read` with `offset` / `limit`                        |
| "I need structured output to iterate on"                         | `returnFormat: "json"` + schema in `task`                    |
