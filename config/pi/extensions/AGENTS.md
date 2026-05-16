# Pi extensions

<!-- markdownlint-disable authoring-guide-doc-size-budget -->

Conventions for extensions under [`../extensions/`](../extensions/) - the `.ts` extension shells loaded via
[`../settings-baseline.json`](../settings-baseline.json). See [README.md](./README.md) for the per-extension index and
root [AGENTS.md](../../../AGENTS.md) for repo-wide rules; this file documents only what is different in this directory.

## Commands

- `npm test` - vitest covers the pure helpers under [`../../../lib/node/pi/`](../../../lib/node/pi) plus the extension
  command-surface specs under [`../../../tests/config/pi/extensions/`](../../../tests/config/pi/extensions).
- `npm run tsc` - type-checks every helper imported by these extensions. The `.ts` extension files themselves are
  excluded from the root `tsconfig.json` (they resolve `@earendil-works/*` via pi's globally-installed package, which
  the root TS project doesn't know about), so type errors for extension shells only surface at runtime.
- `./dev/lint.sh` - shellcheck + shfmt picks up any shell scripts under this tree.

## Key patterns

### Pi-coupled glue lives here, pure helpers live in lib

Anything that imports from `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` / `@earendil-works/pi-tui`
belongs here. Pure logic (reducers, parsers, path resolvers, formatters) belongs in
[`../../../lib/node/pi/`](../../../lib/node/pi) so it can be unit-tested with vitest and type-checked under the root
`tsconfig.json`. When an extension grows a chunk of pure logic, **extract it** rather than testing it indirectly through
the runtime.

### `<name>.ts` + `<name>.md` pair

Every extension ships with a deep doc next to it (`bg-bash.ts` ↔ `bg-bash.md`, `deep-research.ts` ↔ `deep-research.md`).
The `.md` is the long-form reference for behaviour, env vars, and rule shapes; the `.ts` is the source of truth for
runtime behaviour. New extensions add both files **and** a row in [README.md](./README.md)'s index table in lockstep.

### Subagent spawns MUST persist their session transcript to disk

Every extension that spawns a child `AgentSession` - through `runOneShotAgent`
([`../../../lib/node/pi/subagent-spawn.ts`](../../../lib/node/pi/subagent-spawn.ts)), `createAgentSession`, or any
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
import { resolveSubagentSessionDir } from '../../../lib/node/pi/subagent-session-dir.ts';

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

The path-order convention is enforced by [`subagent-session-dir.ts`](../../../lib/node/pi/subagent-session-dir.ts) (for
runOneShotAgent spawns) and [`subagent-session-paths.ts`](../../../lib/node/pi/subagent-session-paths.ts) (for the
`subagent` extension's worktree-anchored variant). Both are walked by [`session-usage.ts`](../session-usage.ts)'s
`subagentDirFor`. If you change the layout, update all three modules + the bats fixture in
[`../../../tests/config/pi/session-usage.bats`](../../../tests/config/pi/session-usage.bats) in lockstep.

### No direct embedding-API calls

Extensions stay model-agnostic. Don't call OpenAI / Anthropic / etc. embedding endpoints directly - route through
`runOneShotAgent` with the configured model so the user's provider+model selection is the single source of truth.

## Boundaries

**Always**: pair every spawn site with a disk-backed `SessionManager.create(...)` via
[`resolveSubagentSessionDir`](../../../lib/node/pi/subagent-session-dir.ts); update the `README.md` index when
adding/removing an extension; add or update the matching deep doc (`<name>.md`) when behaviour changes.

**Ask first**: introducing a new spawn helper that bypasses `subagent-spawn.ts` / `subagent-session-dir.ts`; adding a
new on-disk path layout for subagent transcripts; moving extension logic into `lib/node/pi/` (pure helpers only -
nothing that imports `@earendil-works/*`).

**Never**: pass `SessionManager.inMemory(...)` to a spawn site (use the `PI_SUBAGENT_NO_PERSIST=1` opt-out in
`subagent.ts` if you genuinely need ephemeral runs); call provider embedding endpoints directly; let an extension grow a
chunk of pure logic that isn't covered by a vitest spec under
[`../../../tests/lib/node/pi/`](../../../tests/lib/node/pi).

## References

- [README.md](./README.md) - extension index + per-extension deep-doc table.
- [`../../../lib/node/pi/subagent-session-dir.ts`](../../../lib/node/pi/subagent-session-dir.ts) - the helper every
  spawn site goes through.
- [`../../../lib/node/pi/subagent-spawn.ts`](../../../lib/node/pi/subagent-spawn.ts) - `runOneShotAgent` plus its
  dependency-injected types.
- [`../session-usage.ts`](../session-usage.ts) - walker that proves transcripts landed on disk.
- [`../../../lib/AGENTS.md`](../../../lib/AGENTS.md) - pure-helper rules for
  [`../../../lib/node/pi/`](../../../lib/node/pi) modules consumed here.
