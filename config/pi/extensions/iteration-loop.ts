/**
 * Iteration-loop extension for pi — disciplined RL-style feedback
 * loops on artifact-producing tasks.
 *
 * Headline idea: the agent declares a check up front, produces an
 * artifact, runs the check, reads the verdict, iterates. On-disk
 * state in `.pi/checks/<task>.json` survives pi restarts. Per-session
 * iteration state (iteration count, last verdict, best-so-far,
 * edits-since-last-check) lives in the session branch and is
 * reconstructed from `toolResult.details` + mirrored custom entries
 * on session_start / session_tree (same pattern as `todo` /
 * `scratchpad`).
 *
 * ## Phase 4 scope (this commit)
 *
 * Layers the two guardrails on top of Phase 3's dispatch:
 *
 *   - **Claim nudge**: on `agent_end`, if the final assistant
 *     message matches any configured artifact-correctness claim
 *     regex AND no successful `check run` was recorded for this
 *     turn AND an active (non-terminated) loop exists, inject a
 *     follow-up user message reminding the model to run the check
 *     or retract the claim. De-duped against `verify-before-claim`:
 *     if that extension would ALSO fire on the same final message
 *     (i.e. there are unverified test/lint/build claims), we
 *     suppress our claim nudge and let v-b-c handle it — the strict
 *     edit nudge still fires because it addresses a different
 *     trigger.
 *
 *   - **Strict edit-without-check nudge**: on `tool_result`, when a
 *     write/edit tool call targets the declared artifact path, we
 *     bump `state.editsSinceLastCheck` via `actRecordEdit`. On
 *     `agent_end`, if that counter is at or above the configured
 *     threshold (default 2) AND no check ran this turn AND the
 *     loop is active, inject a follow-up user message.
 *
 * Both nudges use `pi.sendUserMessage(..., { deliverAs: 'followUp'
 * })` with distinct sentinels. Each checks `lastUserMessageHasMarker`
 * on the branch for its own marker to avoid re-triggering on its
 * own nudge. Runtime config lives in
 * `~/.pi/agent/iteration-loop.json` + `<cwd>/.pi/iteration-loop.json`
 * (see `iteration-loop-config.ts`).
 *
 * ## Phase 3 scope (previous commit)
 *
 * Phase 3 implemented `check run` — the actual iteration dispatcher. For `kind=bash` the extension shells out via
 * `runBashCheck` (zero cost). For `kind=critic` the extension spawns
 * a fresh `AgentSession` against the critic agent definition,
 * collects the final JSON verdict, and charges the aggregated
 * `usage.cost.total` to `state.costUsd`.
 *
 * Per-iteration flow:
 *   1. Snapshot the artifact into
 *      `.pi/checks/<task>.snapshots/iter-NNN.<ext>`, computing a
 *      sha256 hash for fixpoint detection.
 *   2. Dispatch bash or critic → Verdict.
 *   3. Write the verdict alongside the snapshot.
 *   4. Classify stop-reason via `computeStopReason` (passed, fixpoint,
 *      budget-iter, budget-cost, wall-clock) using both the current
 *      and previous iteration's artifact hashes.
 *   5. Update session-branch state via `actRun` (bumps iteration,
 *      resets `editsSinceLastCheck`, adds `costDeltaUsd` to
 *      `costUsd`, recomputes `bestSoFar`, appends history, records
 *      `stopReason`).
 *   6. Emit both the tool result AND a mirrored `customType:
 *      'iteration-state'` entry so branch reconstruction on
 *      `session_start` / `session_tree` picks up the new state.
 *
 * Separation of concerns:
 *
 *   - Pure state / schema / storage / prompt rendering lives under
 *     `lib/node/pi/iteration-loop-*.ts` (Phase 1) and is
 *     `vitest`-tested without the pi runtime.
 *   - This file is the pi-coupled glue: tool registration, lifecycle
 *     hooks, branch reconstruction, custom entry mirroring.
 *
 * ## State layout
 *
 * On disk (rooted at `<cwd>/.pi/checks/`):
 *   - `<task>.draft.json`         — proposed but not accepted.
 *   - `<task>.json`               — accepted active check spec.
 *   - `<task>.snapshots/…`        — per-iteration artifact snapshots
 *                                   (Phase 3+ populates these).
 *   - `archive/<ts>-<task>/`      — closed tasks land here.
 *
 * In the session branch:
 *   - `toolResult.details: IterationState` on each successful
 *     `check accept` / `check close` call.
 *   - `customType: 'iteration-state'` mirror on the same turn so
 *     `/compact` can eat the tool result without losing state.
 *
 * ## System-prompt injection
 *
 * Every turn, if a spec exists on disk for the default task, the
 * extension appends a `## Iteration Loop` block under the system
 * prompt. The block is directive ("Next step: …") rather than
 * descriptive so small models act on it instead of narrating it.
 * Draft-pending tasks render a short "awaiting acceptance" block so
 * the model doesn't forget to surface the draft to the user.
 *
 * Environment:
 *   PI_ITERATION_LOOP_DISABLED=1       skip the extension entirely
 *   PI_ITERATION_LOOP_DEBUG=1          log state transitions to stderr
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Model, StringEnum } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type ModelRegistry,
  parseFrontmatter,
  type ResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { anyArtifactMatch, extractEditTargets } from '../../../lib/node/pi/iteration-loop-artifact.ts';
import { computeStopReason } from '../../../lib/node/pi/iteration-loop-budget.ts';
import { runBashCheck } from '../../../lib/node/pi/iteration-loop-check-bash.ts';
import { buildCriticTask, parseVerdict } from '../../../lib/node/pi/iteration-loop-check-critic.ts';
import {
  type IterationLoopConfig,
  loadIterationLoopConfig,
  matchesClaimRegex,
} from '../../../lib/node/pi/iteration-loop-config.ts';
import { renderIterationBlock } from '../../../lib/node/pi/iteration-loop-prompt.ts';
import {
  actAccept,
  actClose,
  actRecordEdit,
  actRun,
  type ActionResult,
  type BranchEntry,
  ITERATION_CUSTOM_TYPE,
  ITERATION_TOOL_NAME,
  reduceBranch,
} from '../../../lib/node/pi/iteration-loop-reducer.ts';
import {
  type BashCheckSpec,
  type CheckKind,
  type CheckSpec,
  cloneIterationState,
  emptyIterationState,
  type CriticCheckSpec,
  isBashCheckSpecShape,
  isCriticCheckSpecShape,
  isStopReason,
  type IterationState,
  type StopReason,
  type Verdict,
} from '../../../lib/node/pi/iteration-loop-schema.ts';
import {
  acceptDraft,
  activePath,
  archiveTask,
  discardDraft,
  draftPath,
  listArchive,
  listTasks,
  readSpec,
  snapshotArtifact,
  snapshotPath,
  type TaskListing,
  writeDraft,
  writeSnapshotVerdict,
} from '../../../lib/node/pi/iteration-loop-storage.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';
import {
  type AgentDef,
  type AgentLoadResult,
  type AgentLoadWarning,
  defaultAgentLayers,
  loadAgents,
  type ReadLayer,
} from '../../../lib/node/pi/subagent-loader.ts';
import { resolveChildModel, runOneShotAgent, type CreateAgentSessionDep } from '../../../lib/node/pi/subagent-spawn.ts';

/**
 * Pi's `createAgentSession` types `modelRegistry` as the concrete
 * `ModelRegistry` class, while `lib/node/pi/subagent-spawn.ts` uses a
 * pi-free structural `ModelRegistryLike` so the helper can stay
 * unit-testable without pi imports. See the matching wrapper in
 * `deep-research.ts` for the full rationale.
 */
const piCreateAgentSession: CreateAgentSessionDep<Model<any>, SessionManager> = (args) =>
  createAgentSession({
    ...args,
    modelRegistry: args.modelRegistry as ModelRegistry,
    resourceLoader: args.resourceLoader as ResourceLoader,
  });
import {
  type BranchEntry as VerifyBranchEntry,
  collectBashCommandsSinceLastUser,
  extractClaims,
  extractLastAssistantText,
  lastUserMessageHasMarker,
  partitionClaims,
} from '../../../lib/node/pi/verify-detect.ts';
import { VERIFY_MARKER } from './verify-before-claim.ts';

const DEFAULT_TASK = 'default';
const STOP_REASONS = ['passed', 'budget-iter', 'budget-cost', 'wall-clock', 'fixpoint', 'user-closed'] as const;

// ──────────────────────────────────────────────────────────────────────
// Parameter schema
// ──────────────────────────────────────────────────────────────────────

const CheckParams = Type.Object({
  action: StringEnum(['declare', 'accept', 'run', 'status', 'close', 'list'] as const, {
    description:
      'Which operation to perform. Flow: `declare` writes a draft → user reviews / `accept`s → `run` iterates → `close` on passed/exhausted.',
  }),
  task: Type.Optional(
    Type.String({
      description: 'Task name. Defaults to `default`; v1 only supports a single active task at a time.',
    }),
  ),

  // ── declare-specific ────────────────────────────────────────────────
  kind: Type.Optional(
    StringEnum(['bash', 'critic'] as const, {
      description:
        '(declare) Check kind. `bash` for deterministic exit-code / regex / jq checks; `critic` for JSON-verdict subagent.',
    }),
  ),
  artifact: Type.Optional(
    Type.String({
      description: '(declare) Path (relative to cwd) of the artifact being iterated on. v1 requires exact-path match.',
    }),
  ),

  // bash-kind fields
  cmd: Type.Optional(
    Type.String({
      description: '(declare, kind=bash) Shell command run through /bin/bash -c.',
    }),
  ),
  passOn: Type.Optional(
    Type.String({
      description:
        '(declare, kind=bash) Pass predicate: `exit-zero` (default), `regex:<pattern>` (stdout match), or `jq:<expr>` (applied to stdout).',
    }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: '(declare, kind=bash) Extra env vars merged onto the parent env.',
    }),
  ),
  workdir: Type.Optional(
    Type.String({ description: '(declare, kind=bash) Working directory for the check command. Defaults to cwd.' }),
  ),
  timeoutMs: Type.Optional(Type.Integer({ description: '(declare, kind=bash) Hard timeout in ms. Default 60000.' })),

  // critic-kind fields
  rubric: Type.Optional(
    Type.String({
      description:
        '(declare, kind=critic) Rubric text the critic judges the artifact against. Be specific and listable.',
    }),
  ),
  agent: Type.Optional(
    Type.String({ description: '(declare, kind=critic) Subagent to dispatch. Defaults to `critic`.' }),
  ),
  modelOverride: Type.Optional(
    Type.String({
      description:
        '(declare, kind=critic) Optional `provider/id` override threaded to the subagent. Leave unset to inherit.',
    }),
  ),

  // budget (declare)
  maxIter: Type.Optional(Type.Integer({ description: '(declare) Hard cap on iterations. Default 5.' })),
  maxCostUsd: Type.Optional(Type.Number({ description: '(declare) Soft cap on cumulative USD cost. Default 0.10.' })),
  wallClockSeconds: Type.Optional(Type.Integer({ description: '(declare) Wall-clock cap in seconds. Default 600.' })),

  // ── close-specific ──────────────────────────────────────────────────
  reason: Type.Optional(
    StringEnum(STOP_REASONS, {
      description:
        '(close) Why the loop is ending. `user-closed` is the manual-close default; others surface programmatic exit paths.',
    }),
  ),
});

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

type CheckAction = 'declare' | 'accept' | 'run' | 'status' | 'close' | 'list';

interface CheckDetails {
  action: CheckAction;
  task?: string;
  state?: IterationState | null;
  specState?: 'none' | 'draft' | 'active';
  spec?: CheckSpec | null;
  archivedTo?: string | null;
  error?: string;
}

interface ToolReturn {
  content: { type: 'text'; text: string }[];
  details: CheckDetails;
  isError?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function debug(enabled: boolean, msg: string): void {
  if (!enabled) return;
  // Stderr only — never touch stdout so we don't contaminate tool output.
  try {
    process.stderr.write(`[iteration-loop] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function errorReturn(action: CheckAction, task: string | undefined, message: string): ToolReturn {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    details: { action, task, error: message },
    isError: true,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build a CheckSpec from the declare-action params. Returns an error
 * string when required fields are missing or malformed. Keeps the
 * validation near the tool-call boundary; pure-helpers layer below
 * does its own defensive validation of the constructed spec.
 */
function buildSpecFromParams(
  task: string,
  params: {
    kind?: CheckKind;
    artifact?: string;
    cmd?: string;
    passOn?: string;
    env?: Record<string, string>;
    workdir?: string;
    timeoutMs?: number;
    rubric?: string;
    agent?: string;
    modelOverride?: string;
    maxIter?: number;
    maxCostUsd?: number;
    wallClockSeconds?: number;
  },
): { ok: true; spec: CheckSpec } | { ok: false; error: string } {
  if (!params.kind) return { ok: false, error: 'declare requires `kind` (bash or critic)' };
  if (!params.artifact || !params.artifact.trim()) {
    return { ok: false, error: 'declare requires `artifact` (path relative to cwd)' };
  }

  let kindSpec: BashCheckSpec | CriticCheckSpec;
  if (params.kind === 'bash') {
    const cmd = (params.cmd ?? '').trim();
    if (!cmd) return { ok: false, error: 'declare kind=bash requires `cmd`' };
    const passOn = params.passOn?.trim();
    if (
      passOn !== undefined &&
      passOn !== '' &&
      passOn !== 'exit-zero' &&
      !passOn.startsWith('regex:') &&
      !passOn.startsWith('jq:')
    ) {
      return { ok: false, error: `invalid passOn "${passOn}" — use exit-zero, regex:<pat>, or jq:<expr>` };
    }
    const bash: BashCheckSpec = { cmd };
    if (passOn && passOn !== 'exit-zero') bash.passOn = passOn as BashCheckSpec['passOn'];
    if (params.env) bash.env = params.env;
    if (params.workdir) bash.workdir = params.workdir;
    if (params.timeoutMs !== undefined) bash.timeoutMs = params.timeoutMs;
    kindSpec = bash;
  } else if (params.kind === 'critic') {
    const rubric = (params.rubric ?? '').trim();
    if (!rubric) return { ok: false, error: 'declare kind=critic requires `rubric`' };
    const critic: CriticCheckSpec = { rubric };
    if (params.agent) critic.agent = params.agent;
    if (params.modelOverride) critic.modelOverride = params.modelOverride;
    kindSpec = critic;
  } else {
    return { ok: false, error: `unknown kind "${String(params.kind)}"` };
  }

  const spec: CheckSpec = {
    task,
    kind: params.kind,
    artifact: params.artifact.trim(),
    spec: kindSpec,
    createdAt: nowIso(),
  };
  if (params.maxIter !== undefined || params.maxCostUsd !== undefined || params.wallClockSeconds !== undefined) {
    spec.budget = {};
    if (params.maxIter !== undefined) spec.budget.maxIter = params.maxIter;
    if (params.maxCostUsd !== undefined) spec.budget.maxCostUsd = params.maxCostUsd;
    if (params.wallClockSeconds !== undefined) spec.budget.wallClockSeconds = params.wallClockSeconds;
  }
  return { ok: true, spec };
}

function formatListing(tasks: TaskListing[], archive: ReturnType<typeof listArchive>): string {
  const lines: string[] = [];
  if (tasks.length === 0) {
    lines.push('No active or draft tasks under .pi/checks/.');
  } else {
    lines.push(`Tasks (${tasks.length}):`);
    for (const t of tasks) {
      lines.push(`  [${t.state}] ${t.task}  — ${t.path}`);
    }
  }
  if (archive.length > 0) {
    lines.push('');
    lines.push(`Archive (${archive.length} entr${archive.length === 1 ? 'y' : 'ies'}):`);
    for (const a of archive.slice(0, 10)) {
      lines.push(`  ${a.timestamp || '(no-ts)'}  ${a.task}  — ${a.dir}`);
    }
    if (archive.length > 10) lines.push(`  … ${archive.length - 10} more`);
  }
  return lines.join('\n');
}

/**
 * Look up the declared artifact path for `task` on disk. Returns
 * null when no active spec exists, the file is missing, or it
 * failed to parse — callers treat null as "no artifact to talk
 * about" and fall back to a generic message.
 */
function readArtifactPath(cwd: string, task: string): string | null {
  try {
    const read = readSpec(cwd, task);
    if (read.state !== 'active' || !read.spec) return null;
    return read.spec.artifact;
  } catch {
    return null;
  }
}

function formatStatusText(cwd: string, task: string, state: IterationState | null): string {
  const read = readSpec(cwd, task);
  if (read.state === 'none') {
    return `No check declared for task "${task}". Call \`check declare\` to start.`;
  }
  if (read.error && !read.spec) {
    return `task "${task}" has a ${read.state} spec but it failed to load: ${read.error}`;
  }
  const block = renderIterationBlock(read.spec, read.state, state);
  return block ?? `(no active iteration loop for task "${task}")`;
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function iterationLoopExtension(pi: ExtensionAPI): void {
  if (process.env.PI_ITERATION_LOOP_DISABLED === '1') return;

  const debugEnabled = process.env.PI_ITERATION_LOOP_DEBUG === '1';

  // In-memory mirror of the current branch's iteration state. `null`
  // means "no loop has been accepted on this branch" — a pre-accept
  // declare leaves state null; it's the `accept` action that seeds it.
  let state: IterationState | null = null;

  // Agent-definition registry (shared with subagent loader logic).
  // Phase 3 uses this only for the `critic` dispatch path; Phase 4
  // adds the edit-tracking hook that also keys off the declared
  // artifact path, which doesn't need the agent map.
  const extDir = dirname(fileURLToPath(import.meta.url));
  const userPiDir = `${homedir()}/.pi`;
  let agentLoad: AgentLoadResult = { agents: new Map(), nameOrder: [], warnings: [] };
  const surfacedAgentWarnings = new Set<string>();

  const readLayer: ReadLayer = {
    listMarkdownFiles: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return null;
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
  };

  const reloadAgents = (cwd: string): void => {
    const knownToolNames = new Set(pi.getAllTools().map((t) => t.name));
    const layers = defaultAgentLayers({ extensionDir: extDir, userPiDir, cwd });
    agentLoad = loadAgents({
      layers,
      knownToolNames,
      fs: readLayer,
      parseFrontmatter,
    });
  };

  const surfaceAgentWarnings = (ctx: ExtensionContext, warnings: readonly AgentLoadWarning[]): void => {
    for (const w of warnings) {
      const key = `${w.path}:${w.reason}`;
      if (surfacedAgentWarnings.has(key)) continue;
      surfacedAgentWarnings.add(key);
      ctx.ui.notify(`iteration-loop: ${w.path}: ${w.reason}`, 'warning');
    }
  };

  // Turn counter (used by Phase 4 guardrails + threaded through
  // actRun as `turnNumber`). Incremented on `turn_start`; reset on
  // session_start so branch rebuilds don't accumulate across
  // session swaps.
  let currentTurnIndex = 0;

  // Phase 4 guardrails state. `checkRanThisTurn` flips on every
  // successful `check run` execution (we reset at `turn_start`); the
  // claim & strict nudges both suppress when it's true, because any
  // run means the model already verified. Idempotency against
  // re-delivery races is handled by `lastUserMessageHasMarker` — we
  // key off CLAIM_NUDGE_MARKER / STRICT_NUDGE_MARKER so repeated
  // invocations don't re-fire once a nudge has been delivered.
  let checkRanThisTurn = false;
  let loopConfig: IterationLoopConfig = loadIterationLoopConfig(process.cwd()).config;
  const surfacedConfigWarnings = new Set<string>();

  const surfaceConfigWarnings = (ctx: ExtensionContext, warnings: readonly { path: string; error: string }[]): void => {
    for (const w of warnings) {
      ctx.ui.notify(`iteration-loop: ${w.path}: ${w.error}`, 'warning');
    }
  };

  /** Sentinels matching the `verify-before-claim` convention so the
   *  guardrail messages are easy to spot in transcripts and the
   *  `lastUserMessageHasMarker` idempotency guard keys on them.
   *  `VERIFY_MARKER` is imported from verify-before-claim.ts so a
   *  rename there doesn't silently break the de-dupe below. */
  const CLAIM_NUDGE_MARKER = '⚠ [pi-iteration-loop-claim]';
  const STRICT_NUDGE_MARKER = '⚠ [pi-iteration-loop-strict-edit]';

  const rebuildFromSession = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch() as unknown as readonly BranchEntry[];
    state = reduceBranch(branch);
    debug(
      debugEnabled,
      `rebuilt state from branch: ${state ? `task=${state.task} iter=${state.iteration}` : '(none)'}`,
    );
  };

  pi.on('session_start', (_event, ctx) => {
    rebuildFromSession(ctx);
    try {
      reloadAgents(ctx.cwd);
      surfaceAgentWarnings(ctx, agentLoad.warnings);
    } catch (e) {
      debug(debugEnabled, `agent reload failed: ${(e as Error).message}`);
    }
    try {
      const result = loadIterationLoopConfig(ctx.cwd);
      loopConfig = result.config;
      const fresh = result.warnings.filter((w) => {
        const key = `${w.path}:${w.error}`;
        if (surfacedConfigWarnings.has(key)) return false;
        surfacedConfigWarnings.add(key);
        return true;
      });
      surfaceConfigWarnings(ctx, fresh);
    } catch (e) {
      debug(debugEnabled, `config reload failed: ${(e as Error).message}`);
    }
    currentTurnIndex = 0;
    checkRanThisTurn = false;
  });

  pi.on('session_tree', (_event, ctx) => {
    rebuildFromSession(ctx);
  });

  pi.on('turn_start', (event) => {
    // event.turnIndex is 0-indexed per pi-coding-agent's TurnStartEvent.
    // This hook only receives the PARENT session's turn_start — the
    // critic subagent runs in its own AgentSession (via
    // runOneShotAgent) with `SessionManager.inMemory` + no shared pi
    // extension registry, so its events never reach this callback. If
    // pi ever starts piping subagent events through the parent, adjust
    // this handler to filter by `event.sessionId === pi.sessionId`.
    currentTurnIndex = (event as { turnIndex?: number }).turnIndex ?? currentTurnIndex + 1;
    checkRanThisTurn = false;
  });

  // ── System-prompt injection ─────────────────────────────────────────
  pi.on('before_agent_start', (event, ctx) => {
    const task = state?.task ?? DEFAULT_TASK;
    let block: string | null = null;
    try {
      const read = readSpec(ctx.cwd, task);
      block = renderIterationBlock(read.spec, read.state, state);
    } catch (e) {
      debug(debugEnabled, `readSpec failed: ${(e as Error).message}`);
      block = null;
    }
    if (!block) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  // ── Phase 4: strict edit-without-check tracking ───────────────────
  //
  // Count write/edit invocations whose target path matches the
  // declared artifact. We watch `tool_result` (after successful
  // execution) so failed edits don't pad the counter. `check run`
  // resets the counter via `actRun`; guardrail reads it at
  // `agent_end`.
  pi.on('tool_result', (event, ctx) => {
    if (!state || state.stopReason) return;
    const ev = event as {
      toolName?: string;
      isError?: boolean;
      input?: Record<string, unknown>;
    };
    if (ev.isError) return;
    const toolName = typeof ev.toolName === 'string' ? ev.toolName : '';
    const targets = extractEditTargets(toolName, ev.input);
    if (targets.length === 0) return;
    // Resolve spec from disk to get the declared artifact path.
    let artifactPath: string | null = null;
    try {
      const read = readSpec(ctx.cwd, state.task);
      if (read.state === 'active' && read.spec) artifactPath = read.spec.artifact;
    } catch {
      /* readSpec failures mean we skip tracking this turn — fine */
    }
    if (!artifactPath) return;
    if (!anyArtifactMatch(artifactPath, targets, ctx.cwd)) return;
    const result: ActionResult = actRecordEdit(state);
    if (!result.ok) {
      debug(debugEnabled, `actRecordEdit refused: ${result.error}`);
      return;
    }
    state = result.state;
    try {
      pi.appendEntry(ITERATION_CUSTOM_TYPE, cloneIterationState(state));
    } catch (e) {
      debug(debugEnabled, `appendEntry after edit failed: ${(e as Error).message}`);
    }
    debug(
      debugEnabled,
      `edit tracked: tool=${toolName} artifact=${artifactPath} editsSinceLastCheck=${state.editsSinceLastCheck}`,
    );
  });

  // ── Phase 4: guardrail nudges on agent_end ─────────────────────────
  //
  // Two nudges, distinct triggers:
  //
  //   - Claim nudge: final assistant message matches an artifact-
  //     correctness claim regex. De-duped against
  //     `verify-before-claim` — if v-b-c would fire on the same
  //     message (it has unverified test/lint/build claims), we
  //     suppress ours. We re-run v-b-c's detection helpers inline
  //     so hook-ordering doesn't matter.
  //
  //   - Strict edit-without-check nudge: `editsSinceLastCheck` is
  //     at/above threshold. Always fires on its own trigger, even
  //     if the claim nudge was suppressed.
  //
  // Both nudges require `!checkRanThisTurn` (a successful `check
  // run` erases the need to prompt) and an active (non-terminated)
  // loop.
  pi.on('agent_end', (event, ctx) => {
    if (!state || state.stopReason) return;
    if (checkRanThisTurn) return;

    const messages = (event as { messages?: readonly unknown[] }).messages ?? [];
    const text = extractLastAssistantText(messages);
    const branch = ctx.sessionManager.getBranch() as unknown as readonly VerifyBranchEntry[];

    // ── Strict edit-without-check nudge ───────────────────────────
    const threshold = loopConfig.strictNudgeAfterNEdits;
    const strictFired = lastUserMessageHasMarker(branch, STRICT_NUDGE_MARKER);
    let strictSent = false;
    if (state.editsSinceLastCheck >= threshold && !strictFired) {
      const msg =
        `${STRICT_NUDGE_MARKER} You've edited the declared artifact ` +
        `\`${readArtifactPath(ctx.cwd, state.task) ?? '(artifact)'}\` ` +
        `${state.editsSinceLastCheck} time(s) without running the check. ` +
        `Call \`check run task=${state.task}\` now to verify the changes ` +
        `against the rubric before claiming anything about the artifact. ` +
        `If you're mid-edit and the next edit is atomic, make it, then run the check.`;
      try {
        pi.sendUserMessage(msg, { deliverAs: 'followUp' });
        strictSent = true;
        debug(
          debugEnabled,
          `strict nudge fired: editsSinceLastCheck=${state.editsSinceLastCheck} threshold=${threshold}`,
        );
      } catch (e) {
        ctx.ui.notify(`iteration-loop: failed to deliver strict nudge: ${String(e)}`, 'error');
      }
    }

    // ── Claim nudge ──────────────────────────────────────────────
    if (!text) return;
    const matched = matchesClaimRegex(loopConfig.claimRegexes, text);
    if (!matched) return;
    // Suppress when the strict nudge already fired this turn —
    // firing both at once overwhelms the model and the strict
    // message already tells it to run the check.
    if (strictSent) {
      debug(debugEnabled, 'claim nudge suppressed: strict nudge fired on same turn');
      return;
    }
    // De-dupe against verify-before-claim. If v-b-c would fire on
    // this same message (there are unverified test/lint/build
    // claims), let it handle the nag. Our claim nudge covers
    // artifact-correctness sign-offs which are a different axis;
    // it's worth deferring when the simpler generic nag is in play.
    try {
      const vbcClaims = extractClaims(text);
      if (vbcClaims.length > 0) {
        const vbcCommands = collectBashCommandsSinceLastUser(branch);
        const { unverified } = partitionClaims(vbcClaims, vbcCommands, []);
        const vbcAlreadySteered = lastUserMessageHasMarker(branch, VERIFY_MARKER);
        if (unverified.length > 0 && !vbcAlreadySteered) {
          debug(debugEnabled, 'claim nudge suppressed: verify-before-claim will fire');
          return;
        }
      }
    } catch (e) {
      debug(debugEnabled, `v-b-c dedupe check threw: ${(e as Error).message}`);
      /* fall through to send — better to nag than silently swallow */
    }
    const claimFired = lastUserMessageHasMarker(branch, CLAIM_NUDGE_MARKER);
    if (claimFired) {
      debug(debugEnabled, 'claim nudge suppressed: marker already on last user message');
      return;
    }
    const msg =
      `${CLAIM_NUDGE_MARKER} You claimed the artifact is correct (matched: \`${matched.source}\`), ` +
      `but you haven't run \`check run task=${state.task}\` this turn. ` +
      `Either run the check to confirm, or retract the claim. The iteration-loop contract is: ` +
      `no "looks right / done / matches spec" without a passing verdict in the same turn.`;
    try {
      pi.sendUserMessage(msg, { deliverAs: 'followUp' });
      debug(debugEnabled, `claim nudge fired: matched /${matched.source}/`);
    } catch (e) {
      ctx.ui.notify(`iteration-loop: failed to deliver claim nudge: ${String(e)}`, 'error');
    }
  });

  // ── Action implementations ──────────────────────────────────────────

  const doDeclare = (
    params: {
      task?: string;
      kind?: CheckKind;
      artifact?: string;
      cmd?: string;
      passOn?: string;
      env?: Record<string, string>;
      workdir?: string;
      timeoutMs?: number;
      rubric?: string;
      agent?: string;
      modelOverride?: string;
      maxIter?: number;
      maxCostUsd?: number;
      wallClockSeconds?: number;
    },
    ctx: ExtensionContext,
  ): ToolReturn => {
    const task = (params.task ?? DEFAULT_TASK).trim() || DEFAULT_TASK;
    const built = buildSpecFromParams(task, params);
    if (!built.ok) return errorReturn('declare', task, built.error);

    const written = writeDraft(ctx.cwd, built.spec);
    if (!written.ok) return errorReturn('declare', task, written.error);

    const jsonPreview = JSON.stringify(built.spec, null, 2);
    const text =
      `Draft check written to ${draftPath(ctx.cwd, task)}.\n\n` +
      `Surface this draft to the user and ask them to review it. ` +
      `Iterations cannot run until the user accepts via \`check accept task=${task}\` ` +
      `(they may edit the draft JSON directly before accepting).\n\n` +
      `${jsonPreview}`;
    debug(debugEnabled, `declare: wrote draft for task=${task}`);
    return {
      content: [{ type: 'text', text }],
      details: { action: 'declare', task, spec: built.spec, specState: 'draft' },
    };
  };

  const doAccept = (params: { task?: string }, ctx: ExtensionContext): ToolReturn => {
    const task = (params.task ?? DEFAULT_TASK).trim() || DEFAULT_TASK;
    const accepted = acceptDraft(ctx.cwd, task, nowIso());
    if (!accepted.ok) return errorReturn('accept', task, accepted.error);

    const result: ActionResult = actAccept(state, { task, acceptedAt: accepted.spec.acceptedAt ?? nowIso() });
    if (!result.ok) {
      // Should not happen — we just wrote a valid spec — but surface it
      // rather than crashing.
      return errorReturn('accept', task, result.error);
    }
    state = result.state;
    try {
      pi.appendEntry(ITERATION_CUSTOM_TYPE, cloneIterationState(state));
    } catch (e) {
      debug(debugEnabled, `appendEntry after accept failed: ${(e as Error).message}`);
    }

    debug(debugEnabled, `accept: task=${task}`);
    const text =
      `${result.summary}\n\nActive spec: ${activePath(ctx.cwd, task)}\n` +
      `Next step: run \`check run task=${task}\` to execute iteration 1.`;
    return {
      content: [{ type: 'text', text }],
      details: {
        action: 'accept',
        task,
        state: cloneIterationState(state),
        spec: accepted.spec,
        specState: 'active',
      },
    };
  };

  // ── Critic subagent runner ─────────────────────────────────────────
  //
  // Wraps the shared one-shot spawn helper (lib/node/pi/subagent-spawn.ts)
  // so the critic doesn't re-implement model resolution, timeout/abort
  // plumbing, or stop-reason classification. We only need aggregate
  // cost (for budget-cost enforcement) and the raw final text (for
  // parseVerdict) on top of the generic result.
  interface CriticRunResult {
    rawText: string;
    cost: number;
    turns: number;
    error: string | undefined;
  }

  const runCriticSubagent = async (args: {
    ctx: ExtensionContext;
    signal: AbortSignal | undefined;
    spec: CriticCheckSpec;
    artifact: string;
    iteration: number;
  }): Promise<CriticRunResult> => {
    const { ctx, signal, spec, artifact, iteration } = args;
    const agentName = spec.agent ?? 'critic';
    const agent: AgentDef | undefined = agentLoad.agents.get(agentName);
    if (!agent) {
      return {
        rawText: '',
        cost: 0,
        turns: 0,
        error: `agent "${agentName}" not loaded (known: ${agentLoad.nameOrder.join(', ') || '(none)'})`,
      };
    }

    const modelResolution = resolveChildModel({
      override: spec.modelOverride,
      agent,
      parent: ctx.model,
      modelRegistry: ctx.modelRegistry,
    });
    if (!modelResolution.ok) {
      return { rawText: '', cost: 0, turns: 0, error: modelResolution.error };
    }

    const artifactPath = isAbsolute(artifact) ? artifact : join(ctx.cwd, artifact);
    const task = buildCriticTask({ spec, artifactPath, iteration });

    let cost = 0;
    let result;
    try {
      result = await runOneShotAgent({
        deps: { createAgentSession: piCreateAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
        cwd: ctx.cwd,
        agent,
        model: modelResolution.model,
        task,
        modelRegistry: ctx.modelRegistry,
        agentDir: getAgentDir(),
        signal,
        onEvent: ({ event }) => {
          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            const usage = (event.message as { usage?: { cost?: { total?: number } } }).usage;
            if (usage?.cost?.total != null && Number.isFinite(usage.cost.total)) {
              cost += usage.cost.total;
            }
          }
        },
      });
    } catch (e) {
      return { rawText: '', cost, turns: 0, error: `critic spawn: ${(e as Error).message}` };
    }

    let error: string | undefined;
    if (result.stopReason === 'max_turns') error = `critic hit max turns (${agent.maxTurns})`;
    else if (result.stopReason === 'aborted') error = 'critic aborted';
    else if (result.stopReason === 'error') error = result.errorMessage;

    return { rawText: result.finalText, cost, turns: result.turns, error };
  };

  const doRun = async (
    params: { task?: string },
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<ToolReturn> => {
    const task = (params.task ?? DEFAULT_TASK).trim() || DEFAULT_TASK;

    // ── Validation ────────────────────────────────────────────────────
    const read = readSpec(ctx.cwd, task);
    if (read.state === 'none') {
      return errorReturn('run', task, `no check declared for task "${task}" — call \`check declare\` first`);
    }
    if (read.state === 'draft') {
      return errorReturn('run', task, `task "${task}" has a draft pending — call \`check accept task=${task}\` first`);
    }
    if (!read.spec) {
      return errorReturn('run', task, read.error ?? `failed to load spec for "${task}"`);
    }
    if (!state || state.task !== task) {
      // Re-hydrate: this happens when a session loses its branch
      // `iteration-state` entries (e.g. `/compact` dropped them, or
      // the user resumed a pre-Phase-3 session) but the active spec
      // still exists on disk. Previously we bailed with a misleading
      // "re-accept the draft" error; now we seed a fresh empty state
      // using the spec's recorded acceptedAt so `check run` can pick
      // up cleanly.
      const seededAt = read.spec.acceptedAt ?? read.spec.createdAt;
      state = emptyIterationState(task, seededAt);
      try {
        pi.appendEntry(ITERATION_CUSTOM_TYPE, cloneIterationState(state));
      } catch (e) {
        debug(debugEnabled, `appendEntry after rehydrate failed: ${(e as Error).message}`);
      }
      debug(debugEnabled, `re-hydrated iteration state for task=${task} from spec on disk`);
    }
    if (state.stopReason) {
      return errorReturn(
        'run',
        task,
        `loop already terminated (${state.stopReason}) — close and re-declare to continue iterating`,
      );
    }

    const spec = read.spec;
    const nextIteration = state.iteration + 1;

    // ── Snapshot the artifact + compute prev-hash ────────────────────
    // Fixpoint detection needs both the current and previous snapshot's
    // sha256. Storage's snapshotArtifact returns the hash for the
    // current iteration; we rehash the previous iteration's on-disk
    // snapshot ourselves (it's cheap and avoids a schema change to
    // persist lastArtifactHash on IterationState).
    let prevHash: string | null = null;
    if (state.iteration > 0) {
      try {
        const prevPath = snapshotPath(ctx.cwd, task, state.iteration, spec.artifact);
        const bytes = readFileSync(prevPath);
        prevHash = createHash('sha256').update(bytes).digest('hex');
      } catch {
        /* previous snapshot missing or unreadable — treat as no fixpoint candidate */
      }
    }
    let snapshot: { path: string; hash: string } | null = null;
    try {
      snapshot = snapshotArtifact(ctx.cwd, task, nextIteration, spec.artifact);
    } catch (e) {
      debug(debugEnabled, `snapshotArtifact failed: ${(e as Error).message}`);
    }

    // ── Dispatch check kind → Verdict ─────────────────────────────────
    let verdict: Verdict;
    let costDelta = 0;
    if (spec.kind === 'bash') {
      if (!isBashCheckSpecShape(spec.spec)) {
        return errorReturn('run', task, 'bash spec is malformed on disk');
      }
      const bashSpec = spec.spec as BashCheckSpec;
      try {
        verdict = await runBashCheck(bashSpec, { cwd: ctx.cwd }, { signal });
      } catch (e) {
        verdict = {
          approved: false,
          score: 0,
          issues: [{ severity: 'blocker', description: `bash check threw: ${(e as Error).message}` }],
          summary: `bash check threw: ${(e as Error).message}`,
        };
      }
    } else if (spec.kind === 'critic') {
      if (!isCriticCheckSpecShape(spec.spec)) {
        return errorReturn('run', task, 'critic spec is malformed on disk');
      }
      const criticSpec = spec.spec as CriticCheckSpec;
      const runResult = await runCriticSubagent({
        ctx,
        signal,
        spec: criticSpec,
        artifact: spec.artifact,
        iteration: nextIteration,
      });
      costDelta = Number.isFinite(runResult.cost) && runResult.cost > 0 ? runResult.cost : 0;
      if (runResult.error) {
        verdict = {
          approved: false,
          score: 0,
          issues: [{ severity: 'blocker', description: `critic subagent failed: ${runResult.error}` }],
          summary: `critic error: ${runResult.error}`,
          raw: runResult.rawText,
        };
      } else {
        const parsed = parseVerdict(runResult.rawText);
        verdict = parsed.verdict;
        if (parsed.recovery) {
          debug(debugEnabled, `critic verdict recovery: ${parsed.recovery}`);
        }
      }
    } else {
      // All CheckKind variants handled above — if a new kind ever lands
      // without a dispatch branch, this closes the hole loudly.
      const exhaustive: never = spec.kind;
      return errorReturn('run', task, `unknown check kind "${String(exhaustive as unknown)}"`);
    }

    // ── Persist verdict JSON alongside the snapshot ───────────────────
    let verdictWriteError: string | null = null;
    try {
      writeSnapshotVerdict(ctx.cwd, task, nextIteration, verdict);
    } catch (e) {
      verdictWriteError = (e as Error).message;
      debug(debugEnabled, `writeSnapshotVerdict failed: ${verdictWriteError}`);
      ctx.ui.notify(`iteration-loop: verdict write failed: ${verdictWriteError}`, 'warning');
    }

    // ── Stop-reason classification ─────────────────────────────────────
    const stopReason = computeStopReason({
      spec,
      state: {
        iteration: nextIteration,
        lastVerdict: verdict,
        costUsd: state.costUsd + costDelta,
        startedAt: state.startedAt,
      },
      currentArtifactHash: snapshot?.hash ?? null,
      previousArtifactHash: prevHash,
      now: new Date(),
    });

    // ── Reducer: record the run ───────────────────────────────────────
    const ranAt = nowIso();
    const actResult = actRun(state, {
      verdict,
      costDeltaUsd: costDelta,
      turnNumber: currentTurnIndex,
      snapshot,
      stopReason,
      ranAt,
    });
    if (!actResult.ok) {
      return errorReturn('run', task, actResult.error);
    }
    state = actResult.state;
    checkRanThisTurn = true;
    try {
      pi.appendEntry(ITERATION_CUSTOM_TYPE, cloneIterationState(state));
    } catch (e) {
      debug(debugEnabled, `appendEntry after run failed: ${(e as Error).message}`);
    }

    // ── Response text ─────────────────────────────────────────────────
    const lines: string[] = [actResult.summary];
    if (verdict.issues.length > 0) {
      lines.push('Issues:');
      const preview = verdict.issues.slice(0, 3);
      for (const issue of preview) {
        const loc = issue.location ? ` (${issue.location})` : '';
        lines.push(`  [${issue.severity}] ${issue.description}${loc}`);
      }
      if (verdict.issues.length > preview.length) {
        lines.push(`  … ${verdict.issues.length - preview.length} more`);
      }
    }
    if (snapshot) {
      lines.push(`Snapshot: ${snapshot.path}`);
    } else {
      lines.push(`Snapshot: (artifact "${spec.artifact}" not found on disk — fixpoint detection disabled)`);
    }
    if (state.bestSoFar) {
      lines.push(
        `Best so far: iter ${state.bestSoFar.iteration} (score ${state.bestSoFar.score.toFixed(2)}) → ${state.bestSoFar.snapshotPath}`,
      );
    }
    lines.push(`Cost so far: $${state.costUsd.toFixed(4)}`);
    if (stopReason) {
      lines.push(`Stop reason: ${stopReason}`);
      if (stopReason === 'passed') {
        lines.push(`Loop passed — call \`check close task=${task} reason=passed\` to archive it.`);
      } else {
        lines.push(
          `Loop terminated without passing. Either \`check close task=${task} reason=${stopReason}\` to archive the best-so-far, or edit the artifact / spec and re-declare.`,
        );
      }
    } else {
      lines.push(`Next step: edit ${spec.artifact}, then call \`check run task=${task}\` again.`);
    }

    debug(
      debugEnabled,
      `run: task=${task} iter=${nextIteration} approved=${verdict.approved} score=${verdict.score.toFixed(2)} cost+=$${costDelta.toFixed(4)} stopReason=${stopReason ?? 'null'}`,
    );

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: {
        action: 'run',
        task,
        state: cloneIterationState(state),
        spec,
        specState: 'active',
      },
    };
  };

  const doStatus = (params: { task?: string }, ctx: ExtensionContext): ToolReturn => {
    const task = (params.task ?? DEFAULT_TASK).trim() || DEFAULT_TASK;
    const text = formatStatusText(ctx.cwd, task, state && state.task === task ? state : null);
    const read = readSpec(ctx.cwd, task);
    return {
      content: [{ type: 'text', text }],
      details: {
        action: 'status',
        task,
        state: state && state.task === task ? cloneIterationState(state) : null,
        spec: read.spec,
        specState: read.state,
      },
    };
  };

  const doList = (_params: unknown, ctx: ExtensionContext): ToolReturn => {
    const tasks = listTasks(ctx.cwd);
    const archive = listArchive(ctx.cwd);
    const text = formatListing(tasks, archive);
    return {
      content: [{ type: 'text', text }],
      details: { action: 'list' },
    };
  };

  const doClose = (params: { task?: string; reason?: StopReason }, ctx: ExtensionContext): ToolReturn => {
    const task = (params.task ?? DEFAULT_TASK).trim() || DEFAULT_TASK;
    const reason: StopReason = params.reason ?? 'user-closed';
    // Typebox already constrains `reason` to STOP_REASONS, but a
    // programmatic caller that bypassed validation could hand us
    // garbage. Use the shared isStopReason so the schema + extension
    // + reducer all agree on membership.
    if (!isStopReason(reason)) {
      return errorReturn('close', task, `invalid reason "${String(reason)}"`);
    }

    let closedState: IterationState | null = null;
    if (state && state.task === task) {
      const result: ActionResult = actClose(state, { reason });
      if (!result.ok) return errorReturn('close', task, result.error);
      state = result.state;
      closedState = state;
      try {
        pi.appendEntry(ITERATION_CUSTOM_TYPE, cloneIterationState(state));
      } catch (e) {
        debug(debugEnabled, `appendEntry after close failed: ${(e as Error).message}`);
      }
    }

    // Archive on close (default behavior — mirrors the plan's v1 decision).
    let archivedTo: string | null = null;
    try {
      archivedTo = archiveTask(ctx.cwd, task, nowIso());
    } catch (e) {
      debug(debugEnabled, `archiveTask failed: ${(e as Error).message}`);
    }
    // Clean up any lingering draft for this task.
    try {
      discardDraft(ctx.cwd, task);
    } catch {
      /* ignore */
    }

    debug(debugEnabled, `close: task=${task} reason=${reason} archivedTo=${archivedTo ?? '(nothing)'}`);
    const lines = [`Closed task "${task}" — reason: ${reason}.`];
    if (archivedTo) lines.push(`Archived to ${archivedTo}`);
    else lines.push('Nothing on disk to archive.');
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: {
        action: 'close',
        task,
        state: closedState ? cloneIterationState(closedState) : null,
        archivedTo,
      },
    };
  };

  // ── Tool registration ───────────────────────────────────────────────
  pi.registerTool({
    name: ITERATION_TOOL_NAME,
    label: 'Check',
    description:
      'Declare and run an iteration-loop check against an artifact. Actions: ' +
      '`declare` (draft a spec — kind=bash|critic, artifact=<path>, plus kind-specific args), ' +
      '`accept` (user/model confirms the draft, starts the loop), ' +
      '`run` (execute one iteration; dispatches the check and records the verdict), ' +
      '`status` (read the current spec + iteration state), ' +
      '`close` (terminate the loop with a stop reason and archive the task), ' +
      '`list` (enumerate active/draft/archived tasks). ' +
      'v1 supports a single active task named `default`; bash and critic check kinds only.',
    promptSnippet:
      'For artifact-producing tasks (rendered image, SVG, generated config, regex output) declare a check up front and iterate until the verdict approves.',
    promptGuidelines: [
      'Call `check` with action `declare` before producing the artifact. Pick `kind=bash` for deterministic pass/fail (tests, validators, exit-code commands) or `kind=critic` for subjective or visual verification (images, prose, design).',
      'After declaring, surface the draft JSON to the user and ask them to accept it. Do not call `check run` until the user has accepted via `check accept` (the extension enforces this — drafts cannot run).',
      'Iterate in a tight loop: edit → `check run` → read verdict → edit. Do NOT claim the artifact is done without a passing verdict from `check run` this turn.',
      'On budget exhaustion (`budget-iter` / `budget-cost` / `wall-clock`), report the best-so-far snapshot to the user and let them decide to extend the budget or accept it.',
      'Call `check close reason=<reason>` when the loop terminates — it archives the task directory under `.pi/checks/archive/`.',
    ],
    parameters: CheckParams,

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as unknown as {
        action: CheckAction;
        task?: string;
        kind?: CheckKind;
        artifact?: string;
        cmd?: string;
        passOn?: string;
        env?: Record<string, string>;
        workdir?: string;
        timeoutMs?: number;
        rubric?: string;
        agent?: string;
        modelOverride?: string;
        maxIter?: number;
        maxCostUsd?: number;
        wallClockSeconds?: number;
        reason?: StopReason;
      };
      switch (params.action) {
        case 'declare':
          return doDeclare(params, ctx);
        case 'accept':
          return doAccept(params, ctx);
        case 'run':
          return doRun(params, ctx, signal);
        case 'status':
          return doStatus(params, ctx);
        case 'list':
          return doList(params, ctx);
        case 'close':
          return doClose(params, ctx);
      }
    },

    renderCall(args, theme, _context) {
      let text = theme.fg('toolTitle', theme.bold('check ')) + theme.fg('muted', String(args.action ?? ''));
      if (args.task && args.task !== DEFAULT_TASK) {
        text += ` ${theme.fg('accent', `(${args.task})`)}`;
      }
      if (args.action === 'declare' && args.kind) {
        text += ` ${theme.fg('dim', `[${args.kind}]`)}`;
      }
      if (args.action === 'declare' && args.artifact) {
        text += ` ${theme.fg('dim', `→ ${truncate(String(args.artifact), 60)}`)}`;
      }
      if (args.action === 'close' && args.reason) {
        text += ` ${theme.fg('warning', String(args.reason))}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme, _context) {
      const details = (result.details ?? {}) as Partial<CheckDetails>;
      if (details.error) {
        return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);
      }
      const parts: string[] = [];
      const taskLabel = details.task ? ` (${details.task})` : '';
      switch (details.action) {
        case 'declare':
          parts.push(
            `${theme.fg('accent', '✎ declare')}${theme.fg('muted', taskLabel)}${theme.fg('dim', ' — draft written')}`,
          );
          break;
        case 'accept':
          parts.push(
            `${theme.fg('success', '✓ accept')}${theme.fg('muted', taskLabel)}${theme.fg('dim', ' — loop armed')}`,
          );
          break;
        case 'run': {
          const s = details.state ?? null;
          if (!s || !s.lastVerdict) {
            parts.push(theme.fg('dim', `… run${taskLabel} (no verdict recorded)`));
          } else {
            const mark = s.lastVerdict.approved ? theme.fg('success', '✓') : theme.fg('warning', '·');
            const scoreStr = s.lastVerdict.score.toFixed(2);
            const stop = s.stopReason ? ` ${theme.fg('error', `[${s.stopReason}]`)}` : '';
            parts.push(`${mark} ${theme.fg('accent', `iter ${s.iteration}`)}${taskLabel} score ${scoreStr}${stop}`);
          }
          break;
        }
        case 'status': {
          const s = details.state ?? null;
          if (!s) {
            parts.push(theme.fg('dim', `(no active loop for task ${details.task ?? DEFAULT_TASK})`));
          } else {
            parts.push(
              theme.fg('muted', `iter ${s.iteration}`) +
                (s.lastVerdict
                  ? ` ${theme.fg(s.lastVerdict.approved ? 'success' : 'warning', s.lastVerdict.approved ? '✓' : '·')} score ${s.lastVerdict.score.toFixed(2)}`
                  : '') +
                (s.stopReason ? ` ${theme.fg('error', `[${s.stopReason}]`)}` : ''),
            );
          }
          break;
        }
        case 'close':
          parts.push(
            `${theme.fg('muted', '✕ closed')}${taskLabel}` +
              (details.archivedTo ? ` ${theme.fg('dim', `→ ${details.archivedTo}`)}` : ''),
          );
          break;
        case 'list':
          parts.push(theme.fg('muted', 'registry listing'));
          break;
      }
      return new Text(parts.join('\n'), 0, 0);
    },
  });
}

// Re-export the reducer types so ad-hoc consumers (e.g. a future
// `/check` slash command) can read state without pulling in a second
// import path.
export type { IterationState } from '../../../lib/node/pi/iteration-loop-schema.ts';
