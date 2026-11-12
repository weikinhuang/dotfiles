# opencode plugins

Authoring conventions for opencode v2 plugins in this directory. User-facing install, runtime, and live-test docs are in
[README.md](./README.md); repo-wide rules are in root [AGENTS.md](../../../AGENTS.md).

## Commands

- `npm run tsc` - root project, then `tsc -p config/opencode/plugins` (this tree has its own tsconfig).
- `npx oxlint --type-aware config/opencode/plugins lib/node/opencode tests/lib/node/opencode` - lint shells + helpers.
- `npx vitest run tests/lib/node/opencode` - helper specs.
- `./dev/opencode-plugin-smoke.sh check <name>` - fast load check (exit 1 on a load failure); `start` / `send` / `wait`
  / `capture` / `stop` drive the TUI. See [README.md](./README.md#live-testing).

## Directory map

| Path                                                                             | Purpose                                                          |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`notify/`](./notify/)                                                           | Reference plugin: direct tool + event-driven lifecycle, options. |
| [`context-edit/`](./context-edit/)                                               | Reference for `context` hook overlays, RPC methods, custom asks. |
| [`statusline/`](./statusline/)                                                   | Reference TUI-only plugin: footer slot, width probe, env config. |
| [`tsconfig.json`](./tsconfig.json)                                               | DOM lib + `jsxImportSource: @opentui/solid` for `tui.tsx` parts. |
| [`../../../lib/node/opencode/`](../../../lib/node/opencode/)                     | Pure opencode helpers (no `@opencode/*` imports).                |
| [`../../../dev/opencode-plugin-smoke.sh`](../../../dev/opencode-plugin-smoke.sh) | Scratch-project + tmux live-test harness.                        |

## Key patterns

- **Layout:** `<name>/server.ts` (`Plugin.define` from `@opencode/plugin`, id `dotfiles.<name>`), optional `tui.tsx`
  (`@opencode/plugin/tui`) and `rpc.ts`, plus `README.md` (behavior, options table, limitations, live-test recipe). No
  `package.json`. A TUI-only plugin (just `tui.tsx`) loads fine. Add a row to the [README.md](./README.md#plugins)
  index.
- **Logic:** shells are glue. Put decisions, parsing, and state machines in `lib/node/opencode/<name>.ts` with a
  mirrored spec. Reuse pure modules from [`lib/node/pi/`](../../../lib/node/pi/AGENTS.md) (never `lib/node/pi/ext/`);
  extend them with optional params instead of forking. Import with relative `.ts` paths (`../../../../lib/node/...`).
- **Options:** read `ctx.options` through `createOptionReader` in
  [`plugin-options.ts`](../../../lib/node/opencode/plugin-options.ts) with an `OPENCODE_<NAME>_` env prefix; env beats
  option beats default. Document every key with its env name.
- **Tools:** `ctx.tool.transform((e) => e.add({...}))`. Default is `codemode: true` (hidden behind `execute`); set
  `options: { codemode: false }` for tools the model should call by name. Plain JSON Schema `input` keeps `effect` out
  of the shell; validate the `unknown` input in a helper. Throw an `Error` to fail a call. Type the second `execute`
  argument as `ToolContext` from `@opencode/plugin/promise/tool`.
- **Permissions:** a tool has no gate unless it calls `ctx.permission.assert` with a custom action. opencode's base
  policy is `* * allow`, so a custom action is silently allowed; insert a default ask with `defaultAskRuleIndex` from
  [`permission-rules.ts`](../../../lib/node/opencode/permission-rules.ts) inside `ctx.agent.transform` (see
  `context-edit` / `secret-redactor`). `options.permission: <action>` on a tool hides it when that action is denied.
  Rethrow a decline from `permission.assert` unchanged.
- **Events:** `for await (const e of ctx.event.subscribe({ types, signal }))`, aborted in the cleanup `setup` returns.
  The stream is already scoped to the plugin's location. Root vs subagent: `session-tree.ts` (`parentID` walk, cached).
- **Storage:** `ctx.storage.get/set/remove/scan` holds durable JSON per plugin (server); `context.storage.store` /
  `memory` in TUI parts.
- **RPC (server <-> TUI, verified):** `rpc.ts` exports `Rpc.define({ id, methods, events })` from `@opencode/plugin/rpc`
  with JSON Schema shapes (`events: {}` is required even when empty). Server:
  `const reg = await ctx.rpc.register(Def, { method: async (input) => ... })`, `await reg.events.emit('name', {...})`,
  and `await reg.dispose()` in cleanup. TUI: `const rpc = context.client.rpc(Def)`,
  `rpc.method(input, { location: context.location ?? context.data.location.default() })`, and
  `rpc.events.on('name', cb)` (returns an unsubscribe). Handler input and results are `unknown`: narrow them in a
  helper. Event payloads are typed `Record<string, unknown>`, so spread an interface value (`{ ...event }`). Events are
  live-only; add a `status`-style method so a TUI can catch up after a restart.

### Gotchas

Runtime gotchas for opencode 2.2.7 (watching, TUI slots, permissions prompts, session APIs, harness) live in
[README.md](./README.md#runtime-gotchas-opencode-227). Add new ones there.

## Boundaries

**Always**: keep shells thin and helpers pure with specs; run `npm run tsc`, oxlint, vitest, and the smoke `check`;
live-test new tools or event wiring once with `start`; document options in the plugin README.

**Ask first**: adding a dependency beyond `@opencode/plugin` and its TUI peers; adding a `package.json` / build step.

**Never**: write to `~/.config/opencode` or use the shared background service while testing; import `@opencode/*` from
`lib/node/opencode/`; edit `external/`.

## References

- [README.md](./README.md) - plugin index, install, runtime resolution, live testing.
- [`../../pi/extensions/AGENTS.md`](../../pi/extensions/AGENTS.md) - the pi side of most ports.
- opencode plugin docs: `services/site/src/docs/content/build/plugins/{server,cli,rpc}.mdx` in the opencode repo.
