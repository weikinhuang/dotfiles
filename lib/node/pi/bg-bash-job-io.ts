/**
 * Per-job stdio wiring for the bg-bash extension: decode a child's stdout /
 * stderr into the ring buffers + on-disk log, and decide WHEN the job is
 * finished.
 *
 * Node emits a child's `'exit'` as soon as the process is reaped, which can
 * be before its stdout / stderr pipes are drained - both because the pipe
 * still holds unread bytes (a large final write) and because a backgrounded
 * grandchild (`cmd &`, npx -> node -> worker) inherited the pipe and keeps
 * writing after the shell exits. Finalizing on `'exit'` therefore reported a
 * short byte count, resolved `wait` / fired the completion nudge early, and
 * ended the log file before the late bytes arrived.
 *
 * Contract implemented here:
 *
 *   - `'exit'` only records the exit code / signal and arms a bounded drain
 *     deadline (`drainMs`).
 *   - `'close'` (every stdio stream closed) finalizes the job. A `'close'`
 *     with no prior `'exit'` still finalizes from its own code / signal.
 *   - If the deadline passes first (a grandchild holds the pipe open), the
 *     job finalizes with `outputOpen: true`. Late bytes are still appended
 *     to the sinks and the log (nothing is dropped) and still fire `onData`,
 *     so live byte counters keep tracking the ring; `onFinal` never fires
 *     twice.
 *   - `'error'` (spawn failure) finalizes immediately as `kind: 'error'`.
 *   - `onClose` fires once when the stdio pipes are really closed - the
 *     caller ends the log stream there, never earlier.
 *
 * Streaming `TextDecoder`s keep multi-byte codepoints intact across chunk
 * boundaries; each decoder is flushed when its stream ends (or at `'close'`).
 *
 * Only plain `EventEmitter`s are required so the spec can drive exact
 * event orderings without spawning. No pi imports.
 */

import { type EventEmitter } from 'node:events';

/** Stream names this module reports through `onData`. */
export type JobIoStreamName = 'stdout' | 'stderr';

/** Minimal child-process surface (satisfied by `ChildProcess`). */
export interface JobIoChild extends EventEmitter {
  readonly stdout: EventEmitter | null;
  readonly stderr: EventEmitter | null;
}

/** Destination for decoded text (a `RingBuffer` in production). */
export interface JobIoSink {
  append(text: string): void;
}

/** Terminal outcome handed to `onFinal` exactly once. */
export interface JobIoFinal {
  kind: 'exit' | 'error';
  exitCode?: number;
  signal?: string;
  /** Error message for `kind: 'error'`. */
  error?: string;
  /**
   * True when the drain deadline passed before stdio closed: a background
   * process still holds the output pipe. Later bytes keep landing in the
   * sinks and log.
   */
  outputOpen: boolean;
}

export interface JobIoOptions {
  stdout: JobIoSink;
  stderr: JobIoSink;
  /** Interleaved log writer (the on-disk log file). */
  log?: (text: string) => void;
  /** Max ms to keep draining stdio after `'exit'` before finalizing anyway. */
  drainMs: number;
  /** Called after every non-empty append (including post-final bytes). */
  onData?: (stream: JobIoStreamName) => void;
  /** Called exactly once when the job is done. */
  onFinal: (final: JobIoFinal) => void;
  /** Called once when every stdio stream has closed (end the log here). */
  onClose?: () => void;
}

export interface JobIoHandle {
  /** True once `onFinal` has fired. */
  readonly finalized: boolean;
  /** True once `onClose` has fired. */
  readonly closed: boolean;
}

export function attachJobIo(child: JobIoChild, opts: JobIoOptions): JobIoHandle {
  const state = { finalized: false, closed: false };
  let exitInfo: { code: number | null; signal: string | null } | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const clearDrain = (): void => {
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    drainTimer = undefined;
  };

  const finalize = (final: JobIoFinal): void => {
    if (state.finalized) return;
    state.finalized = true;
    clearDrain();
    opts.onFinal(final);
  };

  const finalizeExit = (outputOpen: boolean): void => {
    finalize({
      kind: 'exit',
      exitCode: exitInfo?.code ?? undefined,
      signal: exitInfo?.signal ?? undefined,
      outputOpen,
    });
  };

  const wire = (stream: EventEmitter | null, sink: JobIoSink, name: JobIoStreamName): (() => void) => {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const push = (text: string): void => {
      if (!text) return;
      sink.append(text);
      opts.log?.(text);
      opts.onData?.(name);
    };
    let flushed = false;
    const flush = (): void => {
      if (flushed) return;
      flushed = true;
      push(decoder.decode());
    };
    stream?.on('data', (chunk: Buffer | string) => {
      push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    });
    stream?.on('end', flush);
    return flush;
  };

  const flushOut = wire(child.stdout, opts.stdout, 'stdout');
  const flushErr = wire(child.stderr, opts.stderr, 'stderr');

  child.on('error', (err: Error) => {
    finalize({ kind: 'error', error: err.message, outputOpen: false });
  });

  child.on('exit', (code: number | null, signal: string | null) => {
    exitInfo = { code, signal };
    if (state.finalized || drainTimer !== undefined) return;
    drainTimer = setTimeout(() => finalizeExit(true), Math.max(0, opts.drainMs));
    // Never let the drain timer keep the host process alive on its own.
    (drainTimer as { unref?: () => void }).unref?.();
  });

  child.on('close', (code: number | null, signal: string | null) => {
    exitInfo ??= { code, signal };
    flushOut();
    flushErr();
    finalizeExit(false);
    if (state.closed) return;
    state.closed = true;
    opts.onClose?.();
  });

  return {
    get finalized() {
      return state.finalized;
    },
    get closed() {
      return state.closed;
    },
  };
}
