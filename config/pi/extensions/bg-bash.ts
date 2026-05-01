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
 *     (metadata only — not the live ChildProcess / buffers) to the
 *     session branch as both a `toolResult.details` payload and a
 *     `customType: 'bg-bash-state'` custom entry. This survives
 *     `/compact` and travels with `/fork`, `/tree`.
 *
 *   - Every turn the current "## Background Jobs" block is injected
 *     into the system prompt via `before_agent_start` so even weak
 *     models remember what's running.
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
 *                                     before_agent_start block
 *   PI_BG_BASH_MAX_INJECTED_CHARS=N   soft cap on the injected block
 *                                     (default 1500)
 *   PI_BG_BASH_MAX_BUFFER_BYTES=N     per-stream ring buffer cap
 *                                     (default 1 MiB)
 *   PI_BG_BASH_KILL_GRACE_MS=N        SIGTERM→SIGKILL grace window on
 *                                     session_shutdown (default 3000)
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringEnum } from '@mariozechner/pi-ai';
import { type ExtensionAPI, type ExtensionContext, type Theme } from '@mariozechner/pi-coding-agent';
import { Text } from '@mariozechner/pi-tui';
import { Type } from 'typebox';
import { requestBashApproval } from '../../../lib/node/pi/bash-gate.ts';
import { formatBackgroundJobs } from '../../../lib/node/pi/bg-bash-prompt.ts';
import {
  allocateId as allocateJobId,
  BG_BASH_CUSTOM_TYPE,
  type BgBashState,
  type BranchEntry,
  cloneState,
  cloneSummary,
  emptyState,
  findJob,
  formatJobLine,
  formatState,
  type JobStatus,
  type JobSummary,
  markLiveJobsTerminated,
  pruneUnattachableJobs,
  reduceBranch,
  removeJob,
  statusIcon,
  upsertJob,
} from '../../../lib/node/pi/bg-bash-reducer.ts';
import { RingBuffer } from '../../../lib/node/pi/bg-bash-ring.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Tuning
// ──────────────────────────────────────────────────────────────────────

const DEFAULT_INJECTED_CHARS = 1500;
const DEFAULT_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 3000;
const DEFAULT_WAIT_MS = 15_000;
const MAX_LOG_RESPONSE_BYTES = 32 * 1024; // ~6k tokens — keep LLM responses small
const TAIL_PREVIEW_BYTES = 200;

// ──────────────────────────────────────────────────────────────────────
// Parameter schema
// ──────────────────────────────────────────────────────────────────────

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'] as const;
type SignalName = (typeof SIGNALS)[number];

const STREAMS = ['stdout', 'stderr', 'merged'] as const;
type StreamName = (typeof STREAMS)[number];

const BgBashParams = Type.Object({
  action: StringEnum(['start', 'list', 'status', 'logs', 'wait', 'signal', 'stdin', 'remove'] as const, {
    description: 'Which operation to perform.',
  }),
  command: Type.Optional(
    Type.String({
      description: 'Shell command to run in the background (required for `start`). Interpreted by /bin/sh -c.',
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: 'Working directory for `start`. Absolute, or relative to the agent cwd. Defaults to the agent cwd.',
    }),
  ),
  label: Type.Optional(
    Type.String({
      description: 'Short human label shown in `list` and the injected status block (for `start`).',
    }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'Extra environment variables for `start`. Merged on top of the agent process env; values replace existing keys.',
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
      description:
        '`logs` only. Opaque byte cursor returned from a prior `logs` call. Use to get only newer output since last check.',
    }),
  ),
  grep: Type.Optional(
    Type.String({
      description: '`logs` only. Return only lines matching this JS regex (no flags).',
    }),
  ),
  maxBytes: Type.Optional(
    Type.Integer({
      description: `\`logs\` only. Soft cap on response bytes. Default ${MAX_LOG_RESPONSE_BYTES}.`,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      description: `\`wait\` only. Milliseconds to wait for exit before returning with timedOut=true. Default ${DEFAULT_WAIT_MS}.`,
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
        '`start` only. When true, spawn the child with an open stdin pipe so you can drive it with action `stdin` ' +
        '(REPLs, `sqlite3`, `python -i`, interactive installers, nested `pi -p`, etc.). ' +
        'Default false: stdin is redirected from /dev/null so non-interactive commands that read from stdin ' +
        '(e.g. `pi -p`, `cat`, `grep` with no args, `ssh` without `-n`) get an immediate EOF instead of hanging ' +
        "forever waiting for input that will never come. Only set true if you're going to use action `stdin`.",
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
   * or once the job has been reaped. We keep the record around for metadata
   * after exit; only the child is released.
   */
  child?: ChildProcess;
  stdout: RingBuffer;
  stderr: RingBuffer;
  logStream?: WriteStream;
  /**
   * Resolves when the child exits. Multiple `wait` calls can await the same
   * promise. Always resolves (never rejects) so callers can race it with a
   * timeout without unhandled rejections.
   */
  exited: Promise<void>;
  setExited: () => void;
}

// ──────────────────────────────────────────────────────────────────────
// Module-scope pure helpers. Defined above the extension factory so
// eslint's `no-use-before-define` stays happy and so they're trivial
// to import into unit tests if we ever want to.
// ──────────────────────────────────────────────────────────────────────

function errorReturn(action: BgBashAction, message: string): ToolReturn {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    details: { jobs: [], nextId: 1, action, error: message },
    isError: true,
  };
}

function parseIntEnv(name: string, defaultValue: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : defaultValue;
}

function resolveCwd(agentCwd: string, supplied: string | undefined): string {
  if (!supplied) return agentCwd;
  if (supplied.startsWith('/')) return supplied;
  if (supplied === '~' || supplied.startsWith('~/')) {
    return join(homedir(), supplied.slice(1).replace(/^\//, ''));
  }
  return join(agentCwd, supplied);
}

function tailLines(s: string, n: number): string {
  if (n <= 0 || !s) return '';
  const lines = s.split('\n');
  const hasTrailingNewline = lines[lines.length - 1] === '';
  const effective = hasTrailingNewline ? lines.slice(0, -1) : lines;
  const start = Math.max(0, effective.length - n);
  return effective.slice(start).join('\n') + (hasTrailingNewline ? '\n' : '');
}

function tailN(s: string, n: number): string {
  return tailLines(s, n);
}

function clampBytes(s: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return s;
  const encoded = Buffer.byteLength(s, 'utf8');
  if (encoded <= maxBytes) return s;
  // Tail-preserving truncation: the tail of a log is usually what the
  // LLM needs (errors, summaries, final state). The head is marked
  // so the model knows to go to the on-disk log if it needs more.
  const buf = Buffer.from(s, 'utf8');
  const kept = buf.subarray(buf.length - maxBytes);
  return `… [${encoded - maxBytes}B truncated; see logFile] …\n${kept.toString('utf8')}`;
}

function mergeStreams(job: LiveJob, stream: StreamName): string {
  if (stream === 'stdout') return job.stdout.read().content;
  if (stream === 'stderr') return job.stderr.read().content;
  // "merged": we don't track interleaving timestamps in memory. The
  // on-disk log file IS interleaved in wall-clock order — callers
  // that need exact ordering should read the file. Here we return
  // stdout then stderr with a labeled separator.
  const out = job.stdout.read().content;
  const err = job.stderr.read().content;
  if (!out && !err) return '';
  if (!err) return out;
  if (!out) return err;
  return `${out}\n--- stderr ---\n${err}`;
}

function readStream(
  job: LiveJob,
  stream: StreamName,
  opts: { sinceCursor?: number; maxBytes?: number },
): { content: string; cursor: number; droppedBefore: boolean; totalBytes: number; droppedBytes: number } {
  if (stream === 'stdout') return job.stdout.read(opts);
  if (stream === 'stderr') return job.stderr.read(opts);
  // For merged streams we pick a synthetic cursor and totals by
  // summing both streams — good enough for the LLM; exact resumable
  // reads require picking one stream.
  const outR = job.stdout.read(opts);
  const errR = job.stderr.read(opts);
  const content = mergeStreams(job, 'merged');
  return {
    content: opts.maxBytes !== undefined ? clampBytes(content, opts.maxBytes) : content,
    cursor: outR.cursor + errR.cursor,
    droppedBefore: outR.droppedBefore || errR.droppedBefore,
    totalBytes: outR.totalBytes + errR.totalBytes,
    droppedBytes: outR.droppedBytes + errR.droppedBytes,
  };
}

function cursorFor(job: LiveJob, stream: StreamName): number {
  if (stream === 'stdout') return job.stdout.byteLengthTotal;
  if (stream === 'stderr') return job.stderr.byteLengthTotal;
  return job.stdout.byteLengthTotal + job.stderr.byteLengthTotal;
}

function totalFor(job: LiveJob, stream: StreamName): number {
  return cursorFor(job, stream);
}

function droppedFor(job: LiveJob, stream: StreamName): number {
  if (stream === 'stdout') return job.stdout.byteLengthDropped;
  if (stream === 'stderr') return job.stderr.byteLengthDropped;
  return job.stdout.byteLengthDropped + job.stderr.byteLengthDropped;
}

function finalLine(job: JobSummary, theme: Theme): string {
  return `${statusIcon(job.status)} ${theme.fg('toolTitle', theme.bold(`[${job.id}]`))} ${theme.fg(
    'muted',
    formatJobLine(job, Date.now()).replace(/^\[\w+\][^ ]* /, ''),
  )}`;
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
  if (!child || child.exitCode !== null || child.pid === undefined) return false;
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
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function bgBashExtension(pi: ExtensionAPI): void {
  if (process.env.PI_BG_BASH_DISABLED === '1') return;

  const autoInjectEnabled = process.env.PI_BG_BASH_DISABLE_AUTOINJECT !== '1';
  const maxInjectedChars = parseIntEnv('PI_BG_BASH_MAX_INJECTED_CHARS', DEFAULT_INJECTED_CHARS, 200);
  const maxBufferBytes = parseIntEnv('PI_BG_BASH_MAX_BUFFER_BYTES', DEFAULT_BUFFER_BYTES, 0);
  const killGraceMs = parseIntEnv('PI_BG_BASH_KILL_GRACE_MS', DEFAULT_KILL_GRACE_MS, 0);

  // Per-runtime stores. Both are rebuilt from the branch on session_start;
  // `live` is always empty there (we can't reattach) — only `state` is
  // hydrated so the LLM can still inspect the job metadata.
  let state: BgBashState = emptyState();
  const live = new Map<string, LiveJob>();

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
  // pointed at whatever the current UI surface is — some session replace
  // flows rebind `ctx.ui`.
  let uiRef: ExtensionContext['ui'] | undefined;
  let lastStatusRunning = -1; // sentinel: forces the first paint

  const liveCount = (): number => state.jobs.filter((j) => j.status === 'running' || j.status === 'signaled').length;

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
      /* previous queueant threw/rejected — we still run our prompt */
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
    const base = process.env.PI_BG_BASH_LOG_DIR || join(tmpdir(), 'pi-bg-bash');
    const suffix = `${process.pid}-${Date.now().toString(36)}`;
    logDir = join(base, suffix);
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      // Fall back to $HOME/.pi/bg-bash if tmpdir is unwritable.
      logDir = join(homedir(), '.pi', 'bg-bash', suffix);
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
    const branch = ctx.sessionManager.getBranch() as unknown as readonly BranchEntry[];
    const replayed = reduceBranch(branch);
    // Drop jobs we can't interact with: anything still `running` /
    // `signaled` in a replayed snapshot is a ghost (its child died with
    // the previous runtime), and `terminated` entries are informational
    // noise. `pruneUnattachableJobs` keeps only `exited` / `error` so
    // recent history stays visible but the LLM can't try to `wait` on a
    // corpse.
    const pruned = pruneUnattachableJobs(replayed);
    state = pruned;
    // If we dropped anything, persist immediately so the next snapshot
    // on the branch reflects the clean slate.
    if (pruned.jobs.length !== replayed.jobs.length) persist();
    // `live` is not populated — the child processes are gone.
    uiRef = ctx.ui;
    lastStatusRunning = -1;
    updateStatusline();
  };

  /**
   * Spawn a shell child in its own process group and register the
   * resulting LiveJob + initial summary. Returns the summary.
   */
  const startJob = (args: {
    command: string;
    cwd: string;
    label?: string;
    env?: Record<string, string>;
    interactiveStdin?: boolean;
  }): JobSummary => {
    const id = allocateJobId(state);
    const startedAt = Date.now();
    const dir = ensureLogDir();
    const logFile = join(dir, `${id}.log`);

    const stdout = new RingBuffer({ maxBytes: maxBufferBytes });
    const stderr = new RingBuffer({ maxBytes: maxBufferBytes });

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
      child = spawn('/bin/sh', ['-c', args.command], {
        cwd: args.cwd,
        env: args.env ? { ...process.env, ...args.env } : process.env,
        stdio: [stdinMode, 'pipe', 'pipe'],
        detached: true, // own process group, so we can signal the whole tree
      });
    } catch (e) {
      spawnError = e instanceof Error ? e.message : String(e);
    }

    // Build the exited promise up front so `wait` callers can await it
    // even before we've wired up the 'exit' listener.
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
    };

    state = upsertJob(state, summary);

    if (!child || spawnError) {
      try {
        logStream?.end();
      } catch {
        /* ignore */
      }
      setExited();
      return summary;
    }

    const job: LiveJob = { summary, child, stdout, stderr, logStream, exited, setExited };
    live.set(id, job);

    // Detached children default to being reaped by the parent; we
    // explicitly do NOT `unref()` because we want to keep observing
    // them until they exit (otherwise pi could exit before them).

    const decoderOut = new TextDecoder('utf-8', { fatal: false });
    const decoderErr = new TextDecoder('utf-8', { fatal: false });

    child.stdout?.on('data', (buf: Buffer) => {
      const s = decoderOut.decode(buf, { stream: true });
      if (!s) return;
      stdout.append(s);
      logStream?.write(s);
      const cur = live.get(id);
      if (!cur) return;
      cur.summary = {
        ...cur.summary,
        stdoutBytes: stdout.byteLengthTotal,
        stdoutTail: stdout.tailPreview(TAIL_PREVIEW_BYTES),
      };
      state = upsertJob(state, cur.summary);
    });

    child.stderr?.on('data', (buf: Buffer) => {
      const s = decoderErr.decode(buf, { stream: true });
      if (!s) return;
      stderr.append(s);
      logStream?.write(s);
      const cur = live.get(id);
      if (!cur) return;
      cur.summary = {
        ...cur.summary,
        stderrBytes: stderr.byteLengthTotal,
        stderrTail: stderr.tailPreview(TAIL_PREVIEW_BYTES),
      };
      state = upsertJob(state, cur.summary);
    });

    child.on('error', (err) => {
      const cur = live.get(id);
      if (!cur) return;
      cur.summary = { ...cur.summary, status: 'error', error: err.message, endedAt: Date.now() };
      state = upsertJob(state, cur.summary);
      try {
        logStream?.end();
      } catch {
        /* ignore */
      }
      setExited();
      persist();
      updateStatusline();
    });

    child.on('exit', (code, sig) => {
      const endedAt = Date.now();
      // Flush the final chunks out of the decoders in case they buffered
      // a mid-codepoint tail.
      const tailOut = decoderOut.decode();
      if (tailOut) {
        stdout.append(tailOut);
        logStream?.write(tailOut);
      }
      const tailErr = decoderErr.decode();
      if (tailErr) {
        stderr.append(tailErr);
        logStream?.write(tailErr);
      }

      const cur = live.get(id);
      if (cur) {
        const status: JobStatus = sig ? 'signaled' : 'exited';
        cur.summary = {
          ...cur.summary,
          status,
          exitCode: code ?? undefined,
          signal: sig ?? undefined,
          endedAt,
          stdoutBytes: stdout.byteLengthTotal,
          stderrBytes: stderr.byteLengthTotal,
          stdoutTail: stdout.tailPreview(TAIL_PREVIEW_BYTES),
          stderrTail: stderr.tailPreview(TAIL_PREVIEW_BYTES),
        };
        state = upsertJob(state, cur.summary);
        try {
          cur.logStream?.end();
        } catch {
          /* ignore */
        }
        cur.child = undefined;
      }
      setExited();
      persist();
      updateStatusline();
    });

    return summary;
  };

  // ── Action implementations. Closures over `state`, `live`, `pi`,
  //    `startJob`. Defined before `registerTool` so eslint's
  //    `no-use-before-define` is satisfied.
  // ──────────────────────────────────────────────────────────────────

  const actStart = async (
    params: {
      command?: string;
      cwd?: string;
      label?: string;
      env?: Record<string, string>;
      interactiveStdin?: boolean;
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

    const cwd = resolveCwd(ctx.cwd, params.cwd);
    const summary = startJob({
      command,
      cwd,
      label: params.label,
      env: params.env,
      interactiveStdin: params.interactiveStdin === true,
    });
    persist();
    updateStatusline();

    const details: BgBashDetails = {
      ...cloneState(state),
      action: 'start',
      job: cloneSummary(summary),
    };
    const text =
      summary.status === 'error'
        ? `Failed to start: ${summary.error ?? 'unknown error'}`
        : `Started [${summary.id}] pid ${summary.pid ?? '?'}: ${truncate(summary.command, 120)}`;
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
      const text = summary.logFile
        ? `(no in-memory buffer; read the log file directly: ${summary.logFile})`
        : '(no logs available — job predates this runtime)';
      return { content: [{ type: 'text', text }], details };
    }

    const stream = params.stream ?? 'merged';
    const maxBytes = params.maxBytes ?? MAX_LOG_RESPONSE_BYTES;

    let content: string;
    let cursor: number;
    let droppedBefore = false;
    let totalBytes: number;
    let droppedBytes: number;

    if (params.tail !== undefined && params.tail >= 0) {
      const merged = mergeStreams(job, stream);
      const lines = tailLines(merged, params.tail);
      content = clampBytes(lines, maxBytes);
      cursor = cursorFor(job, stream);
      totalBytes = totalFor(job, stream);
      droppedBytes = droppedFor(job, stream);
    } else {
      const r = readStream(job, stream, { sinceCursor: params.sinceCursor, maxBytes });
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
    const header = `--- [${id}] ${stream}: ${totalBytes} bytes total, ${droppedBytes} dropped from memory${
      droppedBefore ? ' (your cursor was evicted — fall back to logFile)' : ''
    } ---`;
    const tailNote = summary.logFile ? `\n--- full log: ${summary.logFile} ---` : '';
    return {
      content: [{ type: 'text', text: `${header}\n${content}${tailNote}` }],
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
    if (!job || summary.status !== 'running') {
      // Already terminal.
      const details: BgBashDetails = { ...cloneState(state), action: 'wait', job: cloneSummary(summary) };
      return { content: [{ type: 'text', text: formatJobLine(summary, Date.now()) }], details };
    }

    const timeoutMs = Math.max(0, params.timeoutMs ?? DEFAULT_WAIT_MS);
    let timedOut = false;
    await Promise.race([
      job.exited,
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        abort?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            timedOut = true;
            resolve();
          },
          { once: true },
        );
      }),
    ]);

    const fresh = findJob(state, id) ?? summary;
    const details: BgBashDetails = {
      ...cloneState(state),
      action: 'wait',
      job: cloneSummary(fresh),
      timedOut,
      logExcerpt: timedOut ? undefined : tailN(mergeStreams(job, 'merged'), 20),
    };
    const text = timedOut
      ? `Still running after ${timeoutMs}ms: ${formatJobLine(fresh, Date.now())}`
      : `Exited: ${formatJobLine(fresh, Date.now())}`;
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

  const actRemove = (params: { id?: string }): ToolReturn => {
    const id = params.id;
    if (!id) return errorReturn('remove', 'remove requires `id`');
    const result = removeJob(state, id);
    if (!result.ok) return errorReturn('remove', result.error);
    state = result.state;
    live.delete(id);
    persist();
    updateStatusline();
    const details: BgBashDetails = { ...cloneState(state), action: 'remove' };
    return { content: [{ type: 'text', text: result.summary }], details };
  };

  // ── Lifecycle handlers ─────────────────────────────────────────────

  pi.on('session_start', (_event, ctx) => {
    rebuildFromSession(ctx);
  });

  pi.on('session_tree', (_event, ctx) => {
    // After /tree or /fork, state may have moved to a different point
    // in history — rehydrate.
    rebuildFromSession(ctx);
  });

  pi.on('session_shutdown', async () => {
    // Best-effort reap of every live job. We can't await forever — pi
    // is already on its way out. SIGTERM everything, wait up to
    // `killGraceMs`, then SIGKILL the stragglers.
    const livingIds = [...live.keys()];
    if (livingIds.length === 0) return;

    const now = Date.now();
    for (const id of livingIds) {
      const job = live.get(id);
      if (!job?.child || job.child.exitCode !== null) continue;
      sendSignalTo(job, 'SIGTERM');
    }
    await Promise.race([
      Promise.all(livingIds.map((id) => live.get(id)?.exited)),
      new Promise((r) => setTimeout(r, killGraceMs)),
    ]);
    for (const id of livingIds) {
      const job = live.get(id);
      if (!job?.child || job.child.exitCode !== null) continue;
      sendSignalTo(job, 'SIGKILL');
    }
    state = markLiveJobsTerminated(state, now);
    persist();
    updateStatusline();
  });

  if (autoInjectEnabled) {
    pi.on('before_agent_start', (event, ctx) => {
      // Keep the captured UI reference fresh across session-replacement
      // flows. Some pi actions (/fork, /resume) rebind `ctx.ui` under
      // the hood; re-grabbing it on every turn start keeps the
      // statusline pointing at the current surface.
      uiRef = ctx.ui;
      updateStatusline();
      const block = formatBackgroundJobs(state, { maxChars: maxInjectedChars, now: Date.now() });
      if (!block) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });
  } else {
    // Auto-inject disabled but we still want the statusline refreshed.
    pi.on('before_agent_start', (_event, ctx) => {
      uiRef = ctx.ui;
      updateStatusline();
      return undefined;
    });
  }

  // ── Tool registration ──────────────────────────────────────────────

  pi.registerTool({
    name: 'bg_bash',
    label: 'Background Bash',
    description:
      'Run shell commands in the background and interact with them across subsequent turns. ' +
      'Actions: start (spawn a new job), list (all jobs), status (one job), logs (stdout/stderr, supports tail/grep/sinceCursor), ' +
      'wait (block up to timeoutMs for exit), signal (send SIGINT/SIGTERM/SIGKILL/... to the job process group), ' +
      'stdin (write to a running job — only works when the job was started with interactiveStdin=true), ' +
      'remove (drop a terminal job from the registry). ' +
      'By default jobs run with stdin redirected from /dev/null so non-interactive commands that happen to read ' +
      "stdin (pi's own CLI, cat, ssh, grep) don't hang waiting for EOF. Pass interactiveStdin=true on start if " +
      'you need to feed the job input via action stdin. ' +
      'Jobs live only for the current pi session; on shutdown every live job is terminated.',
    promptSnippet:
      'Run long-lived or latency-hiding commands (test suites, dev servers, watchers, builds) in the background and check on them later.',
    promptGuidelines: [
      'Use `bg_bash` action `start` instead of `bash` whenever a command might run long (>5s), never exits on its own (dev servers, watchers), or should continue while you do other work.',
      'After `bg_bash start`, remember the returned `id`. Call `bg_bash` action `wait` with a short `timeoutMs` to poll for exit, or action `logs` with `sinceCursor` to stream new output incrementally.',
      'Use `bg_bash` action `signal` (SIGTERM by default, SIGKILL if stuck) to stop a job cleanly; the whole process group is targeted so children die too.',
      'Prefer `bg_bash` action `logs` with `tail` or `grep` over returning the full buffer — the ring buffer caps memory but log responses still eat context.',
      'Leave `interactiveStdin` unset for normal commands — stdin is /dev/null by default so nothing hangs waiting for input. Only pass `interactiveStdin: true` when you specifically plan to drive a REPL / long-lived interactive process via action `stdin` (e.g. `sqlite3`, `python -i`, `psql`).',
    ],
    parameters: BgBashParams,

    async execute(_toolCallId, rawParams, sig, _onUpdate, ctx) {
      const params = rawParams as unknown as {
        action: BgBashAction;
        command?: string;
        cwd?: string;
        label?: string;
        env?: Record<string, string>;
        id?: string;
        stream?: StreamName;
        tail?: number;
        sinceCursor?: number;
        grep?: string;
        maxBytes?: number;
        timeoutMs?: number;
        signal?: SignalName;
        text?: string;
        eof?: boolean;
        interactiveStdin?: boolean;
      };

      switch (params.action) {
        case 'start':
          return await actStart(params, ctx);
        case 'list':
          return actList(params.action);
        case 'status':
          return actStatus(params);
        case 'logs':
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

    renderCall(args, theme, _context) {
      let text = theme.fg('toolTitle', theme.bold('bg_bash ')) + theme.fg('muted', args.action);
      if (args.id) text += ` ${theme.fg('accent', `[${args.id}]`)}`;
      if (args.action === 'start' && args.command) {
        text += ` ${theme.fg('dim', `"${truncate(String(args.command).replace(/\s+/g, ' '), 80)}"`)}`;
      }
      if (args.action === 'signal' && args.signal) {
        text += ` ${theme.fg('warning', String(args.signal))}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = (result.details ?? {}) as Partial<BgBashDetails>;
      if (details.error) return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);

      const jobs = details.jobs ?? [];
      const parts: string[] = [];

      // Action-specific lead line first.
      if (details.action === 'start' && details.job) {
        parts.push(
          `${theme.fg('success', '▶')} ${theme.fg('toolTitle', theme.bold(`[${details.job.id}]`))} ${theme.fg(
            'dim',
            `pid ${details.job.pid ?? '?'}`,
          )} ${theme.fg('muted', truncate(details.job.command, 120))}`,
        );
      } else if (details.action === 'wait') {
        if (details.timedOut) parts.push(theme.fg('warning', '⏱ waited, still running'));
        else if (details.job) parts.push(finalLine(details.job, theme));
      } else if (details.action === 'signal' && details.job) {
        parts.push(
          `${theme.fg('warning', '⚡')} sent ${theme.fg('accent', details.job.signal ?? 'signal')} to ${theme.fg(
            'toolTitle',
            theme.bold(`[${details.job.id}]`),
          )}`,
        );
      } else if (details.action === 'stdin' && details.job) {
        parts.push(
          `${theme.fg('muted', '↳ wrote to stdin of ')}${theme.fg('toolTitle', theme.bold(`[${details.job.id}]`))}`,
        );
      } else if (details.action === 'logs' && details.job) {
        const bytes = details.totalBytes ?? 0;
        let head = `${statusIcon(details.job.status)} ${theme.fg('toolTitle', theme.bold(`[${details.job.id}]`))} ${theme.fg(
          'dim',
          `${bytes} total bytes`,
        )}`;
        if (details.droppedBefore) head += ` ${theme.fg('warning', '(cursor evicted)')}`;
        parts.push(head);
      } else if (details.action === 'status' && details.job) {
        parts.push(finalLine(details.job, theme));
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

      // Registry summary (always appended for context).
      //
      // For `action: 'list'` the user explicitly asked for the full
      // registry, so always render every job regardless of expanded
      // state. For every other action the registry is just incidental
      // context, so keep the 5-job cap with a Ctrl+O expand hint when
      // there's more hiding.
      const count = jobs.length;
      const showAll = expanded || details.action === 'list';
      if (count === 0 && details.action !== 'start') {
        parts.push(theme.fg('dim', '(no background jobs)'));
      } else if (count > 0) {
        parts.push(theme.fg('muted', `Registry: ${count} job(s)`));
        const show = showAll ? jobs : jobs.slice(0, 5);
        for (const j of show) parts.push(renderRegistryLine(j, theme));
        if (count > show.length) {
          parts.push(theme.fg('dim', `  … ${count - show.length} more (Ctrl+O to expand)`));
        }
      }

      return new Text(parts.join('\n'), 0, 0);
    },
  });

  // ── /bg-bash command (user-facing inspection / control) ────────────

  pi.registerCommand('bg-bash', {
    description: 'Inspect the background-job registry (list / logs / kill / clear).',
    getArgumentCompletions: (prefix) => {
      const opts = ['list', 'logs', 'kill', 'clear'];
      const items = opts.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = (args ?? '').trim().split(/\s+/);

      if (!sub || sub === 'list') {
        ctx.ui.notify(formatState(state, Date.now()), 'info');
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
        // Drop all terminal jobs from the registry; leave live ones alone.
        const before = state.jobs.length;
        state = {
          ...state,
          jobs: state.jobs.filter((j) => j.status === 'running' || j.status === 'signaled'),
        };
        persist();
        updateStatusline();
        ctx.ui.notify(`Cleared ${before - state.jobs.length} terminal job(s).`, 'info');
        return;
      }
      ctx.ui.notify(`Unknown subcommand: ${sub}. Usage: /bg-bash [list|logs <id>|kill <id> [sig]|clear]`, 'warning');
    },
  });
}
