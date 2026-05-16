# `bash-exit-watchdog.ts`

Re-surfaces bash non-zero exit codes that small models miss because pi's built-in `Command exited with code N` marker
lives at the tail of the output - often after 50 KB of stdout and a
[`tool-output-condenser`](./tool-output-condenser.md) condensation note. Without help the model carries on as if the
command succeeded.

## What it does

On every `tool_result` where `isError: true` and the tool was `bash`:

1. Parse the exit code out of the trailing marker via [`parseExitCode`](../../../lib/node/pi/bash-exit-watchdog.ts).
   Bail if zero / unparseable.
2. Check the command string against the suppress list ([`shouldSuppress`](../../../lib/node/pi/bash-exit-watchdog.ts)).
   Built-in defaults cover commands where non-zero exit is routine (e.g. `grep` with no matches, `diff` with
   differences).
3. If not suppressed, prepend an unmissable warning header to the first text part via
   [`formatWarning`](../../../lib/node/pi/bash-exit-watchdog.ts). Pi's original output is preserved below and the rest
   of the content parts are passed through untouched.

The rewrite shape is `{ content: [{ type: 'text', text: '<warning>\n<original>' }, ...event.content.slice(1)] }`, which
chains cleanly with [`tool-output-condenser.ts`](./tool-output-condenser.md) - condensation applies to the body, the
short header rides through intact.

Complements [`verify-before-claim.ts`](./verify-before-claim.md): that extension catches "tests pass" claims without
backing evidence; this one catches the upstream case where the model never noticed the command failed in the first
place.

## Config

User rules live at `~/.pi/agent/exit-watchdog.json` or project `.pi/exit-watchdog.json`, merged on top of the built-in
defaults:

```json
{
  "suppress": [{ "commandPattern": "^./migrations/\\d+", "exitCodes": [3] }]
}
```

`commandPattern` is a regex tested against the exact `command` string pi sent. `exitCodes` is the list of exits to
suppress for that pattern; an empty list means "suppress every non-zero exit". Config is loaded once per `session_start`
and cached; parse / IO failures surface as a single `ctx.ui.notify` warning (never re-notified for the same path + error
pair).

## Environment variables

- `PI_EXIT_WATCHDOG_DISABLED=1` - skip the extension entirely.
- `PI_EXIT_WATCHDOG_DEBUG=1` - `ctx.ui.notify` every decision (flagged / suppressed).
- `PI_EXIT_WATCHDOG_TRACE=<path>` - append one line per decision to `<path>`. Useful in `-p` / RPC mode.

## Hot reload

Edit [`extensions/bash-exit-watchdog.ts`](./bash-exit-watchdog.ts) or
[`lib/node/pi/bash-exit-watchdog.ts`](../../../lib/node/pi/bash-exit-watchdog.ts) and run `/reload` in an interactive pi
session to pick up changes without restarting.
