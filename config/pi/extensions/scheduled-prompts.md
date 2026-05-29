# `scheduled-prompts.ts`

Fire recurring or one-shot prompts at the agent on a timer, the way you would type them yourself. A fired prompt is
delivered through `pi.sendUserMessage`, which always triggers a turn even when the agent is idle, so it lands exactly
like user input.

## Why

Some sessions want the agent to act without a manual nudge:

- **Roleplay** - the character keeps the conversation going on a cadence instead of waiting for you every line.
- **Morning report** - leave pi running overnight and have it summarize your inbox / calendar / repo at 9am.
- **Periodic ping** - "summarize what changed" every 30 minutes during a long working session.
- **Reminder** - a one-shot "time to stretch" 10 minutes from now.

Claude Code exposes a similar scheduling affordance; this extension brings it to pi with cron, intervals, and one-shots.

## Triggers

Exactly one trigger per schedule, each with an optional `--jitter`:

| Trigger    | Flag            | Meaning                                               |
| ---------- | --------------- | ----------------------------------------------------- |
| `cron`     | `--cron "..."`  | 5-field cron expression in local time (numeric only). |
| `interval` | `--every <dur>` | Fixed cadence anchored on creation, e.g. `30m`.       |
| `once`     | `--in <dur>`    | One-shot after a delay, e.g. `10m`.                   |
| `once`     | `--at <HH:MM>`  | One-shot at the next local `HH:MM`.                   |

Durations are `<number><unit>` segments (`s`, `m`, `h`, `d`) and may combine (`1h30m`). The cron parser supports `*`,
step (`*/15`), ranges (`9-17`), step-ranges (`0-30/5`), and lists (`9,12,17`); day-of-week accepts `0`-`7` (both `0` and
`7` are Sunday). When both day-of-month and day-of-week are restricted, a day matches if either matches (classic cron).

**Jitter** shifts each computed fire time forward by a random `[0, jitter)` amount, so multiple sessions sharing a
persisted schedule don't stampede at the same instant. Jitter only ever delays, never advances.

## Scopes

| Scope     | Storage                              | Lifetime                         |
| --------- | ------------------------------------ | -------------------------------- |
| `global`  | `~/.pi/agent/scheduled-prompts.json` | Every session, until cancelled.  |
| `project` | `<cwd>/.pi/scheduled-prompts.json`   | This workspace, until cancelled. |
| `session` | in-process only                      | Dies when this session ends.     |

The `/schedule` command defaults to `global` (explicit user intent to persist). The `schedule` tool defaults to
`session` so the agent's self-scheduling is ephemeral unless asked otherwise.

## Commands

- `/schedule <trigger> [options] -- <prompt>` - create a schedule. With no arguments, prints usage.
  - Options: `--jitter <dur>`, `--scope global|project|session`, `--name "<label>"`.
  - The prompt is everything after a bare `--`. Quote multi-token values like the cron expression.
  - Example: `/schedule --cron "0 9 * * *" --jitter 5m --scope global --name "morning report" -- summarize my day`
- `/schedules` - list all schedules, grouped by scope, with next-fire times and run counts.
  - `/schedules cancel <id>` - remove one schedule.
  - `/schedules clear [global|project|session|all]` - remove a whole scope (default `all`).
  - `/schedules on <id>` / `/schedules off <id>` - enable/disable without deleting.

## Tool

The `schedule` tool lets the agent manage its own schedules (e.g. a roleplay character queues its next beat):

- `create` - `{ prompt, one of cron|every|in|at, jitter?, scope?, name? }`
- `list` - render the current schedules.
- `update` - `{ id, prompt?|name?|enabled?|jitter?|<trigger> }`
- `delete` - `{ id }`

Tool-created schedules default to `session` scope.

## Scheduler internals

Each schedule caches its next fire instant in `nextFireAt`, computed once at creation, on enable, and after each fire,
then persisted. A single `setTimeout` is armed for the soonest `nextFireAt` across all scopes; on fire, due schedules
are delivered, one-shots are removed, recurring schedules get `lastRunAt` / `runCount` bumped and a fresh `nextFireAt`,
and the timer re-arms for the next soonest. Delays beyond `setTimeout`'s ~24.8-day ceiling are capped and re-armed.

When pi starts and a recurring schedule's cached fire is in the past (missed while pi was closed), it is recomputed from
"now" - the missed fire is skipped rather than fired late. A one-shot whose time passed while pi was closed still fires
on the next start.

The timer handle and the ephemeral session schedules live in a process-global slot
([`global-slot.ts`](../../../lib/node/pi/global-slot.ts)) so `/reload` (which re-instantiates the extension) clears the
stale timer and re-arms cleanly, while session schedules survive the reload and only die on a real session end.

Pure logic - cron, durations, the schedule model, the command parser, and persistence - lives in unit-tested helpers
under [`lib/node/pi/scheduled-prompts/`](../../../lib/node/pi/scheduled-prompts/); this file holds only the pi-coupled
glue (timers, delivery, command/tool registration).

## Known limitation

Timers live in each pi process. If two pi instances share the same `global` or `project` file, both arm timers and a
schedule can fire in each. v1 documents this rather than solving it; a future owner-pid lockfile could de-dupe.

## Environment variables

- `PI_SCHEDULED_PROMPTS_DISABLED=1` - skip the extension entirely (no commands or tool registered).
- `PI_SCHEDULED_PROMPTS_DEBUG=1` - log scheduler decisions (arm / fire) to stderr.

## Hot reload

Edit [`extensions/scheduled-prompts.ts`](./scheduled-prompts.ts) or the helpers under
[`lib/node/pi/scheduled-prompts/`](../../../lib/node/pi/scheduled-prompts/) and run `/reload` in an interactive pi
session to pick up changes without restarting. Session-scope schedules survive the reload.
