# `scheduled-prompts.ts`

Fire recurring, one-shot, or activity-anchored idle prompts at the agent on a timer, the way you would type them
yourself. A fired prompt is delivered through `pi.sendUserMessage`, which always triggers a turn even when the agent is
idle, so it lands exactly like user input.

## Why

Some sessions want the agent to act without a manual nudge:

- **Roleplay** - the character keeps the conversation going on a cadence instead of waiting for you every line.
- **Morning report** - leave pi running overnight and have it summarize your inbox / calendar / repo at 9am.
- **Periodic ping** - "summarize what changed" every 30 minutes during a long working session.
- **Reminder** - a one-shot "time to stretch" 10 minutes from now.

Claude Code exposes a similar scheduling affordance; this extension brings it to pi with cron, intervals, one-shots, and
an activity-anchored idle nudge.

## Triggers

Exactly one trigger per schedule. The time-based triggers take an optional `--jitter`:

| Trigger    | Flag                | Meaning                                                                      |
| ---------- | ------------------- | ---------------------------------------------------------------------------- |
| `cron`     | `--cron "..."`      | 5-field cron expression in local time (numeric only).                        |
| `interval` | `--every <dur>`     | Fixed cadence anchored on creation, e.g. `30m`.                              |
| `once`     | `--in <dur>`        | One-shot after a delay, e.g. `10m`.                                          |
| `once`     | `--at <HH:MM>`      | One-shot at the next local `HH:MM`.                                          |
| `after`    | `--after <min-max>` | Idle nudge: a random gap after the last activity (see below), e.g. `30s-5m`. |

Durations are `<number><unit>` segments (`s`, `m`, `h`, `d`) and may combine (`1h30m`). A range like `30s-5m` is two
durations around a `-`. The cron parser supports `*`, step (`*/15`), ranges (`9-17`), step-ranges (`0-30/5`), and lists
(`9,12,17`); day-of-week accepts `0`-`7` (both `0` and `7` are Sunday). When both day-of-month and day-of-week are
restricted, a day matches if either matches (classic cron).

**Jitter** shifts each computed fire time forward by a random `[0, jitter)` amount, so multiple sessions sharing a
persisted schedule don't stampede at the same instant. Jitter only ever delays, never advances.

## Activity-aware nudges (`after`)

The `after` trigger is built for a roleplay character that should feel alive: it fires a random gap (`--after 30s-5m`)
after the conversation last had activity, and **keeps firing during silence** so the scene never stalls.

- **Resets when you speak.** An interactive user message restarts the countdown from the base window.
- **Re-anchors after the agent replies.** When a turn ends, the next nudge is measured from that moment, so a beat never
  lands while the agent is still talking.
- **Backs off during silence.** Each consecutive unanswered fire widens the random window (x2 per fire, capped at x8) so
  the character gradually eases off instead of spamming. The backoff resets the moment you reply.
- **Idle-only.** `after` fires only while the agent is idle; if a turn is in progress the fire is deferred, not
  interrupted. (This is the `--when-idle` default for `after`; use `--interrupt` to override.)
- **Bound it** with `--max-runs N` (retire after N fires) so an unattended session can't nudge forever.

Self-fires re-enter pi as input from the `extension` source and are ignored for activity tracking, so a nudge never
resets or re-triggers off itself.

## Options

Apply to any trigger:

- `--max-runs <n>` - retire the schedule after `n` fires.
- `--chance <0..1>` - only fire with this probability when due (organic unpredictability); a miss silently re-arms.
- `--reset-on-activity` - restart the timer on each interactive user message (default on for `after`).
- `--when-idle` / `--interrupt` - only fire while idle, or allow firing mid-turn (default idle-only for `after`).
- **Prompt pool** - give several prompts separated by `|` after the `--`; each fire picks one (random by default, or in
  order with `--round-robin`) so a recurring nudge varies. Example: `-- look around | hum a tune | check your phone`.

## Scopes

| Scope     | Storage                              | Lifetime                         |
| --------- | ------------------------------------ | -------------------------------- |
| `global`  | `~/.pi/agent/scheduled-prompts.json` | Every session, until cancelled.  |
| `project` | `<cwd>/.pi/scheduled-prompts.json`   | This workspace, until cancelled. |
| `session` | in-process only                      | Dies when this session ends.     |

Both the `/schedule` command and the `schedule` tool default to `session`, so a schedule is ephemeral unless you pass
`--scope global` / `--scope project` (or `scope` on the tool) to persist it across sessions.

## Commands

- `/schedule <trigger> [options] -- <prompt>` - create a schedule. With no arguments, prints usage.
  - Options: `--jitter <dur>`, `--scope global|project|session`, `--name "<label>"`, `--max-runs <n>`,
    `--chance <0..1>`, `--reset-on-activity`, `--when-idle` / `--interrupt`, `--round-robin`.
  - The prompt is everything after a bare `--`; split a pool of alternatives with `|`. Quote multi-token values like the
    cron expression.
  - Example: `/schedule --cron "0 9 * * *" --jitter 5m --scope global --name "morning report" -- summarize my day`
  - Roleplay example: `/schedule --after 30s-5m -- glance out the window | hum a tune | ask what they're thinking`
- `/schedules` - list all schedules, grouped by scope, with next-fire times and run counts.
  - `/schedules cancel <id>` - remove one schedule.
  - `/schedules clear [global|project|session|all]` - remove a whole scope (default `all`).
  - `/schedules on <id>` / `/schedules off <id>` - enable/disable without deleting.

## Tool

The `schedule` tool lets the agent manage its own schedules (e.g. a roleplay character queues its next beat):

- `create` - `{ prompt or prompts[], one trigger (cron|every|in|at|after), plus the same options as /schedule }`
- `list` - render the current schedules.
- `update` - `{ id, prompt?|prompts?|name?|enabled?|jitter?|maxRuns?|chance?|resetOnActivity?|whenIdle?|<trigger> }`
- `delete` - `{ id }`

Tool-created schedules default to `session` scope. A roleplay agent can keep itself alive with
`create { after: "30s-5m", prompts: ["...", "..."] }`.

## Scheduler internals

Each schedule caches its next fire instant in `nextFireAt`, computed once at creation, on enable, and after each fire,
then persisted. A single `setTimeout` is armed for the soonest `nextFireAt` across all scopes; on fire, due schedules
are delivered, one-shots are removed, recurring schedules get `lastRunAt` / `runCount` bumped and a fresh `nextFireAt`,
and the timer re-arms for the next soonest. Delays beyond `setTimeout`'s ~24.8-day ceiling are capped and re-armed.

When pi starts and a recurring schedule's cached fire is in the past (missed while pi was closed), it is recomputed from
"now" - the missed fire is skipped rather than fired late. A one-shot whose time passed while pi was closed still fires
on the next start.

Activity awareness rides on two pi events: an interactive `input` resets `after` (and any `--reset-on-activity`) timers
and clears backoff, while `turn_end` re-anchors idle nudges so the gap is measured after the agent's reply. The
process-global slot also tracks the last activity instant.

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
