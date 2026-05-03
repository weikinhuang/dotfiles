---
name: subagent-background
description: >-
  Run subagents asynchronously with `run_in_background: true` and manage them with `subagent_send` (status / wait /
  steer / abort). Use when you want to fan out work, hide latency behind other steps, or keep the parent responsive
  while a long child runs. Covers the full lifecycle, when async beats sync, steering mid-run, abort criteria, and the
  "don't orphan children" rule. Pairs with `subagent-delegation` which covers WHEN and HOW to delegate at all.
---

# Subagent Background Lifecycle

`subagent({ run_in_background: true })` returns a handle immediately instead of blocking. The child keeps running in the
background — even across the parent turn boundary — and you retrieve its answer later with
`subagent_send({ to, action: "wait" })`. This skill is the lifecycle and the policy for when async is worth the extra
bookkeeping.

If you haven't decided whether to delegate at all, read `subagent-delegation` first.

## When background beats synchronous

Sync (`run_in_background: false`, the default) blocks the current assistant turn until the child finishes. The child
can't outlast the turn. That's fine for:

- A single quick exploration (<30s of child work).
- Anything where you literally cannot proceed without the result.

Go background when **any** of these is true:

- **Fan-out with work to do.** You want to spawn two or more children and use the parent's turn to make progress on
  something else while they run.
- **Latency-hiding.** The child is going to take a while; meanwhile you could be drafting code, running tests, or
  reading other files.
- **Cross-turn work.** The investigation is long enough that it would blow your turn budget or trigger a stall — let it
  run across multiple parent turns.
- **Exploratory "maybe I'll use this".** You want a second opinion or an alternative plan in parallel; finish your own
  attempt first, then compare.
- **Steerable tasks.** You expect to nudge the child mid-run (new constraint, narrower scope) via
  `subagent_send({ to, text: "..." })`.

Stay sync when:

- The child answer is the _immediate next input_ to your reasoning.
- You have nothing else to do while it runs.
- The task is short enough that polling overhead costs more than it saves.

## Fan-out pattern

Multiple `subagent` calls in a **single assistant turn** run concurrently. This is the cheapest way to parallelize:

```
Turn N (parent):
  subagent({ agent: "explore", task: "find callers of A", run_in_background: true })
  subagent({ agent: "explore", task: "find callers of B", run_in_background: true })
  subagent({ agent: "explore", task: "find callers of C", run_in_background: true })
  → returns three handles immediately

Turn N (parent, same turn):
  ... do other work inline ...

Turn N+1 (parent):
  subagent_send({ to: h1, action: "wait" })
  subagent_send({ to: h2, action: "wait" })
  subagent_send({ to: h3, action: "wait" })
  → merge results
```

If the tasks truly are independent and you have no inline work to do, you can also call them synchronously in the same
turn — the harness still runs them concurrently. Reach for `run_in_background` specifically when you want the parent
free to do something else, or when the children might outlast the turn.

## The handle

Every `subagent({ run_in_background: true })` call returns a short handle string (something like `c1`, `c2`, …).
**Record it the moment you get it.** Good places:

- `scratchpad` — "spawned `c1` to find callers of X; waiting."
- The `note` field on a `todo` review item — "parked pending `c1`".

Do NOT try to reconstruct handles from memory across compactions. If the scratchpad doesn't have it, list active
children with the `/agents running` surface or treat the work as lost and respawn.

## `subagent_send` actions

| Action              | Blocking? | Purpose                                                               |
| ------------------- | --------- | --------------------------------------------------------------------- |
| `status` (default)  | No        | Cheap snapshot: running / finished / aborted, plus turn count.        |
| `wait`              | Yes       | Block up to `timeoutMs` for the child to finish; return final answer. |
| `abort`             | No        | Cancel a running child. Final answer classified as `aborted`.         |
| (no action, `text`) | No        | Inject a user-role message into a running child to steer it.          |

Rules the harness enforces:

- `text` is **not combinable** with `action: "abort"`. Pick one.
- `text` on a **finished** child is rejected — steer only while running.
- `wait` on a finished child returns the stored answer instantly; safe to call repeatedly.
- Only the parent can call `subagent_send`. Subagents never see this tool.

## Polling loop pattern

For a single long-running child:

```
spawn → handle h
... do inline work ...
subagent_send({ to: h, action: "status" })   # cheap check
   → still running, do more inline work
subagent_send({ to: h, action: "wait", timeoutMs: 30000 })
   → final answer
```

For fan-out:

```
spawn h1, h2, h3 in one turn
... do inline work ...
for h in [h1, h2, h3]:
  subagent_send({ to: h, action: "wait" })
merge and act
```

Prefer `wait` with a generous `timeoutMs` over tight `status` polling — each `status` call burns a tool slot.

## Steering a running child

Use `subagent_send({ to, text })` to inject new guidance into a child that's still working. Good reasons:

- You discovered a constraint the child needs to honor ("ignore anything under external/").
- You realized the output shape you asked for was wrong ("return JSON, not prose").
- The child is about to waste turns on the wrong sub-problem ("stop reading search.ts; look at validate.ts instead").

The injected text appears to the child as a new user-role message. Write it the same way you'd write a clarifying reply
in chat — short, imperative, paste any paths literally.

Do NOT use steering as a replacement for a better initial `task`. If you're steering on every spawn, tighten the prompt
(see `subagent-delegation` → Writing the `task`).

## Abort criteria

Abort a background child when:

- The task is obsolete. The user changed direction, or the parent already solved it inline.
- The child is clearly stuck (repeated reads of the same file, no progress across multiple `status` checks, turn count
  climbing with no output growth).
- You spawned the wrong agent type and steering won't fix it (e.g., you need write access but spawned `explore`).

`subagent_send({ to, action: "abort" })` is the clean exit. Don't just stop calling `wait` and hope it dies — background
children survive turn boundaries and keep consuming until they abort, finish, or time out.

## The "don't orphan children" rule

Every background handle you receive is a commitment. Before ending your assistant turn, for every live handle you
spawned:

- `wait` on it (if you need the answer), OR
- `status` it and note in `scratchpad` that you'll check next turn, OR
- `abort` it (if obsolete).

Silently moving on and never touching a handle again is the worst outcome:

- The child keeps burning tokens until it hits its own turn cap.
- Its final answer ends up in a tempfile the parent never reads.
- Future turns get cluttered with "running" entries in the injected status block.

A quick audit at the end of each turn — "any live handles I haven't resolved?" — catches this.

## Combining with `todo` and `scratchpad`

Background work and planning tools compose naturally:

- Move the corresponding todo to `review` with a note like "parked on `c1`" when you spawn.
- `complete` the todo only after `wait` returns and you've verified the answer.
- Keep handle → task mapping in `scratchpad` so you can re-attach after compaction:
  `c1 = explore callers of searchHandler (src/api/search.ts:412)`.

## Anti-patterns

- **Don't spawn background children you have nothing to do with.** If you'll just `wait` immediately, spawn sync.
  Background is for latency-hiding, not syntax sugar.
- **Don't tight-poll with `status`.** One `status` between substantial inline work is fine; a `status` every line of
  reasoning is pure waste. Use `wait` with a timeout instead.
- **Don't steer on every turn.** If you're injecting text more than once or twice, the original `task` was wrong — abort
  and respawn with a better prompt.
- **Don't forget handles exist across turns.** Unlike sync children, background children outlive the turn that spawned
  them. Treat them like open file descriptors.
- **Don't race children against the user.** If the user is typing a follow-up, a background explorer can deliver its
  answer mid-conversation and derail the thread. Abort or `wait` before pivoting direction.
- **Don't spawn a child per file.** If you're about to loop `for each file: subagent(...)`, write one `task` that
  handles the batch, or fan out with a handful of children covering ranges — not dozens.

## Quick reference

| Goal                                       | Move                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| Spawn and keep working                     | `subagent({ run_in_background: true, ... })`, record handle              |
| Cheap progress check                       | `subagent_send({ to, action: "status" })`                                |
| Block for the final answer                 | `subagent_send({ to, action: "wait", timeoutMs: 30000 })`                |
| Push a new constraint into a running child | `subagent_send({ to, text: "also ignore external/" })`                   |
| Cancel a running child                     | `subagent_send({ to, action: "abort" })`                                 |
| Fan out 3 independent explorations         | 3× `subagent({ run_in_background: true })` in one turn, `wait` next turn |
| Never again for this handle                | `abort` or `wait` — don't orphan                                         |
