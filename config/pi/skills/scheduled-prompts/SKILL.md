---
name: scheduled-prompts
description:
  'WHAT: Decide when to fire a prompt at yourself on a timer with the `schedule` tool, and which trigger to pick -
  recurring (cron / interval), one-shot (in / at), or activity-anchored idle (after). WHEN: A session should act without
  a manual nudge - a cadence ping, a future reminder, or a roleplay character that keeps a scene alive. DO-NOT: Schedule
  something the user could just ask for now, or persist a schedule the user did not ask to outlive the session.'
---

# Scheduled prompts

The `schedule` tool (and `/schedule` command) fires a prompt at the agent on a timer, exactly as if the user typed it. A
fired prompt re-enters the session as a synthetic user turn, so you act on it like real input. Use it when a session
should do something on a cadence, at a future moment, or during idle gaps - without the user nudging each time. This
skill is the policy for when scheduling is worth it and which trigger fits.

## When to use this skill

Schedule a prompt when the session should act on its own:

- **Recurring cadence** - "summarize what changed every 30 minutes", a 9am morning report. Use `interval` (`--every`)
  for a fixed gap from creation, or `cron` (`--cron`) for wall-clock times.
- **A future one-shot** - "remind me to stretch in 10 minutes", "at 17:00 wrap up". Use `once` (`--in <dur>` for a
  delay, `--at <HH:MM>` for the next clock time).
- **Keeping a scene alive** - a roleplay character that should speak during silence. Use `after` (`--after <min-max>`),
  the activity-anchored idle nudge.

Do NOT schedule when:

- **The user is asking for something now.** Just do it this turn. A schedule is for later or repeated action, not a
  detour for the current request.
- **A human reminder is better.** If the user themselves should be pinged outside pi, say so - the schedule fires the
  _agent_, not a notification to the person away from the terminal.
- **You would persist without being asked.** Both the tool and `/schedule` default to `session` scope (dies with the
  session). Only pass `--scope global` / `--scope project` when the user wants it to outlive this session - a stray
  global schedule fires in _every_ future session.

## Pick the trigger

Exactly one trigger per schedule:

| Need                             | Trigger    | Flag                 | Notes                                                 |
| -------------------------------- | ---------- | -------------------- | ----------------------------------------------------- |
| Fixed cadence from now           | `interval` | `--every 30m`        | Anchored on creation.                                 |
| Wall-clock times (daily, hourly) | `cron`     | `--cron "0 9 * * *"` | 5-field, local time, numeric. Quote the expression.   |
| Once after a delay               | `once`     | `--in 10m`           | Fires once, then retires.                             |
| Once at the next clock time      | `once`     | `--at 17:00`         | Next local `HH:MM`.                                   |
| Fill idle silence (roleplay)     | `after`    | `--after 30s-5m`     | Random gap after last activity; idle-only; backs off. |

## Workflow

1. **Confirm a timer is the right tool.** Re-check the ask-now test above. If the action is for _now_, skip scheduling.
2. **Choose the trigger** from the table. Recurring vs one-shot vs idle is the core decision.
3. **Choose the scope deliberately.** Default `session` unless the user wants persistence. `project` writes
   `<cwd>/.pi/scheduled-prompts.json`; `global` writes `~/.pi/agent/scheduled-prompts.json`.
4. **Bound unattended schedules.** Add `--max-runs N` so a recurring or idle schedule cannot fire forever. Add
   `--chance <0..1>` for organic unpredictability and `--jitter <dur>` so multiple sessions sharing a persisted file do
   not stampede.
5. **Tune idle nudges (`after`).** It resets when the user speaks, re-anchors after each agent reply, and widens the gap
   (x2 per unanswered fire, capped x8) during silence. Give it a prompt pool (`-- look around | hum a tune`) so the
   nudge varies; use `${t}` (elapsed since anchor) / `${d}` (current time) for context-aware prompts.
6. **Manage existing schedules.** The tool supports `create` / `list` / `update` / `delete`. The user-facing
   `/schedules` lists them; `/schedules on|off <id>` toggles without deleting; `/schedules cancel <id>` removes one;
   `/schedules clear [scope]` clears a scope.

## Recurring vs one-shot vs idle

- **Recurring (`interval` / `cron`)** keeps firing on a schedule until cancelled or `--max-runs` retires it. Reach for
  it for periodic reports and cadence pings. Prefer `cron` when the time of day matters, `interval` when only the gap
  matters.
- **One-shot (`once`)** fires exactly once and removes itself. Reach for it for reminders and "do X later". A one-shot
  whose time passed while pi was closed still fires on the next start; a missed _recurring_ fire is skipped, not fired
  late.
- **Idle (`after`)** is special: it fires only while the agent is idle, re-anchors to conversation activity, and backs
  off during silence. It is built for keeping a roleplay scene alive, not for precise timing.

## Common pitfalls

- **Persisting by accident.** Forgetting scope leaves it `session`, which is usually right - but a deliberate
  `--scope global` that the user did not ask for pollutes every future session. Confirm intent before persisting.
- **Unbounded idle nudges.** An `after` schedule with no `--max-runs` keeps nudging an unattended session forever. Bound
  it.
- **Using a schedule for a now-action.** If the next thing is for this turn, do it inline.
- **Two pi instances, one file.** Each process arms its own timer, so a shared `global` / `project` schedule can fire in
  both. Documented limitation - account for it before relying on exactly-once persisted fires.

## Related docs

- [`scheduled-prompts.md`](../../extensions/scheduled-prompts.md) - full reference: triggers, options, prompt variables,
  scopes, scheduler internals.
- [`notes-decision-tree`](../notes-decision-tree/SKILL.md) - durable cross-session facts belong in `memory`, not a
  recurring self-reminder.
