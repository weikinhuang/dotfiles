/**
 * Tests for lib/node/pi/bg-bash-job-io.ts.
 *
 * Two halves:
 *
 *   - A fake child (plain EventEmitters) drives the exact `exit` / `data` /
 *     `end` / `close` orderings Node produces, including output that lands
 *     AFTER `exit` because a backgrounded grandchild still holds the pipe.
 *   - Real `spawn` cases reproduce the original lost-output bug end to end:
 *     the job must not finalize before the grandchild's output is read, and
 *     the on-disk log must hold every byte the ring counted.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { attachJobIo, type JobIoFinal } from '../../../../lib/node/pi/bg-bash-job-io.ts';
import { RingBuffer } from '../../../../lib/node/pi/bg-bash-ring.ts';

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

interface Harness {
  child: FakeChild;
  out: RingBuffer;
  err: RingBuffer;
  log: string[];
  finals: { final: JobIoFinal; outBytes: number; errBytes: number; logBytes: number }[];
  closes: number;
  dataEvents: string[];
}

function harness(drainMs: number): Harness {
  const child = new FakeChild();
  const h: Harness = {
    child,
    out: new RingBuffer(),
    err: new RingBuffer(),
    log: [],
    finals: [],
    closes: 0,
    dataEvents: [],
  };
  attachJobIo(child, {
    stdout: h.out,
    stderr: h.err,
    log: (s) => h.log.push(s),
    drainMs,
    onData: (stream) => h.dataEvents.push(stream),
    onFinal: (final) =>
      h.finals.push({
        final,
        outBytes: h.out.byteLengthTotal,
        errBytes: h.err.byteLengthTotal,
        logBytes: Buffer.byteLength(h.log.join('')),
      }),
    onClose: () => {
      h.closes++;
    },
  });
  return h;
}

describe('attachJobIo (fake child)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('does not finalize on exit while stdio is still open; finalizes on close with every byte', () => {
    const h = harness(2000);
    h.child.stdout.emit('data', Buffer.from('a\n'));
    h.child.emit('exit', 0, null);
    expect(h.finals).toHaveLength(0);
    // Grandchild output arriving after the shell exited.
    h.child.stdout.emit('data', Buffer.from(`${'b'.repeat(5000)}\n`));
    h.child.stdout.emit('end');
    h.child.stderr.emit('end');
    h.child.emit('close', 0, null);

    expect(h.finals).toHaveLength(1);
    const f = h.finals[0];
    expect(f.final).toEqual({ kind: 'exit', exitCode: 0, signal: undefined, outputOpen: false });
    expect(f.outBytes).toBe(5003);
    expect(f.logBytes).toBe(5003);
    expect(h.out.read().content).toBe(`a\n${'b'.repeat(5000)}\n`);
    expect(h.closes).toBe(1);
  });

  test('drain deadline finalizes with outputOpen=true when a grandchild holds the pipe', () => {
    const h = harness(2000);
    h.child.stdout.emit('data', Buffer.from('a\n'));
    h.child.emit('exit', 0, null);
    vi.advanceTimersByTime(1999);
    expect(h.finals).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.finals).toHaveLength(1);
    expect(h.finals[0].final.outputOpen).toBe(true);
    expect(h.finals[0].outBytes).toBe(2);

    // Late bytes still land in the ring + log (lossless) and fire onData,
    // but onFinal never fires twice.
    h.child.stdout.emit('data', Buffer.from('late\n'));
    expect(h.out.byteLengthTotal).toBe(7);
    expect(h.log.join('')).toBe('a\nlate\n');
    expect(h.dataEvents).toEqual(['stdout', 'stdout']);
    h.child.emit('close', 0, null);
    expect(h.finals).toHaveLength(1);
    expect(h.closes).toBe(1);
  });

  test('close before the deadline clears the drain timer', () => {
    const h = harness(2000);
    h.child.emit('exit', 3, null);
    h.child.emit('close', 3, null);
    vi.advanceTimersByTime(5000);
    expect(h.finals).toHaveLength(1);
    expect(h.finals[0].final).toMatchObject({ kind: 'exit', exitCode: 3, outputOpen: false });
  });

  test('records the terminating signal', () => {
    const h = harness(2000);
    h.child.emit('exit', null, 'SIGTERM');
    h.child.emit('close', null, 'SIGTERM');
    expect(h.finals[0].final).toEqual({ kind: 'exit', exitCode: undefined, signal: 'SIGTERM', outputOpen: false });
  });

  test('close without a prior exit event still finalizes from the close args', () => {
    const h = harness(2000);
    h.child.emit('close', 1, null);
    expect(h.finals[0].final).toMatchObject({ kind: 'exit', exitCode: 1, outputOpen: false });
  });

  test('flushes a multi-byte codepoint split across chunks on stream end', () => {
    const h = harness(2000);
    const euro = Buffer.from('€'); // 3 bytes
    h.child.stdout.emit('data', euro.subarray(0, 2));
    expect(h.out.byteLengthTotal).toBe(0);
    h.child.stdout.emit('data', euro.subarray(2));
    expect(h.out.read().content).toBe('€');
    // A dangling partial at EOF is flushed (as U+FFFD) instead of dropped.
    h.child.stderr.emit('data', euro.subarray(0, 1));
    h.child.stderr.emit('end');
    expect(h.err.read().content).toBe('\uFFFD');
  });

  test('spawn error finalizes immediately as kind=error; the later close only fires onClose', () => {
    const h = harness(2000);
    h.child.emit('error', new Error('spawn nope ENOENT'));
    expect(h.finals).toEqual([
      {
        final: { kind: 'error', error: 'spawn nope ENOENT', outputOpen: false },
        outBytes: 0,
        errBytes: 0,
        logBytes: 0,
      },
    ]);
    h.child.emit('close', -2, null);
    expect(h.finals).toHaveLength(1);
    expect(h.closes).toBe(1);
  });

  test('drainMs=0 finalizes on the next timer tick after exit', () => {
    const h = harness(0);
    h.child.emit('exit', 0, null);
    expect(h.finals).toHaveLength(0);
    vi.advanceTimersByTime(0);
    expect(h.finals).toHaveLength(1);
    expect(h.finals[0].final.outputOpen).toBe(true);
  });

  test('stderr bytes count separately and interleave into the log', () => {
    const h = harness(2000);
    h.child.stdout.emit('data', Buffer.from('o1\n'));
    h.child.stderr.emit('data', Buffer.from('e1\n'));
    h.child.emit('exit', 0, null);
    h.child.stdout.emit('data', Buffer.from('o2\n'));
    h.child.emit('close', 0, null);
    expect(h.finals[0]).toMatchObject({ outBytes: 6, errBytes: 3, logBytes: 9 });
    expect(h.log.join('')).toBe('o1\ne1\no2\n');
    expect(h.dataEvents).toEqual(['stdout', 'stderr', 'stdout']);
  });
});

describe('attachJobIo (real spawn)', () => {
  let dir: string;
  const pids: number[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bg-bash-job-io-'));
  });
  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  interface RunResult {
    final: JobIoFinal;
    finalOutBytes: number;
    finalAfterMs: number;
    out: RingBuffer;
    logFile: string;
    closed: Promise<void>;
  }

  function run(command: string, drainMs: number): Promise<RunResult> {
    const out = new RingBuffer();
    const err = new RingBuffer();
    const logFile = join(dir, 'job.log');
    const logStream = createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (child.pid !== undefined) pids.push(child.pid);
    let exitAt = 0;
    child.on('exit', () => {
      exitAt = Date.now();
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    return new Promise<RunResult>((resolve) => {
      attachJobIo(child, {
        stdout: out,
        stderr: err,
        log: (s) => logStream.write(s),
        drainMs,
        onFinal: (final) =>
          resolve({
            final,
            finalOutBytes: out.byteLengthTotal,
            finalAfterMs: Date.now() - exitAt,
            out,
            logFile,
            closed,
          }),
        onClose: () => logStream.end(resolveClosed),
      });
    });
  }

  const node = JSON.stringify(process.execPath);

  test('output a grandchild prints after the shell exits is in the ring, the log file, and the final count', async () => {
    const r = await run(`echo a; ${node} -e 'setTimeout(()=>console.log("b".repeat(5000)),200)' & exit 0`, 2000);
    expect(r.final).toMatchObject({ kind: 'exit', exitCode: 0, outputOpen: false });
    expect(r.finalOutBytes).toBe(2 + 5001);
    expect(r.out.read().content).toBe(`a\n${'b'.repeat(5000)}\n`);
    await r.closed;
    expect(readFileSync(r.logFile).length).toBe(r.finalOutBytes);
  });

  test('a grandchild that never closes the pipe hits the drain deadline instead of hanging', async () => {
    const r = await run('echo a; sleep 5 & exit 0', 150);
    expect(r.final).toMatchObject({ kind: 'exit', exitCode: 0, outputOpen: true });
    expect(r.finalOutBytes).toBe(2);
    expect(r.finalAfterMs).toBeGreaterThanOrEqual(100);
    expect(r.finalAfterMs).toBeLessThan(2000);
  });

  test('plain commands finalize with every byte and the exit code', async () => {
    // `process.exitCode` (not `process.exit()`): on macOS pipe writes are
    // async, so an explicit exit would truncate the child's own output.
    const r = await run(`${node} -e 'process.stdout.write("x".repeat(200000)); process.exitCode = 4'`, 2000);
    expect(r.final).toMatchObject({ kind: 'exit', exitCode: 4, outputOpen: false });
    expect(r.finalOutBytes).toBe(200000);
    await r.closed;
    expect(readFileSync(r.logFile).length).toBe(200000);
  });
});
