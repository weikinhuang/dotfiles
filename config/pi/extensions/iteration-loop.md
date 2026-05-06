# `iteration-loop.ts`

A `check` tool + on-disk state under `.pi/checks/` + a [`critic`](../agents/critic.md) subagent that together force
artifact-producing work into an explicit declare → accept → run → close loop with budgets, fixpoint detection, and
nudges when the model edits or claims without verifying. Companion to the
[`iterate-until-verified`](../skills/iterate-until-verified/SKILL.md) skill that teaches WHEN to reach for it.

## What it does

- Single task namespace — v1 only supports one active task, default name `default`.
- Two check kinds:
  - `bash` — shell command, pass on `exit-zero` (default), `regex:<pat>` on stdout, or `jq:<expr>` on stdout.
  - `critic` — spawns the [`critic`](../agents/critic.md) subagent via `runOneShotAgent`, parses its JSON verdict,
    charges `usage.cost.total` to the loop budget.
- Per iteration: snapshot the artifact to `iter-NNN.<ext>` with sha256, dispatch the check, write the verdict JSON,
  classify stop reason, update branch state.
- Stop reasons: `passed` · `budget-iter` · `budget-cost` · `wall-clock` · `fixpoint` (artifact hash unchanged) ·
  `user-closed`.
- System-prompt injection every turn via `renderIterationBlock` — directive `Next step: …` lines for active loops,
  awaiting-acceptance block for drafts.
- Branch state (`IterationState`) is mirrored as `customType: 'iteration-state'` entries so `/compact` can't drop it;
  reducer rebuilds on `session_start` / `session_tree`.
- `run` does not execute until the draft has been `accept`ed by the user.
- Guardrail nudges fire on `agent_end` as `followUp` user messages, idempotent via sentinel markers on the last user
  message:
  - **Strict edit-without-check** — fires when `editsSinceLastCheck >= strictNudgeAfterNEdits` (default 2). Tracked by
    watching `tool_result` for writes whose path matches the declared artifact (`extractEditTargets` +
    `anyArtifactMatch`).
  - **Claim nudge** — fires when the final assistant message matches a configured `claimRegexes` entry. Suppressed when
    [`verify-before-claim.ts`](./verify-before-claim.md) would fire on the same message (shared `VERIFY_MARKER`
    detection) or when the strict nudge already fired this turn.

## Tool: `check`

| Action                  | Required           | Optional                                                                                              |
| ----------------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| `declare`               | `kind`, `artifact` | budget: `maxIter` (default 5), `maxCostUsd` (default 0.10), `wallClockSeconds` (default 600); `task`  |
| `declare` kind=`bash`   | `cmd`              | `passOn` (`exit-zero` \| `regex:<pat>` \| `jq:<expr>`), `env`, `workdir`, `timeoutMs` (default 60000) |
| `declare` kind=`critic` | `rubric`           | `agent` (default `critic`), `modelOverride`                                                           |
| `accept`                | —                  | `task`                                                                                                |
| `run`                   | —                  | `task` — rehydrates empty state from spec when branch entries are missing                             |
| `status`                | —                  | `task`                                                                                                |
| `close`                 | —                  | `task`, `reason` (one of the stop reasons; default `user-closed`) — archives the task                 |
| `list`                  | —                  | — lists active/draft tasks and up to 10 archive entries                                               |

## State layout

Rooted at `<cwd>/.pi/checks/`:

- `<task>.draft.json` — proposed spec, pending user acceptance.
- `<task>.json` — accepted active `CheckSpec` (task, kind, artifact, spec, budget, `createdAt`, `acceptedAt`).
- `<task>.snapshots/iter-NNN.<ext>` — per-iteration artifact copy (input to sha256 fixpoint detection).
- `<task>.snapshots/iter-NNN.verdict.json` — `Verdict` persisted alongside the snapshot.
- `archive/<ts>-<task>/` — target of `check close`; draft is also discarded.

On the session branch:

- `toolResult.details: CheckDetails` — shape `{ action, task, state, spec, specState, archivedTo?, error? }`.
- `customType: 'iteration-state'` mirror entry on every state-mutating action (`accept`, `run`, `close`, edit-tracking)
  so branch reconstruction survives `/compact`.

## Companion pieces

- Skill: [`../skills/iterate-until-verified/SKILL.md`](../skills/iterate-until-verified/SKILL.md)
- Critic subagent: [`../agents/critic.md`](../agents/critic.md)
- Lib helpers (all under [`../../../lib/node/pi/`](../../../lib/node/pi/)):
  - [`iteration-loop-schema.ts`](../../../lib/node/pi/iteration-loop-schema.ts) — `CheckSpec`, `IterationState`,
    `Verdict`, `StopReason`, shape guards.
  - [`iteration-loop-storage.ts`](../../../lib/node/pi/iteration-loop-storage.ts) — draft/active/archive paths,
    `writeDraft`, `acceptDraft`, `snapshotArtifact`, `writeSnapshotVerdict`, `listTasks`, `listArchive`.
  - [`iteration-loop-reducer.ts`](../../../lib/node/pi/iteration-loop-reducer.ts) — `actAccept` / `actRun` / `actClose`
    / `actRecordEdit`, `reduceBranch`, `ITERATION_TOOL_NAME`, `ITERATION_CUSTOM_TYPE`.
  - [`iteration-loop-budget.ts`](../../../lib/node/pi/iteration-loop-budget.ts) — `computeStopReason`.
  - [`iteration-loop-check-bash.ts`](../../../lib/node/pi/iteration-loop-check-bash.ts) — `runBashCheck` with
    `exit-zero` / `regex:` / `jq:` predicates.
  - [`iteration-loop-check-critic.ts`](../../../lib/node/pi/iteration-loop-check-critic.ts) — `buildCriticTask`,
    `parseVerdict` (tolerant JSON recovery).
  - [`iteration-loop-artifact.ts`](../../../lib/node/pi/iteration-loop-artifact.ts) — `extractEditTargets`,
    `anyArtifactMatch` for edit tracking.
  - [`iteration-loop-prompt.ts`](../../../lib/node/pi/iteration-loop-prompt.ts) — `renderIterationBlock` system-prompt
    block.
  - [`iteration-loop-config.ts`](../../../lib/node/pi/iteration-loop-config.ts) — `loadIterationLoopConfig`,
    `matchesClaimRegex` (reads `~/.pi/agent/iteration-loop.json` + `<cwd>/.pi/iteration-loop.json`).
  - [`subagent-loader.ts`](../../../lib/node/pi/subagent-loader.ts) +
    [`subagent-spawn.ts`](../../../lib/node/pi/subagent-spawn.ts) — agent registry and `runOneShotAgent` used by the
    critic dispatch.
  - [`verify-detect.ts`](../../../lib/node/pi/verify-detect.ts) — shared with
    [`verify-before-claim.md`](./verify-before-claim.md) for claim-nudge dedupe.

## Environment variables

- `PI_ITERATION_LOOP_DISABLED=1` — skip the extension entirely (no tool registered, no hooks).
- `PI_ITERATION_LOOP_DEBUG=1` — log state transitions and guardrail decisions to stderr.

Runtime knobs for claim regexes and `strictNudgeAfterNEdits` are not env vars — they live in
`~/.pi/agent/iteration-loop.json` and `<cwd>/.pi/iteration-loop.json` (loaded via
[`iteration-loop-config.ts`](../../../lib/node/pi/iteration-loop-config.ts)).

## Hot reload

Edit [`extensions/iteration-loop.ts`](./iteration-loop.ts) or any of the
[`lib/node/pi/iteration-loop-*.ts`](../../../lib/node/pi/) helpers and run `/reload` in an interactive pi session to
pick up changes without restarting.
