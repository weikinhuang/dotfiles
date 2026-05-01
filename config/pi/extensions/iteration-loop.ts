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
 * ## Phase 2 scope (this commit)
 *
 * This commit lands the critic agent + the extension skeleton. It
 * registers the `check` tool with six actions (`declare`, `accept`,
 * `run`, `status`, `close`, `list`) and wires the `## Iteration
 * Loop` system-prompt injection. The `run` action is deliberately
 * stubbed — it returns an error asking for Phase 3. Everything else
 * (draft/accept/status/list/close) is complete.
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

import { StringEnum } from '@mariozechner/pi-ai';
import { type ExtensionAPI, type ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Text } from '@mariozechner/pi-tui';
import { Type } from 'typebox';
import { renderIterationBlock } from '../../../lib/node/pi/iteration-loop-prompt.ts';
import {
  actAccept,
  actClose,
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
  type CriticCheckSpec,
  type IterationState,
  type StopReason,
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
  type TaskListing,
  writeDraft,
} from '../../../lib/node/pi/iteration-loop-storage.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';

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
  });

  pi.on('session_tree', (_event, ctx) => {
    rebuildFromSession(ctx);
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

  const doRun = (params: { task?: string }): ToolReturn => {
    const task = (params.task ?? DEFAULT_TASK).trim() || DEFAULT_TASK;
    return errorReturn(
      'run',
      task,
      'not yet implemented in Phase 2 — land Phase 3 first. See plans/pi-iteration-loop.md.',
    );
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
    if (!(STOP_REASONS as readonly string[]).includes(reason)) {
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

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
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
          return doRun(params);
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
        case 'run':
          parts.push(theme.fg('warning', '… run (not implemented in Phase 2)'));
          break;
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
