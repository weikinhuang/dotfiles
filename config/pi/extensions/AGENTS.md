# Pi extensions

<!-- markdownlint-disable authoring-guide-doc-size-budget -->

Conventions for extensions under [`../extensions/`](../extensions/) - the `.ts` extension shells loaded via
[`../settings-baseline.json`](../settings-baseline.json). See [README.md](./README.md) for the per-extension index and
root [AGENTS.md](../../../AGENTS.md) for repo-wide rules; this file documents only what is different in this directory.

## Commands

- `npm test` - vitest covers the pure helpers under [`../../../lib/node/pi/`](../../../lib/node/pi) plus the extension
  command-surface specs under [`../../../tests/config/pi/extensions/`](../../../tests/config/pi/extensions).
- `npm run tsc` - type-checks the whole lib surface **and** the extension `.ts` shells (`tsconfig.json` includes
  `config/pi/extensions/**` and `lib/node/pi/ext/**`; `@earendil-works/*` resolves from `node_modules`), so extension
  type errors surface at `tsc` time, not only at runtime.
- `pi -p "<scenario>" --no-session` - smoke-test actual extension behaviour headless. Add `--model <provider/id>` to run
  against a local small/weak model (the harder tool-call-precision case); omit it to use the current model. Headless
  `-p` loads the latest code on launch; in a live session run `/reload` after editing a `.ts`. See the
  `pi-extension-authoring` skill for the positive / negative / idempotency scenarios to exercise.
- Multi-turn headless: drive one long-lived `pi --mode rpc` process (feed JSONL `prompt` commands via a `bg_bash`
  `interactiveStdin` job; watch for the `agent_end` event per turn) - it keeps context in-process and uses pipes (no
  socket, so the sandbox is a non-issue). For shell scripts, respawn `pi --session-dir <tmp> --session-id <id> -p "..."`
  instead (resumes the persisted session each call; can't combine with `--no-session`). Full recipes in the skill.
- TUI surfaces (statusline, widgets, avatar, keybindings) never render under `-p`: drive them in a detached tmux pane
  via `tmux -S <sock> new-session -d "pi ..."` + `send-keys` / `capture-pane`. On Linux the `sandbox` extension blocks
  tmux's socket, so ask the user to `/sandbox-disable` for the session first (do **not** set `unixSockets.allowAll`).
  Full recipe in the `pi-extension-authoring` skill.

## Key patterns

### Pi-coupled glue lives here; pure helpers in `lib/node/pi/`; shared pi-importing helpers in `lib/node/pi/ext/`

An extension's own pi-coupled glue - its `pi.on(…)` handlers, command registration, tool `execute` bodies, UI/state
wiring - lives in `<name>.ts` here. Pure logic (reducers, parsers, path resolvers, formatters) belongs in
[`../../../lib/node/pi/`](../../../lib/node/pi) so it can be unit-tested with vitest and type-checked under the root
`tsconfig.json`. When an extension grows a chunk of pure logic, **extract it** rather than testing it indirectly through
the runtime.

Code that imports `@earendil-works/*` (pi-tui widgets, `pi-coding-agent` dialog flows) but is **shared across
extensions** - or extracted purely to shrink an oversized `.ts` so smaller models can work on it - goes in
[`../../../lib/node/pi/ext/`](../../../lib/node/pi/ext) instead, with its spec under
[`../../../tests/lib/node/pi/ext/`](../../../tests/lib/node/pi/ext). `ext/` is type-checked by the root `tsconfig.json`
and runs under the same relaxed oxlint override as this tree. Reach for it only when the helper genuinely needs a pi
import; anything that can stay pure belongs in `lib/node/pi/`. Anchors:
[`multi-select-list.ts`](../../../lib/node/pi/ext/multi-select-list.ts),
[`drop-confirm.ts`](../../../lib/node/pi/ext/drop-confirm.ts).

### `<name>.ts` + `<name>.md` pair

Every extension ships with a deep doc next to it (`bg-bash.ts` ↔ `bg-bash.md`, `deep-research.ts` ↔ `deep-research.md`).
The `.md` is the long-form reference for behaviour, env vars, and rule shapes; the `.ts` is the source of truth for
runtime behaviour. New extensions add both files **and** a row in [README.md](./README.md)'s index table in lockstep.

### Auto-injecting state every turn: `context` hook vs system prompt

Many extensions surface live state to the model every turn so it survives `/compact` and long contexts without the model
having to call `list`. **Pick the delivery mechanism by the block's volatility - this is a cache-correctness decision,
not a style choice.**

- **Volatile / often-empty / per-turn-changing state** (a plan, a job registry, a budget line) → inject via the
  **`context` hook** using [`applyContextReminder`](../../../lib/node/pi/context-reminder.ts). It splices an ephemeral
  `<system-reminder id="...">` into the last user/toolResult turn. Pi's `context` output builds only the outgoing
  provider payload and is **never persisted** (it operates on a `structuredClone`; the assistant reply is pushed to the
  real, untouched message array), so the **system prompt stays byte-stable** and the provider's prompt-prefix cache
  survives every state mutation. Nothing accumulates across turns. Return `undefined` (inject nothing) when the block is
  empty. The shape:

  ```ts
  pi.on('context', (event) => {
    const block = render(state); // null/undefined when there's nothing active
    if (!block) return undefined;
    const messages = applyContextReminder(event.messages as unknown as ReminderMessage[], {
      id: 'my-ext',
      body: block,
    });
    return { messages: messages as unknown as typeof event.messages };
  });
  ```

  Use a **unique `id`** per extension - the helper strips only blocks carrying that id, so injectors coexist. If the old
  `before_agent_start` handler also did per-turn side effects (refresh a captured `ctx.ui`, update a statusline), keep a
  side-effect-only `before_agent_start` and move **only** the injection to `context` (see `bg-bash.ts`, `comfyui.ts`).
  The `context`-hook `ctx` is the full `ExtensionContext` (e.g. `getContextUsage()` is available - see
  `context-budget.ts`). Anchors: `todo`, `bg-bash`, `comfyui`, `scratchpad`, `context-budget`.

- **Large + stable / always-present state** (e.g. saved memories) and **static prompt addenda** (persona, preset,
  color-tags, small-model addendum, avatar emote prompt) → keep appending to the **system prompt** via
  `before_agent_start` (return a `{ systemPrompt }` that concatenates the block onto `event.systemPrompt`). These sit in
  the cached prefix and are billed at the cache-read rate every unchanged turn; the bust-on-change downside rarely
  fires. **Do NOT move `memory` to the `context` hook** - an always-present block on the (uncached) tail is re-billed at
  full rate every turn, the opposite of the win.

The trap the `context` hook avoids: a volatile block in the system prompt rebuilds the prompt prefix on every mutation,
busting the cache for the whole request. `context-budget` was the worst case (its line embeds a live token count, so it
changed ~every turn past 50% usage). Rule of thumb: **if the block changes more often than the system prompt otherwise
would, it belongs on the tail.**

### Lifecycle

Any extension that **mounts a UI surface** (`ctx.ui.setHeader` / `setFooter` / `setWidget` / `setStatus` /
`setEditorComponent`), **holds a timer** (`setInterval` / `setTimeout`), **opens a watcher** (`fs.watch` / a websocket /
an event subscription), or **starts a child process** MUST register a `pi.on('session_shutdown', …)` handler that
releases that resource. `/reload` routes through `session_shutdown` → `session_start`, so anything left mounted or
ticking after shutdown leaks across the reload (a stale widget claiming a status slot, a spinner interval bound to a
replaced `ctx`, a child still draining stdout). The shutdown handler is the only teardown hook that fires on both
`/reload` and a real session end.

Rules for the handler:

- **Idempotent and never-throwing.** Wrap each risky release in its own `try/catch`; a shutdown handler that throws can
  wedge pi's exit. Clearing a UI slot you never mounted is a safe no-op, so unconditional `setStatus(key, undefined)` /
  `setWidget(key, undefined)` is fine.
- **Guard UI calls with `ctx.hasUI`.** In print / RPC / `--no-session` modes there is no UI to release.
- **Drop captured `ctx` and session-scoped state** (caches, registries, the last-seen `ctx.ui` ref) so the next
  `session_start` rebuilds from scratch instead of reusing a stale closure.
- **Don't add a handler for pure module-level constants or prompt addenda.** A `Map`/`Set` that is recomputed per call,
  a static prompt string, or a per-call config load holds no durable resource - a shutdown handler there only bloats the
  file without preventing a leak.

Reference implementations: [`bg-bash.ts`](./bg-bash.ts) (SIGTERM every live child with a grace window),
[`subagent.ts`](./subagent.ts) (abort + drain background children, cancel linger timers), [`avatar.ts`](./avatar.ts) /
[`waveform-indicator.ts`](./waveform-indicator.ts) (unmount widget + clear animation timers + reset state), and
[`scheduled-prompts.ts`](./scheduled-prompts.ts) (clear the pending timer, keeping session schedules across a `reload`
but dropping them on a real end).

### Configuration knobs

Two-level disable convention, both checked with the canonical [`envTruthy`](../../../lib/node/pi/parse-env.ts) helper --
never roll your own truthiness parse.

- **Extension-level disable:** `PI_<NAME>_DISABLED=1` skips the whole extension. Guard at the top of the factory, after
  imports, so nothing registers:

  ```text
  if (envTruthy(process.env.PI_<NAME>_DISABLED)) return;
  ```

  `<NAME>` is the extension's screaming-snake name (`PI_QUESTIONNAIRE_DISABLED`, `PI_LLAMA_THINKING_BUDGET_DISABLED`).
  Every extension exposes this.

- **Aspect-level disable:** `PI_<NAME>_DISABLE_<ASPECT>=1` turns off one feature (autoinjection, a guardrail, a prompt
  surface) while the rest of the extension still loads. Reach for this only when a single extension owns more than one
  independently-toggleable behaviour. Existing anchors: `PI_BG_BASH_DISABLE_AUTOINJECT`, `PI_MEMORY_DISABLE_AUTOINJECT`,
  `PI_SCRATCHPAD_DISABLE_AUTOINJECT`, `PI_TODO_DISABLE_AUTOINJECT`, `PI_TODO_DISABLE_GUARDRAIL`,
  `PI_STATUSLINE_DISABLE_GIT_PROMPT`, `PI_STATUSLINE_DISABLE_HYPERLINKS`.

Verbose-output env vars name the volume, not the word "verbose" -- pick one term per channel:

- `_TRACE`: structured per-event log (every hook invocation, every tool result, often to a file path). High volume.
- `_DEBUG`: human-readable diagnostic output (one notify per detection / decision). Low-to-medium volume.

An extension may carry both with the meanings above (`PI_APPLY_PATCH_DEBUG` + `PI_APPLY_PATCH_TRACE`). There is no third
"verbose" term -- those two names cover every channel.

**Config-file layering for tool-param defaults.** Where a tool param is really a user _preference_ (not per-call data),
expose it as a `<ext>.json` config layer in addition to / instead of an env knob. Put the pure coerce + merge + a
`load<Ext>Config(cwd)` under `lib/node/pi/<ext>/config.ts` (mirror
[`comfyui/config.ts`](../../../lib/node/pi/comfyui/config.ts)), read paths via
[`piAgentPath` / `piProjectPath`](../../../lib/node/pi/pi-paths.ts), and have the shell only do `params.X ?? config.X`.
When an extension has BOTH env knobs and a config file, the resolution order is:

```text
per-call param  >  project config (<cwd>/.pi/<ext>.json)  >  user config (<piAgentDir>/<ext>.json)  >  env knob  >  built-in default
```

Env sits below the config files so a committed project config wins over a stray shell export. Extensions with this
layering today: `comfyui`, `iteration-loop` (cap defaults), `bg_bash`, `subagent`, `deep-research`. Tool params that are
per-call _data_ (text, ids, actions, prompts -- `apply-patch`, `scratchpad`, `todo`, `memory`, `questionnaire`,
`scheduled-prompts`, `wasm-compute`) get NO config layer.

### Slash command conventions

Three cross-cutting rules for every `pi.registerCommand` handler.

**Empty-arg behaviour.** Pick one of two conventions, in priority order:

1. **Show status / list when a sensible default exists.** A bare `/<cmd>` prints the thing the user most likely wants to
   see. Anchors: `/memory`, `/scratchpad`, `/preset`, `/persona`, `/agents`, `/sandbox`, `/hooks`, `/filesystem`,
   `/todos`, `/avatar`, `/context-budget` all list or show status with no args.
2. **Show USAGE when there is no sensible default.** A command whose whole job is to take an argument (add a rule,
   schedule a prompt) prints its USAGE string on empty args instead of erroring. Anchors: `/btw`, `/schedule`,
   `/bash-allow`, `/bash-deny`, `/sandbox-allow`, `/sandbox-deny`, `/sandbox-allow-write`.

**`--help` requirement.** Every command MUST respond to `help` / `--help` / `-h` / `?` by printing its USAGE string.
Guard the top of the handler with the shared [`isHelpArg`](../../../lib/node/pi/commands/help.ts) helper:

```ts
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';

handler: async (args, ctx) => {
  if (isHelpArg(args)) {
    ctx.ui.notify(USAGE, 'info');
    return;
  }
  // …existing logic…
};
```

The USAGE string is a `const` exported from a sibling pure module (`lib/node/pi/<ext>/usage.ts`, pattern:
[`BTW_USAGE`](../../../lib/node/pi/btw/user-message.ts)) so the handler, the `--help` path, and the empty-arg path that
falls under convention 2 all share one source of truth -- never inline the same usage text twice.

**Argument completion at every level.** Any command that takes a subverb or a positional argument MUST register
`getArgumentCompletions` that completes at **every** token position -- the first subverb AND each subverb's argument
(ids, names, scopes). A command that completes only the first verb (or not at all) is incomplete. Build the completion
over the shared helpers in [`lib/node/pi/commands/complete.ts`](../../../lib/node/pi/commands/complete.ts) rather than
hand-rolling the split-and-branch skeleton:

- **Subverb commands** (`/<cmd> <verb> [arg]`) use `completeSubverbs(prefix, spec)`. The `spec` maps each verb to a
  `description` plus an optional `args` -- either a static `string[]` or a `(tail) => candidates` resolver that reads
  live state (registry job ids, persona names, run slugs on disk). Terminal verbs omit `args`.
- **Positional commands** (`/<cmd> <value>`) use `completePositional(prefix, resolve)`, where `resolve` returns the
  candidate values (e.g. recently-blocked domains, recently-denied bash commands).

```ts
import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';

getArgumentCompletions: (prefix) =>
  completeSubverbs(prefix, {
    list: { description: 'List jobs' },                       // terminal verb
    logs: { description: 'Show a job log', args: () => registry.jobs.map((j) => ({ label: j.id })) },
  }),
```

**Critical mechanic:** pi replaces the **entire** argument string with the chosen completion's `value`, so a
deeper-level `value` must carry the full verb prefix (`logs <id>`, not `<id>`) or the verb is dropped from the submitted
line. The shared helpers enforce this centrally -- a resolver returns only the bare candidate (`{ label }`) and the
helper synthesizes `<verb> <candidate>` -- so always route through them instead of constructing the `value` yourself.
Reference: [`scheduled-prompts.ts`](./scheduled-prompts.ts) (`/schedules`) is the canonical hand-written model the
helpers were extracted from. Return `null` (not `[]`) when nothing matches. Completions that depend on `ctx.cwd`
snapshot it on `session_start` (completions receive no `ctx`); see [`deep-research.ts`](./deep-research.ts)'s `lastCwd`
for `--resume`.

A pure spec like this is also testable without the pi runtime: mirror the exact spec object in the extension's
command-surface spec under [`../../../tests/config/pi/extensions/`](../../../tests/config/pi/extensions) and assert
level-1 completion plus at least one level-2 resolver (including that the returned `value` carries the verb prefix).

> Editor note: pi-tui pops the argument menu when you type the first character of an argument, not from a bare Tab at an
> empty argument slot (Tab there does file completion). That is an upstream editor behaviour, not a defect in the
> command -- registering full-depth completions is still required so the menu is correct once it fires.

### Security gates auto-inject into subagent sessions

Security-gate extensions (`bash-permissions.ts`, `filesystem.ts`, `sandbox.ts`) register a hook-only factory via
[`registerSubagentInjection`](../../../lib/node/pi/subagent/extension-injection.ts) on extension load, so spawned
subagent sessions (`runOneShotAgent`, the `subagent` extension's inline `DefaultResourceLoader`) automatically apply the
parent's `tool_call` gate to child bash / read / write / edit calls. The factory mounts ONLY the `tool_call` handler -
no slash commands, no statusline glue. New security-channel extensions follow the same pattern; non-security extensions
do not.

### Subagent spawns MUST persist their session transcript to disk

Every extension that spawns a child `AgentSession` - through `runOneShotAgent`
([`../../../lib/node/pi/subagent/spawn.ts`](../../../lib/node/pi/subagent/spawn.ts)), `createAgentSession`, or any
future helper - **must** pass an explicit disk-backed `SessionManager`. Never accept the runOneShotAgent default
(`SessionManager.inMemory(cwd)`) and never call `SessionManager.inMemory(...)` from a spawn site.

**Why:** in-memory sessions silently drop the child's transcript at process exit. That breaks two things downstream:

1. **Cost / audit attribution.** [`../session-usage.ts`](../session-usage.ts) and `dotenv/bin/ai-tool-usage` walk the
   on-disk session tree to roll up child token counts and USD spend back to their parent. No file ⇒ the run looks like
   it never happened.
2. **Forensic debuggability.** When a fanout / critic / review child errors, the only trace of what it actually did is
   the child's own jsonl. In-memory ⇒ no postmortem.

**How to apply.** Resolve the directory through the shared helper, then wrap with the runtime
`SessionManager.create(...)`:

```ts
import { resolveSubagentSessionDir } from '../../../lib/node/pi/subagent/session-dir.ts';

await runOneShotAgent({
  // …
  sessionManager: SessionManager.create(
    ctx.cwd,
    resolveSubagentSessionDir({
      parentSessionManager: ctx.sessionManager,
      extensionLabel: 'my-extension',
    }),
  ),
});
```

The helper throws (with a `Restart pi without --no-session` message) when the parent session has no id or no dir -
surface that to the user instead of falling back to in-memory. Pi's `subagent.ts` is the one explicit opt-out, gated
behind `PI_SUBAGENT_NO_PERSIST=1` for the rare ephemeral-debug-run case.

**Layout** (mirrors Claude Code's `~/.claude/projects/<cwd-slug>/<parentSid>/subagents/agent-<aid>.jsonl`):

```text
<parentSessionDir>/<parentSid>/subagents/<timestamp>_<childSid>.jsonl
```

The path-order convention is enforced by [`subagent/session-dir.ts`](../../../lib/node/pi/subagent/session-dir.ts) (for
runOneShotAgent spawns) and [`subagent/session-paths.ts`](../../../lib/node/pi/subagent/session-paths.ts) (for the
`subagent` extension's worktree-anchored variant). Both are walked by [`session-usage.ts`](../session-usage.ts)'s
`subagentDirFor`. If you change the layout, update all three modules + the bats fixture in
[`../../../tests/config/pi/session-usage.bats`](../../../tests/config/pi/session-usage.bats) in lockstep.

### No direct embedding-API calls

Extensions stay model-agnostic. Don't call OpenAI / Anthropic / etc. embedding endpoints directly - route through
`runOneShotAgent` with the configured model so the user's provider+model selection is the single source of truth.

## Boundaries

**Always**: pair every spawn site with a disk-backed `SessionManager.create(...)` via
[`resolveSubagentSessionDir`](../../../lib/node/pi/subagent/session-dir.ts); update the `README.md` index when
adding/removing an extension; add or update the matching deep doc (`<name>.md`) when behaviour changes.

**Ask first**: introducing a new spawn helper that bypasses `subagent/spawn.ts` / `subagent/session-dir.ts`; adding a
new on-disk path layout for subagent transcripts; moving extension logic into `lib/node/pi/` (pure helpers only; shared
helpers that import `@earendil-works/*` go in `lib/node/pi/ext/`).

**Never**: pass `SessionManager.inMemory(...)` to a spawn site (use the `PI_SUBAGENT_NO_PERSIST=1` opt-out in
`subagent.ts` if you genuinely need ephemeral runs); call provider embedding endpoints directly; let an extension grow a
chunk of pure logic that isn't covered by a vitest spec under
[`../../../tests/lib/node/pi/`](../../../tests/lib/node/pi).

## References

- [README.md](./README.md) - extension index + per-extension deep-doc table.
- [`../../../lib/node/pi/subagent/session-dir.ts`](../../../lib/node/pi/subagent/session-dir.ts) - the helper every
  spawn site goes through.
- [`../../../lib/node/pi/subagent/spawn.ts`](../../../lib/node/pi/subagent/spawn.ts) - `runOneShotAgent` plus its
  dependency-injected types.
- [`../session-usage.ts`](../session-usage.ts) - walker that proves transcripts landed on disk.
- [`../../../lib/AGENTS.md`](../../../lib/AGENTS.md) - pure-helper rules for
  [`../../../lib/node/pi/`](../../../lib/node/pi) modules consumed here.
