/**
 * Background bash tool for pi.
 *
 * Runs shell commands off the main agent turn and exposes a single
 * multi-action tool (`bg_bash`) that the LLM uses across subsequent
 * turns to check on, steer, and collect output from those commands.
 *
 * Design summary (see `lib/node/pi/bg-bash-reducer.ts` for the pure
 * state model and the design rationale):
 *
 *   - Jobs live only for the lifetime of the current pi session. On
 *     `session_shutdown` we SIGTERM every live job (3s grace, then
 *     SIGKILL). Previously-running jobs reconstructed from a branch
 *     on `session_start` are marked `terminated` rather than
 *     `running`, so the LLM sees an honest picture after a new
 *     runtime starts.
 *
 *   - Each spawn goes into its own process group (`detached: true`).
 *     `signal`/`remove` then target the whole group via
 *     `process.kill(-pid, sig)`, so children of the shell die too.
 *
 *   - stdout/stderr are tee'd into:
 *       1. an in-memory `RingBuffer` per stream (default 1 MiB each)
 *          with byte-cursor resumable reads and line-aware `tailLines`
 *          / `grep` helpers,
 *       2. an on-disk log file, so anything evicted from memory is
 *          still recoverable via the returned path.
 *
 *   - After every state mutation we persist a snapshot of the registry
 *     (metadata only - not the live ChildProcess / buffers) to the
 *     session branch as both a `toolResult.details` payload and a
 *     `customType: 'bg-bash-state'` custom entry. This survives
 *     `/compact` and travels with `/fork`, `/tree`.
 *
 *   - Every turn the current "## Background Jobs" block is injected as
 *     an ephemeral `<system-reminder>` spliced into the last
 *     user/toolResult turn via the `context` hook (not the system
 *     prompt), so even weak models remember what's running while the
 *     system-prompt prefix stays byte-stable for the provider's prompt
 *     cache. See lib/node/pi/context-reminder.ts.
 *
 *   - `start` routes through the shared `bash-gate` contract, so the
 *     user's bash-permissions allow/deny rules apply to background
 *     commands too.
 *
 *   - By default `start` spawns the child with stdin redirected from
 *     /dev/null (`stdio[0] = 'ignore'`). Commands that happen to read
 *     stdin when there's no terminal (pi's own CLI, `cat`, `ssh`
 *     without `-n`, `grep` with no file args, nested agents) then see
 *     an immediate EOF instead of blocking forever on an inherited
 *     pipe that never closes. Pass `interactiveStdin: true` to opt
 *     into the old `stdio[0] = 'pipe'` behaviour so the `stdin` action
 *     can feed a REPL / interactive installer / long-lived process.
 *
 * Environment:
 *   PI_BG_BASH_DISABLED=1             skip the extension entirely
 *   PI_BG_BASH_DISABLE_AUTOINJECT=1   tool still works but skip the
 *                                     active-jobs `context`-hook block
 *   PI_BG_BASH_MAX_INJECTED_CHARS=N   soft cap on the injected block
 *                                     (default 1500)
 *   PI_BG_BASH_MAX_BUFFER_BYTES=N     per-stream ring buffer cap
 *                                     (default 1 MiB)
 *   PI_BG_BASH_KILL_GRACE_MS=N        SIGTERM→SIGKILL grace window on
 *                                     session_shutdown (default 3000)
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { StringEnum } from '@earendil-works/pi-ai';
import { type ExtensionAPI, type ExtensionContext, type Theme } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { requestBashApproval } from '../../../lib/node/pi/bash/gate.ts';
import { showModal } from '../../../lib/node/pi/ext/show-modal.ts';
import { LiveToolCards } from '../../../lib/node/pi/ext/live-tool-cards.ts';
import { BgBashOverlay, glyphColor } from '../../../lib/node/pi/ext/bg-bash-overlay.ts';
import {
  type BgBashConfig,
  type BgBashShell,
  DEFAULT_BG_BASH_CONFIG,
  loadBgBashConfig,
} from '../../../lib/node/pi/bg-bash/config.ts';
import { bashOnlySyntaxWarning, shellSpawnArgs } from '../../../lib/node/pi/bg-bash/shell.ts';
import { WaitBarrier } from '../../../lib/node/pi/bg-bash/wait-barrier.ts';
import { deliveredTerminalJobs, PendingCompletions } from '../../../lib/node/pi/bg-bash/completions.ts';
import { attachJobIo } from '../../../lib/node/pi/bg-bash-job-io.ts';
import {
  BG_BASH_NUDGE_CUSTOM_TYPE,
  type BgBashNudgeDetails,
  formatBgBashNudge,
} from '../../../lib/node/pi/bg-bash/nudge.ts';
import { BG_BASH_USAGE } from '../../../lib/node/pi/bg-bash/usage.ts';
import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import {
  clampBytes,
  formatJobHeader,
  formatJobLine,
  formatState,
  tailLines,
  tailN,
} from '../../../lib/node/pi/bg-bash-format.ts';
import {
  BG_SURFACED_TYPE,
  formatBackgroundJobs,
  readSurfacedTerminalIds,
} from '../../../lib/node/pi/bg-bash-prompt.ts';
import { extractContentText } from '../../../lib/node/pi/message-text.ts';
import {
  applyContextReminder,
  contextRemindersEnabled,
  type ReminderMessage,
} from '../../../lib/node/pi/context-reminder.ts';
import { releaseSandboxWrap, requestSandboxWrap } from '../../../lib/node/pi/sandbox/wrapper-slot.ts';
import {
  bgBashStreamCursor,
  bgBashStreamDropped,
  bgBashStreamTotal,
  mergeBgBashStreams,
  readBgBashStream,
} from '../../../lib/node/pi/bg-bash-stream.ts';
import {
  allocateId as allocateJobId,
  BG_BASH_CUSTOM_TYPE,
  type BgBashState,
  type BranchEntry,
  cloneState,
  cloneSummary,
  emptyState,
  findJob,
  type JobStatus,
  type JobSummary,
  markLiveJobsTerminated,
  isJobRunning,
  pruneUnattachableJobs,
  reduceBranch,
  removeJob,
  upsertJob,
} from '../../../lib/node/pi/bg-bash-reducer.ts';
import { RingBuffer } from '../../../lib/node/pi/bg-bash-ring.ts';
import { SIGNALS, type SignalName } from '../../../lib/node/pi/bg-bash/signals.ts';
import { resolveCwd } from '../../../lib/node/pi/bg-bash/resolve-cwd.ts';
import { formatLogsText, formatStartResult, formatWaitResult } from '../../../lib/node/pi/bg-bash/results.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { piAgentPath } from '../../../lib/node/pi/pi-paths.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Tuning
// ──────────────────────────────────────────────────────────────────────

// Defaults for the per-call params and the ring-buffer cap now live in
// DEFAULT_BG_BASH_CONFIG (lib/node/pi/bg-bash/config.ts); the schema
// descriptions below quote them so the help text never drifts from the
// resolved fallback.
const TAIL_PREVIEW_BYTES = 200;

// ──────────────────────────────────────────────────────────────────────
// Parameter schema
// ──────────────────────────────────────────────────────────────────────

const STREAMS = ['stdout', 'stderr', 'merged'] as const;
type StreamName = (typeof STREAMS)[number];

const BgBashParams = Type.Object({
  action: StringEnum(['start', 'list', 'status', 'logs', 'wait', 'signal', 'stdin', 'remove'] as const, {
    description: 'Which operation to perform.',
  }),
  command: Type.Optional(
    Type.String({
      description: 'Shell command for `start`. Run via /bin/sh -c by default; see `shell`.',
    }),
  ),
  shell: Type.Optional(
    StringEnum(['sh', 'bash'] as const, {
      description:
        '`start` only. `sh` (/bin/sh -c: dash on Linux, POSIX-mode bash on macOS) or `bash` (bash -c). ' +
        `Default ${DEFAULT_BG_BASH_CONFIG.shell} (overridable via bg-bash.json). ` +
        'Use `bash` for bash-only syntax such as ${PIPESTATUS[0]}, [[ ]], <(...), arrays.',
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: '`start` working dir (absolute or relative to agent cwd). Defaults to agent cwd.',
    }),
  ),
  label: Type.Optional(
    Type.String({
      description: 'Short human label shown in `list` and the injected status block (for `start`).',
    }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: '`start` extra env vars, merged over the agent env (values override).',
    }),
  ),
  id: Type.Optional(
    Type.String({
      description: 'Job id (required for all per-job actions: `status`, `logs`, `wait`, `signal`, `stdin`, `remove`).',
    }),
  ),
  stream: Type.Optional(
    StringEnum(STREAMS, {
      description: '`logs` only. Which stream to return. Default `merged` (stdout+stderr chronologically-ish).',
    }),
  ),
  tail: Type.Optional(
    Type.Integer({
      description: '`logs` only. Return only the last N lines.',
    }),
  ),
  sinceCursor: Type.Optional(
    Type.Integer({
      description: '`logs` only. Byte cursor from a prior `logs` call; returns only newer output.',
    }),
  ),
  grep: Type.Optional(
    Type.String({
      description: '`logs` only. Return only lines matching this JS regex (no flags).',
    }),
  ),
  maxBytes: Type.Optional(
    Type.Integer({
      description: `\`logs\` only. Soft cap on response bytes. Default ${DEFAULT_BG_BASH_CONFIG.maxBytes} (overridable via bg-bash.json).`,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      description: `\`wait\` only. Milliseconds to wait for exit before returning with timedOut=true. Default ${DEFAULT_BG_BASH_CONFIG.timeoutMs} (overridable via bg-bash.json).`,
    }),
  ),
  signal: Type.Optional(
    StringEnum(SIGNALS, {
      description: "`signal` only. POSIX signal to send to the job's process group. Default SIGTERM.",
    }),
  ),
  text: Type.Optional(
    Type.String({
      description: "`stdin` only. Text to write to the job's stdin. Append a trailing newline yourself if needed.",
    }),
  ),
  eof: Type.Optional(
    Type.Boolean({
      description: '`stdin` only. Close stdin after writing `text`.',
    }),
  ),
  interactiveStdin: Type.Optional(
    Type.Boolean({
      description:
        '`start` only. Open a stdin pipe so action `stdin` can drive the child (REPLs, `sqlite3`, `python -i`). ' +
        'Default false: stdin is /dev/null, so commands that read stdin get EOF instead of hanging.',
    }),
  ),
  nudge: Type.Optional(
    Type.Boolean({
      description:
        '`start` only. Notify on an unhandled completion (wakes you when idle); already-delivered outcomes do not nudge again.',
    }),
  ),
});

type BgBashAction = 'start' | 'list' | 'status' | 'logs' | 'wait' | 'signal' | 'stdin' | 'remove';

interface BgBashDetails extends BgBashState {
  action: BgBashAction;
  job?: JobSummary;
  cursor?: number;
  totalBytes?: number;
  droppedBytes?: number;
  droppedBefore?: boolean;
  timedOut?: boolean;
  error?: string;
  logExcerpt?: string;
}

interface ToolReturn {
  content: { type: 'text'; text: string }[];
  details: BgBashDetails;
  isError?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// In-memory job record (lives only for the runtime; never persisted).
// ──────────────────────────────────────────────────────────────────────

interface LiveJob {
  summary: JobSummary;
  /**
   * The shell process. Undefined if spawn failed (`summary.status === 'error'`)
   * or once its stdio has closed. We keep the record around for metadata
   * after exit; only the child is released.
   */
  child?: ChildProcess;
  stdout: RingBuffer;
  stderr: RingBuffer;
  logStream?: WriteStream;
  /**
   * Resolves when the job is finalized: the child exited AND its stdio
   * closed, or the post-exit drain deadline passed. Multiple `wait` calls
   * can await the same promise. Always resolves (never rejects) so callers
   * can race it with a timeout without unhandled rejections.
   */
  exited: Promise<void>;
  setExited: () => void;
}

// ──────────────────────────────────────────────────────────────────────
// Module-scope pure helpers. Defined above the extension factory so
// oxlint's `no-use-before-define` stays happy and so they're trivial
// to import into unit tests if we ever want to.
// ──────────────────────────────────────────────────────────────────────

function errorReturn(action: BgBashAction, message: string): ToolReturn {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    details: { jobs: [], nextId: 1, action, error: message },
    isError: true,
  };
}

/**
 * Theme the stable single-line header produced by `formatJobHeader`. The
 * helper returns a plain string of the form
 * `<glyph> [<id>]<label?>  <cmd>   <phrase>   <bytes>` which we colour
 * here so the lead glyph stays visually distinct from the muted body.
 */
function renderJobHeader(job: JobSummary, theme: Theme, opts: { timedOut?: boolean } = {}): string {
  const raw = formatJobHeader(job, Date.now(), opts);
  // Slice off the lead `<glyph> ` so we can colour it separately.
  const glyph = raw.slice(0, 1);
  const rest = raw.slice(2);
  // Re-extract the `[<id>]` so it can be bolded.
  const idMatch = /^\[[^\]]+\]/.exec(rest);
  if (!idMatch) {
    return `${theme.fg(glyphColor(job, opts), glyph)} ${theme.fg('muted', rest)}`;
  }
  const idSeg = idMatch[0];
  const tail = rest.slice(idSeg.length);
  return (
    `${theme.fg(glyphColor(job, opts), glyph)} ` +
    `${theme.fg('toolTitle', theme.bold(idSeg))}` +
    `${theme.fg('muted', tail)}`
  );
}

function renderRegistryLine(j: JobSummary, theme: Theme): string {
  const icon =
    j.status === 'running'
      ? theme.fg('warning', '●')
      : j.status === 'exited' && (j.exitCode ?? 0) === 0
        ? theme.fg('success', '✓')
        : j.status === 'terminated'
          ? theme.fg('muted', '◌')
          : theme.fg('error', '✗');
  const head = `${icon} ${theme.fg('toolTitle', theme.bold(`[${j.id}]`))}`;
  const body = theme.fg('dim', truncate(j.command.replace(/\s+/g, ' '), 100));
  return `  ${head} ${body}`;
}

/** Best-effort signal send to a job's process group. */
function sendSignalTo(job: LiveJob, sig: SignalName): boolean {
  const child = job.child;
  if (child?.exitCode !== null || child.pid === undefined) return false;
  try {
    // Negative pid => whole process group. The child was spawned with
    // `detached: true`, so its pid IS the pgid.
    process.kill(-child.pid, sig);
    return true;
  } catch {
    // Fall back to signaling just the shell.
    try {
      child.kill(sig);
      return true;
    } catch {
      return false;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// /bg-bash overlay tick cadence. The overlay component itself lives in
// lib/node/pi/ext/bg-bash-overlay.ts; this is the refresh interval the
// command handler drives it at so live byte counts stay fresh.
// ──────────────────────────────────────────────────────────────────────

const OVERLAY_TICK_MS = 500;

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function bgBashExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_BG_BASH_DISABLED)) return;

  // Aspect-level disable - whether to register the system-prompt
  // injection handler at all. Registration-time decision, so it stays an
  // env read rather than a config-file field.
  const autoInjectEnabled = process.env.PI_BG_BASH_DISABLE_AUTOINJECT !== '1' && contextRemindersEnabled(process.env);

  // Aspect-level disable for the completion nudge. When off, the `nudge`
  // param / config is simply ignored - jobs still run, the active-jobs
  // block still surfaces them on the next turn. Registration-time env read.
  const nudgeEnabled = process.env.PI_BG_BASH_DISABLE_NUDGE !== '1';

  // Resolved config (built-in -> env knob -> user -> project). Seeded at
  // registration from `process.cwd()` (no ctx yet) and re-loaded on
  // session_start once the real `ctx.cwd` is known, so a project-local
  // `<cwd>/.pi/bg-bash.json` applies. The operational knobs
  // (maxBufferBytes / killGraceMs / maxInjectedChars) and the per-call
  // tool-param defaults (timeoutMs / stream / maxBytes / tail) both read
  // off this object.
  let config: BgBashConfig = loadBgBashConfig(process.cwd());

  // Per-runtime stores. Both are rebuilt from the branch on session_start;
  // `live` is always empty there (we can't reattach) - only `state` is
  // hydrated so the LLM can still inspect the job metadata.
  let state: BgBashState = emptyState();
  const live = new Map<string, LiveJob>();
  // Removed terminal shells may still own inherited pipes. Keep draining their
  // disk logs, but never resurrect registry records or completion notifications.
  const draining = new Map<string, LiveJob>();
  const startCards = new LiveToolCards<JobSummary>();

  let logDir: string | undefined;

  // ── Statusline integration ─────────────────────────────────────────
  //
  // `statusline.ts` appends every entry in `footerData.getExtensionStatuses()`
  // to line 3 of the footer. We just keep the slot up to date with the
  // live-job count and let the statusline renderer do the rest. Clearing
  // the slot (undefined) removes the indicator entirely when no jobs are
  // running, so quiet sessions don't get a spurious ` bg:0 ` token.
  //
  // `uiRef` is captured on session_start and refreshed every time pi hands
  // us a fresh ctx (before_agent_start, session_tree). This keeps the ref
  // pointed at whatever the current UI surface is - some session replace
  // flows rebind `ctx.ui`.
  let uiRef: ExtensionContext['ui'] | undefined;
  let lastStatusRunning = -1; // sentinel: forces the first paint
  let surfacedTerminalIds = new Set<string>();

  // Keep completion identities here until a result or a committed digest really
  // delivers them. Busy runs never enqueue irrevocable follow-up messages.
  const pendingNudge = new PendingCompletions();
  const waits = new WaitBarrier();
  const NUDGE_COALESCE_MS = 250;
  let currentCtx: ExtensionContext | undefined;
  let shuttingDown = false;
  let nudgeSuspended = false;
  let generation = 0;
  let idleAttempts = 0;
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let deliveryAttempt: { id: string; jobs: JobSummary[] } | undefined;

  const cancelNudgeTimer = (): void => {
    clearTimeout(nudgeTimer);
    nudgeTimer = undefined;
  };
  const clearDeliveryAttempt = (): void => {
    clearTimeout(confirmTimer);
    confirmTimer = undefined;
    deliveryAttempt = undefined;
  };
  const acknowledgeTerminals = (text: string, details?: unknown): void => {
    const ids = deliveredTerminalJobs(text, details, state);
    pendingNudge.forget(ids);
    if (pendingNudge.size === 0) cancelNudgeTimer();
    const fresh = ids.filter((id) => !surfacedTerminalIds.has(id));
    for (const id of fresh) surfacedTerminalIds.add(id);
    if (deliveryAttempt?.jobs.every((job) => surfacedTerminalIds.has(job.id))) {
      clearDeliveryAttempt();
      idleAttempts = 0;
    }
    if (fresh.length > 0) pi.appendEntry(BG_SURFACED_TYPE, fresh);
  };
  const reconcileDelivery = (ctx: ExtensionContext): void => {
    if (!deliveryAttempt) return;
    // Boundary custom messages commit without extension message_end events.
    const id = deliveryAttempt.id;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'custom_message' || entry.customType !== BG_BASH_NUDGE_CUSTOM_TYPE) continue;
      const details = entry.details as BgBashNudgeDetails | undefined;
      if (details?.deliveryId !== id) continue;
      acknowledgeTerminals(extractContentText(entry.content), details);
      clearDeliveryAttempt();
      idleAttempts = 0;
      break;
    }
  };
  const readyNudges = (): JobSummary[] => pendingNudge.select(state, surfacedTerminalIds, (id) => waits.count(id) > 0);
  const makeNudge = (
    jobs: JobSummary[],
  ): {
    customType: string;
    content: string;
    display: boolean;
    details: BgBashNudgeDetails & { deliveryId: string };
  } => {
    const deliveryId = randomUUID();
    return {
      customType: BG_BASH_NUDGE_CUSTOM_TYPE,
      content: formatBgBashNudge(jobs, Date.now()),
      display: true,
      details: { jobs, deliveryId },
    };
  };
  const warnDelivery = (): void => {
    try {
      uiRef?.notify(
        'Background completion delivery failed; unhandled jobs remain pending for the next run.',
        'warning',
      );
    } catch {
      // A detached UI must not break job finalization.
    }
  };
  function flushNudge(): void {
    nudgeTimer = undefined;
    const ctx = currentCtx;
    if (!ctx || shuttingDown || nudgeSuspended || !nudgeEnabled) return;
    reconcileDelivery(ctx);
    if (deliveryAttempt || !ctx.isIdle()) return;
    const jobs = readyNudges();
    if (jobs.length === 0) return;
    const message = makeNudge(jobs);
    const id = message.details.deliveryId;
    deliveryAttempt = { id, jobs };
    idleAttempts++;
    try {
      pi.sendMessage(message, { triggerTurn: true });
    } catch {
      clearDeliveryAttempt();
      warnDelivery();
      if (idleAttempts < 2) nudgeTimer = setTimeout(flushNudge, NUDGE_COALESCE_MS);
      return;
    }
    // sendMessage is void, not a persistence receipt. Recover preparation errors
    // that return to idle without emitting settlement, with at most one retry.
    if (deliveryAttempt?.id === id) {
      confirmTimer = setTimeout(() => {
        confirmTimer = undefined;
        if (shuttingDown || !currentCtx) return;
        reconcileDelivery(currentCtx);
        if (deliveryAttempt?.id !== id || !currentCtx.isIdle()) return;
        clearDeliveryAttempt();
        warnDelivery();
        if (!nudgeSuspended && idleAttempts < 2) nudgeTimer = setTimeout(flushNudge, NUDGE_COALESCE_MS);
      }, 1000);
      confirmTimer.unref?.();
    }
  }
  const scheduleNudge = (): void => {
    if (shuttingDown || nudgeSuspended || deliveryAttempt || pendingNudge.size === 0 || idleAttempts >= 2) return;
    nudgeTimer ??= setTimeout(flushNudge, NUDGE_COALESCE_MS);
    nudgeTimer.unref?.();
  };
  const enqueueNudge = (summary: JobSummary): void => {
    if (!nudgeEnabled || shuttingDown || surfacedTerminalIds.has(summary.id)) return;
    pendingNudge.add(summary);
    scheduleNudge();
  };
  const unsubscribeSnapshots = pi.events.on('cache-reminders:captured', (data) => {
    const snapshot = data as { specs?: { id: string; body: string }[] };
    for (const spec of snapshot.specs ?? []) if (spec.id === 'bg-jobs') acknowledgeTerminals(spec.body);
  });
  pi.on('message_end', (event) => {
    const message = event.message;
    if (
      (message.role === 'toolResult' && message.toolName === 'bg_bash') ||
      (message.role === 'custom' && message.customType === BG_BASH_NUDGE_CUSTOM_TYPE)
    ) {
      acknowledgeTerminals(extractContentText(message.content), message.details);
    }
  });
  pi.on('input', (event, ctx) => {
    if (event.source === 'extension') return;
    currentCtx = ctx;
    nudgeSuspended = false;
    idleAttempts = 0;
    cancelNudgeTimer();
  });
  pi.on('agent_start', (_event, ctx) => reconcileDelivery(ctx));
  pi.on('agent_before_settle', (event, ctx) => {
    reconcileDelivery(ctx);
    if (event.outcome !== 'completed') {
      nudgeSuspended = true;
      cancelNudgeTimer();
      return;
    }
    if (shuttingDown || nudgeSuspended || deliveryAttempt || !nudgeEnabled) return;
    const jobs = readyNudges();
    if (jobs.length === 0) return;
    cancelNudgeTimer();
    const message = makeNudge(jobs);
    deliveryAttempt = { id: message.details.deliveryId, jobs };
    return { entries: [...event.entries, { type: 'custom_message' as const, ...message }], continue: true };
  });
  pi.on('agent_settled', (event, ctx) => {
    currentCtx = ctx;
    reconcileDelivery(ctx);
    clearDeliveryAttempt();
    if (event.aborted) nudgeSuspended = true;
    if (nudgeSuspended) cancelNudgeTimer();
    else scheduleNudge();
  });

  const liveCount = (): number => state.jobs.filter(isJobRunning).length;

  const updateStatusline = (): void => {
    if (!uiRef) return;
    const running = liveCount();
    if (running === lastStatusRunning) return;
    lastStatusRunning = running;
    if (running > 0) uiRef.setStatus('bg-bash', `⊙ bg:${running}`);
    else uiRef.setStatus('bg-bash', undefined);
  };

  // ── Gate serialization ─────────────────────────────────────────────
  //
  // pi's parallel-tools mode runs sibling `execute()` calls concurrently
  // after a sequential preflight. If several `bg_bash start` calls race,
  // each one independently awaits `ctx.ui.select` inside the shared
  // bash-permissions gate. pi queues concurrent dialogs, but during
  // testing we observed the whole assistant turn wedging when three
  // approvals stacked up (dialogs opened but later calls never resolved).
  //
  // Serialize gate calls inside this extension with a promise-chain mutex
  // so only one approval prompt is live at a time. Other UI calls (notify,
  // setStatus) are unaffected; this only gates the approval pathway.
  let gateQueue: Promise<void> = Promise.resolve();

  const gateSerialized = async (
    command: string,
    ctx: ExtensionContext,
  ): Promise<Awaited<ReturnType<typeof requestBashApproval>>> => {
    const prev = gateQueue;
    let release!: () => void;
    gateQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prev;
    } catch {
      /* previous queueant threw/rejected - we still run our prompt */
    }
    try {
      return await requestBashApproval(command, {
        cwd: ctx.cwd,
        hasUI: ctx.hasUI,
        ui: {
          select: ctx.ui.select.bind(ctx.ui),
          input: ctx.ui.input.bind(ctx.ui),
          notify: ctx.ui.notify.bind(ctx.ui),
        },
      });
    } finally {
      release();
    }
  };

  const ensureLogDir = (): string => {
    if (logDir) return logDir;
    const envBase = process.env.PI_BG_BASH_LOG_DIR;
    const base = envBase?.length ? envBase : join(tmpdir(), 'pi-bg-bash');
    const suffix = `${process.pid}-${Date.now().toString(36)}`;
    logDir = join(base, suffix);
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      // Fall back to <piAgentDir>/bg-bash if tmpdir is unwritable.
      logDir = piAgentPath('bg-bash', suffix);
      mkdirSync(logDir, { recursive: true });
    }
    return logDir;
  };

  const persist = (): void => {
    try {
      pi.appendEntry(BG_BASH_CUSTOM_TYPE, cloneState(state));
    } catch {
      // Never let bookkeeping break the tool call.
    }
  };

  const rebuildFromSession = (ctx: ExtensionContext): void => {
    generation++;
    cancelNudgeTimer();
    clearDeliveryAttempt();
    pendingNudge.clear();
    nudgeSuspended = false;
    shuttingDown = false;
    idleAttempts = 0;
    // Re-resolve config now that the real session cwd is known, so a
    // project-local <cwd>/.pi/bg-bash.json takes effect (the
    // registration-time load used process.cwd()).
    config = loadBgBashConfig(ctx.cwd);
    const branch = ctx.sessionManager.getBranch() as unknown as readonly BranchEntry[];
    surfacedTerminalIds = readSurfacedTerminalIds(branch);
    const replayed = reduceBranch(branch);
    // Drop ghosts still running/awaiting a signal exit in replayed snapshots.
    // Finalized exit/error/signal outcomes remain inspectable as history;
    // local ChildProcess handles are never reconstructed from persisted state.
    const pruned = pruneUnattachableJobs(replayed);
    state = pruned;
    // If we dropped anything, persist immediately so the next snapshot
    // on the branch reflects the clean slate.
    if (pruned.jobs.length !== replayed.jobs.length) persist();
    // `live` is not populated - the child processes are gone.
    uiRef = ctx.ui;
    currentCtx = ctx;
    lastStatusRunning = -1;
    updateStatusline();
  };

  /**
   * Spawn a shell child in its own process group and register the
   * resulting LiveJob + initial summary. Returns the summary.
   */
  const startJob = (args: {
    command: string;
    /**
     * Command actually handed to the shell's `-c`. When the sandbox extension
     * is active this is the `srt`-wrapped form returned by
     * `requestSandboxWrap`; the JobSummary still records `command` as the
     * original user-typed string so `list`/`status`/the overlay show what
     * the model asked for, not the wrap shape.
     */
    spawnCommand?: string;
    /** `sh` (`/bin/sh -c`) or `bash` (`bash -c`). */
    shell: BgBashShell;
    cwd: string;
    label?: string;
    env?: Record<string, string>;
    interactiveStdin?: boolean;
    nudge?: boolean;
    /** Called exactly once when the job is done (exit, spawn error, or
     *  failed spawn). Used to release the sandbox wrap. */
    onFinished?: () => void;
  }): JobSummary => {
    const id = allocateJobId(state);
    const startedAt = Date.now();
    const jobGeneration = generation;
    const dir = ensureLogDir();
    const logFile = join(dir, `${id}.log`);
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      try {
        args.onFinished?.();
      } catch {
        /* never let a release hook break job bookkeeping */
      }
    };

    const stdout = new RingBuffer({ maxBytes: config.maxBufferBytes });
    const stderr = new RingBuffer({ maxBytes: config.maxBufferBytes });

    let logStream: WriteStream | undefined;
    try {
      logStream = createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
      logStream.on('error', () => {
        /* drop logging on error rather than crashing the extension */
      });
    } catch {
      logStream = undefined;
    }

    let child: ChildProcess | undefined;
    let spawnError: string | undefined;

    // stdin handling:
    //   interactiveStdin=false (default) → 'ignore' ≈ redirect from /dev/null.
    //     The child sees an immediate EOF on stdin, so commands that happen to
    //     read stdin (pi's own CLI, cat, ssh without -n, nested agents) don't
    //     hang waiting for input that will never come.
    //   interactiveStdin=true → 'pipe'.
    //     Parent holds stdin open so the `stdin` action can drive a REPL /
    //     long-lived interactive process. This is the old default; only the
    //     handful of jobs that genuinely need to be fed input should opt in.
    const stdinMode: 'ignore' | 'pipe' = args.interactiveStdin ? 'pipe' : 'ignore';

    try {
      const { file, args: argv } = shellSpawnArgs(args.shell, args.spawnCommand ?? args.command);
      child = spawn(file, argv, {
        cwd: args.cwd,
        env: args.env ? { ...process.env, ...args.env } : process.env,
        stdio: [stdinMode, 'pipe', 'pipe'],
        detached: true, // own process group, so we can signal the whole tree
      });
    } catch (e) {
      spawnError = e instanceof Error ? e.message : String(e);
    }

    // Build the exited promise up front so `wait` callers can await it
    // even before the job I/O is wired up. It resolves when the job is
    // finalized (stdio closed, or the post-exit drain deadline passed).
    let setExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      setExited = resolve;
    });

    const summary: JobSummary = {
      id,
      label: args.label,
      command: args.command,
      cwd: args.cwd,
      pid: child?.pid,
      status: spawnError ? 'error' : 'running',
      error: spawnError,
      startedAt,
      endedAt: spawnError ? startedAt : undefined,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTail: '',
      stderrTail: '',
      logFile,
      nudge: args.nudge === true ? true : undefined,
    };

    state = upsertJob(state, summary);

    if (!child || spawnError) {
      finish();
      // Wait for the log stream to flush before resolving `exited`. The
      // stream has nothing queued (we never wrote to it), but `.end()` is
      // async and resolving `exited` before 'finish' fires leaves the
      // stream orphaned (not in `live` so not reaped on shutdown). Bound
      // the wait so a stuck stream can't hang spawn-failure reporting.
      if (logStream) {
        const finished = new Promise<void>((resolve) => {
          logStream.once('finish', resolve);
          logStream.once('error', resolve);
        });
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 500));
        logStream.end();
        void Promise.race([finished, timeout]).then(() => setExited());
      } else {
        setExited();
      }
      return summary;
    }

    const job: LiveJob = { summary, child, stdout, stderr, logStream, exited, setExited };
    live.set(id, job);

    // Detached children default to being reaped by the parent; we
    // explicitly do NOT `unref()` because we want to keep observing
    // them until they exit (otherwise pi could exit before them).

    // Wall-clock end is the shell's exit, not the (possibly later) moment
    // the stdio pipes finish draining.
    let exitedAt: number | undefined;
    child.on('exit', () => {
      exitedAt = Date.now();
    });

    const refreshBytes = (cur: LiveJob): JobSummary => ({
      ...cur.summary,
      stdoutBytes: stdout.byteLengthTotal,
      stderrBytes: stderr.byteLengthTotal,
      stdoutTail: stdout.tailPreview(TAIL_PREVIEW_BYTES),
      stderrTail: stderr.tailPreview(TAIL_PREVIEW_BYTES),
    });

    // Decoding, ring + log writes, and the exit/close/drain ordering live in
    // `attachJobIo`: the job finalizes on 'close' (or `drainMs` after 'exit'
    // when a background grandchild holds the pipe), never on bare 'exit',
    // so `wait` / nudges / the summary byte count see every byte. The
    // summary byte counts are always read from the same ring counters
    // `logs` reports.
    attachJobIo(child, {
      stdout,
      stderr,
      log: (text) => {
        if (!logStream?.writableEnded) logStream?.write(text);
      },
      drainMs: config.drainMs,
      onData: () => {
        const cur = live.get(id);
        if (cur !== job) return;
        cur.summary = refreshBytes(cur);
        if (jobGeneration === generation) state = upsertJob(state, cur.summary);
      },
      onFinal: (final) => {
        finish();
        const cur = live.get(id);
        if (cur === job) {
          if (final.kind === 'error') {
            cur.summary = { ...refreshBytes(cur), status: 'error', error: final.error, endedAt: Date.now() };
          } else {
            const status: JobStatus = final.signal ? 'signaled' : 'exited';
            cur.summary = {
              ...refreshBytes(cur),
              status,
              exitCode: final.exitCode,
              signal: final.signal,
              endedAt: exitedAt ?? Date.now(),
              outputOpen: final.outputOpen ? true : undefined,
            };
          }
          if (jobGeneration === generation) state = upsertJob(state, cur.summary);
        }
        setExited();
        if (cur !== job || jobGeneration !== generation || shuttingDown) return;
        persist();
        updateStatusline();
        startCards.refresh();
        if (cur) enqueueNudge(cur.summary);
      },
      onClose: () => {
        try {
          logStream?.end();
        } catch {
          /* ignore */
        }
        if (draining.get(id) === job) draining.delete(id);
        const cur = live.get(id);
        if (cur !== job) return;
        cur.child = undefined;
        if (jobGeneration !== generation) {
          live.delete(id);
          return;
        }
        if (cur.summary.outputOpen) {
          // The drain deadline finalized the job earlier; record the final
          // byte counts now that the background writer let go of the pipe.
          cur.summary = { ...refreshBytes(cur), outputOpen: undefined };
          state = upsertJob(state, cur.summary);
          persist();
        }
        startCards.refresh();
      },
    });

    return summary;
  };

  // ── Action implementations. Closures over `state`, `live`, `pi`,
  //    `startJob`. Defined before `registerTool` so oxlint's
  //    `no-use-before-define` is satisfied.
  // ──────────────────────────────────────────────────────────────────

  const actStart = async (
    params: {
      command?: string;
      cwd?: string;
      label?: string;
      env?: Record<string, string>;
      interactiveStdin?: boolean;
      nudge?: boolean;
      shell?: BgBashShell;
    },
    ctx: ExtensionContext,
  ): Promise<ToolReturn> => {
    const command = (params.command ?? '').trim();
    if (!command) return errorReturn('start', 'start requires `command`');

    // Route through bash-permissions (or whatever gate is installed).
    // Serialized so concurrent `bg_bash start` calls don't stack up
    // independent approval dialogs.
    const gate = await gateSerialized(command, ctx);
    if (!gate.allowed) return errorReturn('start', `Blocked by bash-permissions: ${gate.reason}`);

    // Phase 0's kill-tree spike confirmed `process.kill(-pid, sig)` reaps
    // a sandbox-exec / bwrap intermediate cleanly, so the existing
    // process-group SIGTERM in `sendSignalTo` already covers wrapped
    // children - no extra AbortSignal plumbing through wrapWithSandbox.
    const wrap = await requestSandboxWrap(command, { cwd: ctx.cwd, hasUI: ctx.hasUI });
    if (wrap.action === 'block') {
      // PI_SANDBOX_DEFAULT=block: sandbox init/wrap failed. Refuse to
      // launch the background job rather than silently downgrade to an
      // unwrapped spawn (which would defeat the user's chosen policy).
      return errorReturn('start', wrap.reason ?? 'Blocked by sandbox');
    }

    const cwd = resolveCwd(ctx.cwd, params.cwd, homedir());
    const shell = params.shell ?? config.shell;
    const summary = startJob({
      command,
      spawnCommand: wrap.wrapped ? wrap.command : undefined,
      shell,
      cwd,
      label: params.label,
      env: params.env,
      interactiveStdin: params.interactiveStdin === true,
      nudge: (params.nudge ?? config.nudge) === true,
      // Balance the sandbox wrap (ASRT per-command cleanup + stub
      // refcount) once the wrapped job is gone.
      onFinished: wrap.wrapped ? () => releaseSandboxWrap(wrap) : undefined,
    });
    persist();
    updateStatusline();

    const details: BgBashDetails = {
      ...cloneState(state),
      action: 'start',
      job: cloneSummary(summary),
    };
    // A sandbox-wrapped command already runs under bash inside the wrapper
    // (ASRT's default binShell), so only warn for a bare /bin/sh spawn.
    const warning = wrap.wrapped ? undefined : bashOnlySyntaxWarning(command, shell);
    const text = formatStartResult(summary, summary.status === 'error' ? undefined : warning);
    return { content: [{ type: 'text', text }], details, isError: summary.status === 'error' };
  };

  const actList = (action: BgBashAction): ToolReturn => {
    const details: BgBashDetails = { ...cloneState(state), action };
    return {
      content: [{ type: 'text', text: formatState(state, Date.now()) }],
      details,
    };
  };

  const actStatus = (params: { id?: string }): ToolReturn => {
    const id = params.id;
    if (!id) return errorReturn('status', 'status requires `id`');
    const summary = findJob(state, id);
    if (!summary) return errorReturn('status', `job [${id}] not found`);
    const details: BgBashDetails = { ...cloneState(state), action: 'status', job: cloneSummary(summary) };
    return { content: [{ type: 'text', text: formatJobLine(summary, Date.now()) }], details };
  };

  const actLogs = (params: {
    id?: string;
    stream?: StreamName;
    tail?: number;
    sinceCursor?: number;
    grep?: string;
    maxBytes?: number;
  }): ToolReturn => {
    const id = params.id;
    if (!id) return errorReturn('logs', 'logs requires `id`');
    const summary = findJob(state, id);
    if (!summary) return errorReturn('logs', `job [${id}] not found`);
    const job = live.get(id);
    if (!job) {
      // No live buffer (session-replayed job or already-reaped). The log
      // file on disk is the only remaining source.
      const details: BgBashDetails = {
        ...cloneState(state),
        action: 'logs',
        job: cloneSummary(summary),
      };
      const note = summary.logFile
        ? `(no in-memory buffer; read the log file directly: ${summary.logFile})`
        : '(no logs available - job predates this runtime)';
      const text = isJobRunning(summary) ? note : `${formatJobLine(summary, Date.now())}\n${note}`;
      return { content: [{ type: 'text', text }], details };
    }

    // Per-call param wins over the config default (`params.X ?? config.X`).
    const stream = params.stream ?? config.stream;
    const maxBytes = params.maxBytes ?? config.maxBytes;
    const tail = params.tail ?? config.tail;

    let content: string;
    let cursor: number;
    let droppedBefore = false;
    let totalBytes: number;
    let droppedBytes: number;

    if (tail !== undefined && tail >= 0) {
      const merged = mergeBgBashStreams(job, stream);
      const lines = tailLines(merged, tail);
      content = clampBytes(lines, maxBytes);
      cursor = bgBashStreamCursor(job, stream);
      totalBytes = bgBashStreamTotal(job, stream);
      droppedBytes = bgBashStreamDropped(job, stream);
    } else {
      const r = readBgBashStream(job, stream, { sinceCursor: params.sinceCursor, maxBytes });
      content = r.content;
      cursor = r.cursor;
      droppedBefore = r.droppedBefore;
      totalBytes = r.totalBytes;
      droppedBytes = r.droppedBytes;
    }

    if (params.grep) {
      try {
        const re = new RegExp(params.grep);
        const matches = content.split('\n').filter((line) => re.test(line));
        content = clampBytes(matches.join('\n'), maxBytes);
      } catch (e) {
        return errorReturn('logs', `invalid grep regex: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const details: BgBashDetails = {
      ...cloneState(state),
      action: 'logs',
      job: cloneSummary(summary),
      cursor,
      totalBytes,
      droppedBytes,
      droppedBefore,
      logExcerpt: content,
    };
    return {
      content: [
        {
          type: 'text',
          text: formatLogsText({
            id,
            stream,
            totalBytes,
            droppedBytes,
            droppedBefore,
            content,
            logFile: summary.logFile,
            jobStatus: summary.status,
            job: summary,
          }),
        },
      ],
      details,
    };
  };

  const actWait = async (
    params: { id?: string; timeoutMs?: number },
    abort: AbortSignal | undefined,
  ): Promise<ToolReturn> => {
    const id = params.id;
    if (!id) return errorReturn('wait', 'wait requires `id`');
    const summary = findJob(state, id);
    if (!summary) return errorReturn('wait', `job [${id}] not found`);
    const job = live.get(id);
    if (!job || !isJobRunning(summary)) {
      // Already terminal.
      const details: BgBashDetails = { ...cloneState(state), action: 'wait', job: cloneSummary(summary) };
      return { content: [{ type: 'text', text: formatJobLine(summary, Date.now()) }], details };
    }

    const timeoutMs = Math.max(0, params.timeoutMs ?? config.timeoutMs);
    let timedOut = false;
    // Hold its completion nudge until the terminal result is actually delivered,
    // rather than forgetting it merely because a wait exists. Sibling `logs` /
    // `status` calls in the same parallel batch wait for this one. The
    // finalize handler runs `enqueueNudge` synchronously before this `await`
    // resumes, and siblings check the barrier at execute entry, so the
    // registration must happen synchronously, before we race on `job.exited`.
    const releaseWait = waits.enter(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        job.exited,
        new Promise<void>((resolve) => {
          onAbort = () => {
            timedOut = true;
            resolve();
          };
          timer = setTimeout(onAbort, timeoutMs);
          if (abort?.aborted) onAbort();
          else abort?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) abort?.removeEventListener('abort', onAbort);
      releaseWait();
      scheduleNudge();
    }

    const fresh = findJob(state, id) ?? summary;
    const details: BgBashDetails = {
      ...cloneState(state),
      action: 'wait',
      job: cloneSummary(fresh),
      timedOut,
      logExcerpt: timedOut ? undefined : tailN(mergeBgBashStreams(job, 'merged'), 20),
    };
    const text = formatWaitResult(fresh, { timedOut, timeoutMs }, Date.now());
    return { content: [{ type: 'text', text }], details };
  };

  const actSignal = (params: { id?: string; signal?: SignalName }): ToolReturn => {
    const id = params.id;
    if (!id) return errorReturn('signal', 'signal requires `id`');
    const summary = findJob(state, id);
    if (!summary) return errorReturn('signal', `job [${id}] not found`);
    const job = live.get(id);
    if (!job || summary.status !== 'running') {
      return errorReturn('signal', `job [${id}] is not running (status: ${summary.status})`);
    }
    const sig = params.signal ?? 'SIGTERM';
    const ok = sendSignalTo(job, sig);
    if (!ok) return errorReturn('signal', `failed to send ${sig} to [${id}]`);

    // Mark as signaled immediately; the 'exit' handler will finalize
    // to the real `signaled` / `exited` + signal name. Overwriting the
    // status now lets the LLM see the transition without having to
    // wait for reap.
    const next = cloneSummary(summary);
    next.status = 'signaled';
    next.signal = sig;
    state = upsertJob(state, next);
    job.summary = next;
    persist();
    updateStatusline();

    const details: BgBashDetails = { ...cloneState(state), action: 'signal', job: cloneSummary(next) };
    return { content: [{ type: 'text', text: `Sent ${sig} to [${id}]` }], details };
  };

  const actStdin = async (params: { id?: string; text?: string; eof?: boolean }): Promise<ToolReturn> => {
    const id = params.id;
    if (!id) return errorReturn('stdin', 'stdin requires `id`');
    const summary = findJob(state, id);
    if (!summary) return errorReturn('stdin', `job [${id}] not found`);
    const job = live.get(id);
    if (summary.status !== 'running') {
      return errorReturn('stdin', `job [${id}] is not running (status: ${summary.status})`);
    }
    if (!job?.child?.stdin) {
      return errorReturn(
        'stdin',
        `job [${id}] has no writable stdin. It was started with interactiveStdin=false ` +
          '(the default). Restart it with `start` + interactiveStdin=true if you need to feed it input.',
      );
    }

    if (params.text) {
      await new Promise<void>((resolve, reject) => {
        job.child!.stdin!.write(params.text!, (err) => (err ? reject(err) : resolve()));
      });
    }
    if (params.eof) {
      try {
        job.child.stdin.end();
      } catch {
        /* ignore */
      }
    }

    const details: BgBashDetails = { ...cloneState(state), action: 'stdin', job: cloneSummary(summary) };
    const bytes = params.text ? Buffer.byteLength(params.text, 'utf8') : 0;
    return {
      content: [{ type: 'text', text: `Wrote ${bytes} byte(s) to stdin of [${id}]${params.eof ? ' + EOF' : ''}` }],
      details,
    };
  };

  const releaseJob = (id: string): void => {
    pendingNudge.forget([id]);
    surfacedTerminalIds.delete(id);
    if (pendingNudge.size === 0) cancelNudgeTimer();
    const job = live.get(id);
    if (!job) return;
    live.delete(id);
    if (job.summary.outputOpen || job.child) draining.set(id, job);
    else if (!job.logStream?.writableEnded) job.logStream?.end();
  };

  const actRemove = (params: { id?: string }): ToolReturn => {
    const id = params.id;
    if (!id) return errorReturn('remove', 'remove requires `id`');
    const result = removeJob(state, id);
    if (!result.ok) return errorReturn('remove', result.error);
    startCards.refresh();
    state = result.state;
    releaseJob(id);
    startCards.refresh();
    persist();
    updateStatusline();
    const details: BgBashDetails = { ...cloneState(state), action: 'remove' };
    return { content: [{ type: 'text', text: result.summary }], details };
  };

  // ── Lifecycle handlers ─────────────────────────────────────────────

  pi.on('session_start', (_event, ctx) => {
    startCards.reset(ctx.mode === 'tui');
    rebuildFromSession(ctx);
  });

  pi.on('session_tree', (_event, ctx) => {
    startCards.reset(ctx.mode === 'tui');
    // After /tree or /fork, state may have moved to a different point
    // in history - rehydrate.
    rebuildFromSession(ctx);
  });

  pi.on('session_shutdown', async () => {
    startCards.reset(false);
    unsubscribeSnapshots();
    surfacedTerminalIds.clear();
    // Invalidate callbacks before aborting children or releasing UI resources.
    shuttingDown = true;
    generation++;
    cancelNudgeTimer();
    clearDeliveryAttempt();
    pendingNudge.clear();
    currentCtx = undefined;
    try {
      uiRef?.setStatus('bg-bash', undefined);
    } catch {
      // Shutdown may already have detached the UI.
    }
    uiRef = undefined;
    lastStatusRunning = -1;
    // Best-effort reap of every live job. We can't await forever - pi
    // is already on its way out. SIGTERM everything, wait up to
    // `killGraceMs`, then SIGKILL the stragglers.
    const owned = new Map([...live, ...draining]);
    const livingIds = [...owned.keys()];
    if (livingIds.length === 0) return;

    const now = Date.now();
    for (const id of livingIds) {
      const job = owned.get(id);
      if (!job?.child || job.child.exitCode !== null) continue;
      sendSignalTo(job, 'SIGTERM');
    }
    let grace: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(livingIds.map((id) => owned.get(id)?.exited ?? Promise.resolve())),
        new Promise((resolve) => {
          grace = setTimeout(resolve, config.killGraceMs);
        }),
      ]);
    } finally {
      clearTimeout(grace);
    }
    for (const id of livingIds) {
      const job = owned.get(id);
      if (!job?.child || job.child.exitCode !== null) continue;
      sendSignalTo(job, 'SIGKILL');
    }
    state = markLiveJobsTerminated(state, now);
    // A job finalized by the drain deadline can still have its log open
    // (a background grandchild holds the pipe); close what is left.
    for (const job of owned.values()) {
      try {
        job.child?.stdin?.destroy();
        job.child?.stdout?.destroy();
        job.child?.stderr?.destroy();
        if (job.logStream && !job.logStream.writableEnded) job.logStream.end();
      } catch {
        /* ignore */
      }
    }
    live.clear();
    draining.clear();
    persist();
  });

  // Refresh the captured UI reference + statusline at every turn start.
  // Some pi actions (/fork, /resume) rebind `ctx.ui` under the hood;
  // re-grabbing it on turn start keeps the statusline pointing at the
  // current surface. This runs regardless of auto-injection.
  pi.on('before_agent_start', (_event, ctx) => {
    uiRef = ctx.ui;
    currentCtx = ctx;
    updateStatusline();
    return undefined;
  });

  if (autoInjectEnabled) {
    // Inject the running-jobs registry as an ephemeral <system-reminder>
    // spliced into the last user/toolResult turn via the `context` hook
    // (not the system prompt). Pi's `context` output builds only the
    // outgoing payload and is never persisted, so the system prompt stays
    // byte-stable - the provider's prompt-prefix cache survives job
    // start/exit churn - and nothing accumulates. When there are no jobs
    // to report, formatBackgroundJobs returns null and we inject nothing.
    pi.on('context', (event) => {
      const block = formatBackgroundJobs(state, {
        maxChars: config.maxInjectedChars,
        now: Date.now(),
        surfacedTerminalIds,
      });
      if (!block) return undefined;
      const messages = applyContextReminder(event.messages as unknown as ReminderMessage[], {
        id: 'bg-jobs',
        body: block,
      });
      return { messages: messages as unknown as typeof event.messages };
    });
  }

  // ── Nudge message renderer ─────────────────────────────────────────
  //
  // The nudge's `content` is the LLM-facing notice (a synthetic user
  // turn). Render a compact card for the user instead of echoing that
  // text back; expand shows a line per finished job. Registered
  // unconditionally so replayed sessions still render past nudges.
  pi.registerMessageRenderer<BgBashNudgeDetails>(BG_BASH_NUDGE_CUSTOM_TYPE, (message, { expanded }, theme) => {
    const jobs = message.details?.jobs ?? [];
    const now = Date.now();
    const prefix = theme.fg('accent', '⊙ bg');
    if (jobs.length === 0) {
      return new Text(`${prefix} ${theme.fg('muted', 'job finished')}`, 0, 0);
    }
    if (jobs.length === 1 && !expanded) {
      return new Text(`${prefix} ${theme.fg('muted', formatJobLine(jobs[0], now))}`, 0, 0);
    }
    const head = `${prefix} ${theme.fg('muted', `${jobs.length} job(s) finished`)}`;
    const lines = jobs.map((j) => `  ${theme.fg('dim', formatJobLine(j, now))}`);
    return new Text([head, ...lines].join('\n'), 0, 0);
  });

  // ── Tool registration ──────────────────────────────────────────────

  pi.registerTool({
    name: 'bg_bash',
    label: 'Background Bash',
    description:
      'Run shell commands in the background and interact with them across subsequent turns. ' +
      'Actions: start (spawn a new job), list (all jobs), status (one job), logs (stdout/stderr, supports tail/grep/sinceCursor), ' +
      'wait (block up to timeoutMs for exit), signal (send SIGINT/SIGTERM/SIGKILL/... to the job process group), ' +
      'stdin (write to a running job - only works when the job was started with interactiveStdin=true), ' +
      'remove (drop a terminal job from the registry). ' +
      'Stdin defaults to /dev/null; pass interactiveStdin=true on start to feed input via action stdin. ' +
      'Pass nudge=true for unhandled completion notifications (wakes you when idle; busy runs receive one digest). ' +
      'Commands run under /bin/sh by default; pass shell="bash" for bash-only syntax (PIPESTATUS, [[ ]], arrays). ' +
      'A logs/status call in the same batch as a wait on that job runs after the wait returns; ' +
      'other tools in that batch (e.g. read of a file the job writes) run concurrently with the wait, so issue them in a later turn. ' +
      'Jobs live only for the current pi session; on shutdown every live job is terminated.',
    promptSnippet:
      'Run long-lived or latency-hiding commands (test suites, dev servers, watchers, builds) in the background and check on them later.',
    promptGuidelines: [
      'Use `bg_bash` action `start` instead of `bash` whenever a command might run long (>5s), never exits on its own (dev servers, watchers), or should continue while you do other work.',
      'After `bg_bash start`, remember the returned `id`. Call `bg_bash` action `wait` with a short `timeoutMs` to poll for exit, or action `logs` with `sinceCursor` to stream new output incrementally.',
      'Use `bg_bash` action `signal` (SIGTERM by default, SIGKILL if stuck) to stop a job cleanly; the whole process group is targeted so children die too.',
      'Prefer `bg_bash` action `logs` with `tail` or `grep` over returning the full buffer - the ring buffer caps memory but log responses still eat context.',
      'Pass `nudge: true` on `start` for fire-and-forget jobs (builds, deploys) to be auto-messaged on exit instead of polling; skip it when you will `wait` on the job anyway.',
    ],
    parameters: BgBashParams,

    async execute(toolCallId, rawParams, sig, _onUpdate, ctx) {
      const params = rawParams;

      switch (params.action) {
        case 'start': {
          const result = await actStart(params, ctx);
          const job = result.details.job && live.get(result.details.job.id);
          if (!result.isError && job) {
            startCards.bind(toolCallId, ctx, () => {
              if (live.get(job.summary.id) !== job) return undefined;
              const value = cloneSummary(job.summary);
              return {
                value,
                active:
                  value.status === 'running' ||
                  (value.status === 'signaled' && value.endedAt === undefined) ||
                  value.outputOpen === true,
              };
            });
          }
          return result;
        }
        case 'list':
          return actList(params.action);
        // A `wait` on the same job earlier in this parallel tool batch is
        // still in flight: report the post-wait state, matching the order
        // the calls were written in (see WaitBarrier).
        case 'status':
          if (params.id) await waits.settled(params.id);
          return actStatus(params);
        case 'logs':
          if (params.id) await waits.settled(params.id);
          return actLogs(params);
        case 'wait':
          return await actWait(params, sig);
        case 'signal':
          return actSignal(params);
        case 'stdin':
          return await actStdin(params);
        case 'remove':
          return actRemove(params);
      }
    },

    renderCall(args, theme, context) {
      if (args.action === 'start') startCards.capture(context);
      let text = theme.fg('toolTitle', theme.bold('bg_bash ')) + theme.fg('muted', args.action);
      if (args.id) text += ` ${theme.fg('accent', `[${args.id}]`)}`;
      if (args.action === 'start' && args.command) {
        text += ` ${theme.fg('dim', `"${truncate(String(args.command).replace(/\s+/g, ' '), 80)}"`)}`;
        if (args.nudge === true) text += ` ${theme.fg('accent', '⊙nudge')}`;
      }
      if (args.action === 'signal' && args.signal) {
        text += ` ${theme.fg('warning', String(args.signal))}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, context) {
      const details = (result.details ?? {}) as Partial<BgBashDetails>;
      const current = details.action === 'start' ? startCards.read(context) : undefined;
      if (current) {
        const parts = [renderJobHeader(current, theme)];
        if (current.outputOpen) parts.push(theme.fg('dim', '   output pipe still open'));
        if (expanded) {
          parts.push(theme.fg('dim', `   pid ${current.pid ?? '?'}  cwd ${current.cwd.replace(homedir(), '~')}`));
        }
        for (const [stream, tail] of [
          ['stdout', current.stdoutTail],
          ['stderr', current.stderrTail],
        ] as const) {
          if (tail) parts.push(theme.fg('toolOutput', `${stream}: ${tailN(tail, expanded ? 8 : 3).trimEnd()}`));
        }
        return new Text(parts.join('\n'), 0, 0);
      }
      if (details.error) return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);

      const jobs = details.jobs ?? [];
      const parts: string[] = [];

      // Action-specific lead line first.
      //
      // `logs` / `wait` / `status` share the stable `formatJobHeader`
      // shape (glyph derived from job status, not the action). `start`
      // and `signal` use action-specific leads.
      if (details.action === 'start' && details.job) {
        if (details.job.status === 'error') {
          parts.push(
            `${theme.fg('error', '✗')} ${theme.fg('toolTitle', theme.bold(`[${details.job.id}]`))} ` +
              `${theme.fg('muted', `spawn failed: ${details.job.error ?? 'unknown'}`)}`,
          );
        } else {
          parts.push(
            `${theme.fg('success', '▶')} ${theme.fg('toolTitle', theme.bold(`[${details.job.id}]`))}  ` +
              `${theme.fg('dim', `pid ${details.job.pid ?? '?'}`)}  ` +
              `${theme.fg('muted', truncate(details.job.command.replace(/\s+/g, ' '), 80))}`,
          );
          const cwdStr = details.job.cwd ? details.job.cwd.replace(homedir(), '~') : '';
          if (cwdStr) {
            parts.push(`   ${theme.fg('dim', `cwd ${cwdStr}`)}`);
          }
        }
      } else if (details.action === 'wait' && details.job) {
        parts.push(renderJobHeader(details.job, theme, { timedOut: details.timedOut === true }));
      } else if (details.action === 'signal' && details.job) {
        const sig = details.job.signal ?? 'signal';
        parts.push(
          `${theme.fg('warning', '⚡')} ${theme.fg('toolTitle', theme.bold(`[${details.job.id}]`))}  ` +
            `${theme.fg('accent', sig)} ${theme.fg('muted', 'sent  ·  awaiting exit')}`,
        );
      } else if (details.action === 'stdin' && details.job) {
        parts.push(
          `${theme.fg('muted', '↳ wrote to stdin of ')}${theme.fg('toolTitle', theme.bold(`[${details.job.id}]`))}`,
        );
      } else if (details.action === 'logs' && details.job) {
        let head = renderJobHeader(details.job, theme);
        if (details.droppedBefore) head += ` ${theme.fg('warning', '(cursor evicted)')}`;
        parts.push(head);
      } else if (details.action === 'status' && details.job) {
        parts.push(renderJobHeader(details.job, theme));
      } else if (details.action === 'remove' && details.job) {
        parts.push(`${theme.fg('muted', '✕ removed ')}${theme.fg('dim', `[${details.job.id}]`)}`);
      }

      // Log excerpt (for `logs`, and a short tail for `wait`).
      if (details.logExcerpt) {
        const excerpt = expanded ? details.logExcerpt : tailN(details.logExcerpt, 8);
        parts.push(theme.fg('toolOutput', excerpt.trimEnd()));
        if (!expanded && excerpt !== details.logExcerpt) {
          parts.push(theme.fg('dim', '  … (Ctrl+O to expand)'));
        }
      }

      // Registry tail. Only `list` renders this. Every other action's
      // card was getting dominated by the registry dump in scrollback
      // (see captures/08-bgbash-inline-scrollback.txt). The empty-state
      // `(no background jobs)` hint is preserved for `list` so an
      // intentionally empty registry still has a visible result.
      if (details.action === 'list') {
        const count = jobs.length;
        if (count === 0) {
          parts.push(theme.fg('dim', '(no background jobs)'));
        } else {
          parts.push(theme.fg('muted', `Registry: ${count} job(s)`));
          for (const j of jobs) parts.push(renderRegistryLine(j, theme));
        }
      }

      return new Text(parts.join('\n'), 0, 0);
    },
  });

  // ── /bg-bash command (user-facing inspection / control) ────────────

  /**
   * Drop every terminal (non-live) job from the registry, returning how
   * many were removed. Shared between the `/bg-bash clear` sub-verb and
   * the overlay's `c` keybinding so both surfaces stay consistent.
   */
  const clearTerminalJobs = (): number => {
    startCards.refresh();
    const terminal = state.jobs.filter((job) => !isJobRunning(job));
    state = { ...state, jobs: state.jobs.filter(isJobRunning) };
    for (const job of terminal) releaseJob(job.id);
    startCards.refresh();
    const removed = terminal.length;
    if (removed > 0) {
      persist();
      updateStatusline();
    }
    return removed;
  };

  pi.registerCommand('bg-bash', {
    description: 'Inspect the background-job registry (overlay, plus list / logs / kill / clear sub-verbs).',
    getArgumentCompletions: (prefix) => {
      const jobArgs = (): { label: string; description: string }[] =>
        state.jobs.map((j) => ({ label: j.id, description: `${j.status}: ${j.command}` }));
      return completeSubverbs(prefix, {
        list: { description: 'List the background-job registry' },
        logs: { description: 'Show a job log', args: jobArgs },
        kill: { description: 'Signal a running job', args: jobArgs },
        clear: { description: 'Remove finished jobs from the registry' },
      });
    },
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(BG_BASH_USAGE, 'info');
        return;
      }
      const [sub, ...rest] = (args ?? '').trim().split(/\s+/);

      if (!sub || sub === 'list') {
        if (!ctx.hasUI) {
          ctx.ui.notify(formatState(state, Date.now()), 'info');
          return;
        }
        let ticker: ReturnType<typeof setInterval> | undefined;
        let overlay: BgBashOverlay | undefined;
        await showModal<void>(ctx.ui, (tui, theme, _kb, done) => {
          overlay = new BgBashOverlay(
            {
              getState: () => state,
              getLive: (id) => live.get(id),
              onSignal: (id, sig) => {
                // Route through actSignal so the bash-permissions /
                // state-update path matches the `bg_bash` tool.
                actSignal({ id, signal: sig });
              },
              onRemove: (id) => {
                actRemove({ id });
              },
              onClearTerminal: () => {
                clearTerminalJobs();
              },
            },
            theme,
            tui,
            () => {
              if (ticker) clearInterval(ticker);
              ticker = undefined;
              done();
            },
          );
          ticker = setInterval(() => {
            tui.requestRender();
          }, OVERLAY_TICK_MS);
          return overlay;
        });
        if (ticker) clearInterval(ticker);
        return;
      }
      if (sub === 'logs') {
        const id = rest[0];
        if (!id) {
          ctx.ui.notify('Usage: /bg-bash logs <id>', 'warning');
          return;
        }
        const job = live.get(id);
        if (!job) {
          ctx.ui.notify(`No live job [${id}]. Log file may still exist under ${logDir ?? '(unset)'}.`, 'warning');
          return;
        }
        ctx.ui.notify(`${job.stdout.read().content}\n---stderr---\n${job.stderr.read().content}`, 'info');
        return;
      }
      if (sub === 'kill') {
        const id = rest[0];
        if (!id) {
          ctx.ui.notify('Usage: /bg-bash kill <id> [signal]', 'warning');
          return;
        }
        const job = live.get(id);
        if (!job) {
          ctx.ui.notify(`No live job [${id}]`, 'warning');
          return;
        }
        const signalName = (rest[1] as SignalName | undefined) ?? 'SIGTERM';
        if (sendSignalTo(job, signalName)) ctx.ui.notify(`Sent ${signalName} to [${id}]`, 'info');
        else ctx.ui.notify(`Failed to signal [${id}]`, 'error');
        return;
      }
      if (sub === 'clear') {
        const removed = clearTerminalJobs();
        ctx.ui.notify(`Cleared ${removed} terminal job(s).`, 'info');
        return;
      }
      ctx.ui.notify(`Unknown subcommand: ${sub}. Usage: /bg-bash [list|logs <id>|kill <id> [sig]|clear]`, 'warning');
    },
  });
}
