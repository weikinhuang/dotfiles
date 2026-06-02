---
name: background-bash
description:
  'WHAT: Decide when to run a shell command off-turn with the `bg_bash` tool instead of blocking the turn on the
  built-in `bash` tool, and how to poll / steer / collect it across turns. WHEN: A command is long-running (dev server,
  build, watch, test suite, training run, log tail) or you want the turn free while it runs. DO-NOT: Background a quick
  command whose output you need immediately, spawn a job you never poll, or use it for pure computation - that is
  `compute`.'
---

# Background bash

The built-in `bash` tool blocks the assistant turn until the command exits. `bg_bash` spawns the command off-turn,
returns a job id immediately, and exposes one multi-action tool (`start`, `list`, `status`, `logs`, `wait`, `signal`,
`stdin`, `remove`) you drive across later turns to poll, steer, and collect output. Reach for it when a command outlives
the moment you launch it - or when you would rather keep working than sit on a blocking call.

## When to use this skill

Use `bg_bash` `start` when at least one of these is true:

- **The command does not terminate on its own.** Dev servers, file watchers, `tail -f`, `npm run dev`, queue workers.
  These would hang a blocking `bash` call forever.
- **The command is slow and you have other work.** A full build, a long test suite, a training run, a large download.
  Background it, make progress inline, then `wait` for it.
- **You want to watch progress over several turns.** `logs` with a `sinceCursor` lets you resume the stream without
  re-reading from the top.
- **The command may need steering.** A REPL or installer that reads stdin - pass `interactiveStdin: true` and feed it
  with the `stdin` action.

Stay on the built-in `bash` tool when:

- The command is quick (a `git status`, a one-shot test file, an `ls`) and you need its output to decide the next step.
  Backgrounding it just adds a poll round-trip.
- You cannot proceed without the result. If the very next thing you do consumes the output, block on `bash`.
- The work is pure calculation or data shaping. That is the `compute` tool, not a shell at all - see
  [`compute-over-bash`](../compute-over-bash/SKILL.md).

## Workflow

1. **Start the job.** `bg_bash` `start` with `command` (and `cwd` / `label` / `env` if needed). It returns a job id and
   the job begins running detached. Record the id - you need it for every later action.
2. **Do inline work.** The turn is yours again. Draft code, read files, start other jobs.
3. **Check cheaply when you want a pulse.** `bg_bash` `status` with the id is a single-line snapshot (running / exited,
   duration, bytes). Do not tight-poll - one `status` between substantial inline work, not one per line of reasoning.
4. **Read output incrementally.** `bg_bash` `logs` with the id. Use `tail: N` for the last N lines, `grep` to filter,
   and `sinceCursor` (the opaque cursor from a prior `logs` call) to resume without re-reading. If the response sets
   `droppedBefore: true`, the ring buffer evicted that range - fall back to the on-disk `logFile` it names.
5. **Block when you actually need the result.** `bg_bash` `wait` with a generous `timeoutMs` (default 15000). It returns
   when the job exits, or `timedOut: true` if still running - then loop or keep working.
6. **Stop or clean up.** `bg_bash` `signal` (default `SIGTERM`) kills a live job and its process group. `bg_bash`
   `remove` drops a terminal job from the registry - it refuses live jobs, so signal first.

## Steering interactive jobs

A job started with `interactiveStdin: true` gets a writable stdin. Feed it with `bg_bash` `stdin` (`text`, optional
`eof` to close the stream after writing). Without `interactiveStdin`, stdin is `/dev/null` and any `stdin` action
errors - this is the default so non-interactive commands that incidentally read stdin see EOF instead of hanging.

## Do not orphan jobs

Every job id you start is a commitment. Jobs live for the pi session and survive turn boundaries; a forgotten dev server
keeps running and burning resources. Before ending a turn, for each live job: `wait` on it (if you need it), note in
`scratchpad` that you will check it next turn, or `signal` it (if obsolete). On `session_shutdown` pi sends every live
job `SIGTERM`, waits `PI_BG_BASH_KILL_GRACE_MS` (default 3000), then `SIGKILL` - but that is a backstop, not your exit
plan.

## Common pitfalls

- **Backgrounding a quick command, then immediately `wait`ing.** That is a blocking `bash` call with extra steps. If you
  will wait right away, use `bash`.
- **Tight `status` polling.** Each call burns a tool slot. Prefer one `wait` with a real `timeoutMs` over a stream of
  `status` checks.
- **Forgetting the job id across a compaction.** Stash `id -> what it runs` in `scratchpad` so you can re-attach.
- **Expecting state to persist across pi restarts.** Jobs are session-scoped. A restart leaves only `exited` / `error`
  history; live jobs from a dead runtime are pruned.
- **Reaching for `bg_bash` to compute.** No filesystem-free sandbox here - it is a real shell. Pure math / JSON reshape
  belongs in `compute`.

## Related docs

- [`bg-bash.md`](../../extensions/bg-bash.md) - full tool reference: every action, log buffering, signals, env vars.
- [`compute-over-bash`](../compute-over-bash/SKILL.md) - route pure computation to `compute` instead of any shell.
- [`subagent-background`](../subagent-background/SKILL.md) - the analogous lifecycle for background subagents.
