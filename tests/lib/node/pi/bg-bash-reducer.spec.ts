/**
 * Tests for lib/node/pi/bg-bash-reducer.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  allocateId,
  BG_BASH_CUSTOM_TYPE,
  BG_BASH_TOOL_NAME,
  type BgBashState,
  type BranchEntry,
  cloneState,
  emptyState,
  findJob,
  formatBytes,
  formatDuration,
  formatJobHeader,
  formatJobLine,
  formatJobRow,
  formatLogTailExitHeader,
  formatLogTailHeader,
  formatState,
  hasLiveJobs,
  isBgBashStateShape,
  type JobSummary,
  markLiveJobsTerminated,
  partitionJobs,
  pruneUnattachableJobs,
  reduceBranch,
  removeJob,
  stateFromEntry,
  statusIcon,
  upsertJob,
} from '../../../../lib/node/pi/bg-bash-reducer.ts';
import { assertErr, assertOk } from './helpers.ts';

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

function mkJob(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'abc12345',
    command: 'echo hi',
    cwd: '/tmp',
    pid: 1000,
    status: 'running',
    startedAt: 1_000_000,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTail: '',
    stderrTail: '',
    ...overrides,
  };
}

function mkState(jobs: JobSummary[], nextId?: number): BgBashState {
  return { jobs: jobs.map((j) => ({ ...j })), nextId: nextId ?? jobs.length + 1 };
}

const mkCustom = (state: BgBashState): BranchEntry => ({
  type: 'custom',
  customType: BG_BASH_CUSTOM_TYPE,
  data: state,
});

const mkToolResult = (state: BgBashState): BranchEntry => ({
  type: 'message',
  message: { role: 'toolResult', toolName: BG_BASH_TOOL_NAME, details: state },
});

const mkAssistant = (): BranchEntry => ({ type: 'message', message: { role: 'assistant' } });

// ──────────────────────────────────────────────────────────────────────
// isBgBashStateShape
// ──────────────────────────────────────────────────────────────────────

test('isBgBashStateShape: accepts empty state', () => {
  expect(isBgBashStateShape({ jobs: [], nextId: 1 })).toBe(true);
});

test('isBgBashStateShape: accepts populated state', () => {
  expect(isBgBashStateShape(mkState([mkJob()]))).toBe(true);
});

test('isBgBashStateShape: rejects non-object', () => {
  expect(isBgBashStateShape(null)).toBe(false);
  expect(isBgBashStateShape(undefined)).toBe(false);
  expect(isBgBashStateShape('nope')).toBe(false);
  expect(isBgBashStateShape(42)).toBe(false);
});

test('isBgBashStateShape: rejects missing nextId', () => {
  expect(isBgBashStateShape({ jobs: [] })).toBe(false);
});

test('isBgBashStateShape: rejects non-array jobs', () => {
  expect(isBgBashStateShape({ jobs: 'x', nextId: 1 })).toBe(false);
});

test('isBgBashStateShape: rejects bad status enum', () => {
  const bad = mkJob({ status: 'bogus' as unknown as JobSummary['status'] });

  expect(isBgBashStateShape(mkState([bad]))).toBe(false);
});

test('isBgBashStateShape: rejects missing required string field', () => {
  const bad = { ...mkJob(), command: 42 } as unknown as JobSummary;

  expect(isBgBashStateShape({ jobs: [bad], nextId: 2 })).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// cloneState
// ──────────────────────────────────────────────────────────────────────

test('cloneState: deep-copies jobs so mutations to the copy do not leak', () => {
  const a = mkState([mkJob({ id: 'x' })]);
  const b = cloneState(a);
  b.jobs[0].status = 'exited';

  expect(a.jobs[0].status).toBe('running');
});

// ──────────────────────────────────────────────────────────────────────
// markLiveJobsTerminated
// ──────────────────────────────────────────────────────────────────────

test('markLiveJobsTerminated: rewrites running + signaled jobs to terminated', () => {
  const s = mkState([
    mkJob({ id: 'r1', status: 'running' }),
    mkJob({ id: 's1', status: 'signaled', signal: 'SIGTERM' }),
    mkJob({ id: 'e1', status: 'exited', exitCode: 0, endedAt: 1_000_100 }),
    mkJob({ id: 'x1', status: 'error', error: 'boom', endedAt: 1_000_100 }),
  ]);
  const now = 2_000_000;
  const out = markLiveJobsTerminated(s, now);

  expect(out.jobs.find((j) => j.id === 'r1')?.status).toBe('terminated');
  expect(out.jobs.find((j) => j.id === 'r1')?.endedAt).toBe(now);
  expect(out.jobs.find((j) => j.id === 's1')?.status).toBe('terminated');
  // Already-terminal jobs pass through unchanged.
  expect(out.jobs.find((j) => j.id === 'e1')?.status).toBe('exited');
  expect(out.jobs.find((j) => j.id === 'x1')?.status).toBe('error');
  // Input not mutated.
  expect(s.jobs.find((j) => j.id === 'r1')?.status).toBe('running');
});

test('markLiveJobsTerminated: preserves existing endedAt when already set', () => {
  const s = mkState([mkJob({ id: 'r1', status: 'running', endedAt: 123 })]);
  const out = markLiveJobsTerminated(s, 9_999);

  expect(out.jobs[0].endedAt).toBe(123);
});

// ──────────────────────────────────────────────────────────────────────
// pruneUnattachableJobs
// ──────────────────────────────────────────────────────────────────────

test('pruneUnattachableJobs: keeps exited/signaled/error, drops running/terminated', () => {
  const s = mkState([
    mkJob({ id: 'r1', status: 'running' }),
    mkJob({ id: 's1', status: 'signaled', signal: 'SIGTERM', endedAt: 5 }),
    mkJob({ id: 't1', status: 'terminated', endedAt: 10 }),
    mkJob({ id: 'e1', status: 'exited', exitCode: 0, endedAt: 20 }),
    mkJob({ id: 'x1', status: 'error', error: 'boom', endedAt: 30 }),
  ]);
  const out = pruneUnattachableJobs(s);

  expect(out.jobs.map((j) => j.id)).toEqual(['s1', 'e1', 'x1']);
  // Preserves the existing id allocator so newly-started jobs don't
  // collide with ids from the now-dropped ghosts.
  expect(out.nextId).toBe(s.nextId);
  // Input not mutated.
  expect(s.jobs.length).toBe(5);
});

test('pruneUnattachableJobs: no-op on empty state', () => {
  expect(pruneUnattachableJobs(emptyState())).toEqual(emptyState());
});

test('pruneUnattachableJobs: deep-clones kept jobs', () => {
  const s = mkState([mkJob({ id: 'e1', status: 'exited', exitCode: 0, endedAt: 20 })]);
  const out = pruneUnattachableJobs(s);
  out.jobs[0].exitCode = 99;

  expect(s.jobs[0].exitCode).toBe(0);
});

// ──────────────────────────────────────────────────────────────────────
// stateFromEntry / reduceBranch
// ──────────────────────────────────────────────────────────────────────

test('stateFromEntry: extracts from custom mirror', () => {
  const s = mkState([mkJob()]);

  expect(stateFromEntry(mkCustom(s))).toEqual(s);
});

test('stateFromEntry: extracts from toolResult details', () => {
  const s = mkState([mkJob()]);

  expect(stateFromEntry(mkToolResult(s))).toEqual(s);
});

test('stateFromEntry: returns null for unrelated entries', () => {
  expect(stateFromEntry(mkAssistant())).toBe(null);
  expect(
    stateFromEntry({
      type: 'message',
      message: { role: 'toolResult', toolName: 'read', details: { path: 'x' } },
    }),
  ).toBe(null);
  expect(stateFromEntry({ type: 'custom', customType: 'something-else', data: { jobs: [], nextId: 1 } })).toBe(null);
});

test('stateFromEntry: returns null for malformed data', () => {
  expect(stateFromEntry(mkCustom({ jobs: 'bad', nextId: 1 } as unknown as BgBashState))).toBe(null);
});

test('reduceBranch: picks the newest valid snapshot', () => {
  const older = mkState([mkJob({ id: 'old' })]);
  const newer = mkState([mkJob({ id: 'new' })], 9);
  const branch: BranchEntry[] = [mkCustom(older), mkAssistant(), mkToolResult(newer), mkAssistant()];
  const out = reduceBranch(branch);

  expect(out.jobs[0].id).toBe('new');
  expect(out.nextId).toBe(9);
});

test('reduceBranch: returns emptyState when nothing matches', () => {
  const out = reduceBranch([mkAssistant(), mkAssistant()]);

  expect(out).toEqual(emptyState());
});

// ──────────────────────────────────────────────────────────────────────
// findJob / upsertJob / removeJob
// ──────────────────────────────────────────────────────────────────────

test('findJob: returns the job by id, undefined otherwise', () => {
  const s = mkState([mkJob({ id: 'a' }), mkJob({ id: 'b' })]);

  expect(findJob(s, 'a')?.id).toBe('a');
  expect(findJob(s, 'zzz')).toBeUndefined();
});

test('upsertJob: appends new entries', () => {
  const s = mkState([mkJob({ id: 'a' })]);
  const next = upsertJob(s, mkJob({ id: 'b', status: 'exited', exitCode: 0 }));

  expect(next.jobs.map((j) => j.id)).toEqual(['a', 'b']);
  // Input not mutated.
  expect(s.jobs.length).toBe(1);
});

test('upsertJob: replaces existing entries in place', () => {
  const s = mkState([mkJob({ id: 'a' }), mkJob({ id: 'b' })]);
  const next = upsertJob(s, mkJob({ id: 'a', status: 'exited', exitCode: 7 }));

  expect(next.jobs.map((j) => j.id)).toEqual(['a', 'b']); // order preserved
  expect(next.jobs[0].status).toBe('exited');
  expect(next.jobs[0].exitCode).toBe(7);
});

test('removeJob: fails when job not found', () => {
  const s = mkState([mkJob({ id: 'a' })]);
  const out = removeJob(s, 'missing');
  assertErr(out);

  expect(out.error).toMatch(/not found/);
});

test('removeJob: refuses to drop a running job', () => {
  const s = mkState([mkJob({ id: 'a', status: 'running' })]);
  const out = removeJob(s, 'a');
  assertErr(out);

  expect(out.error).toMatch(/still running/);
});

test('removeJob: refuses to drop a signaled-not-reaped job', () => {
  const s = mkState([mkJob({ id: 'a', status: 'signaled', signal: 'SIGTERM' })]);
  const out = removeJob(s, 'a');
  assertErr(out);

  expect(out.error).toMatch(/still signaled.*wait for it to exit/);
});

test('removeJob: drops a signaled-and-reaped job (endedAt set)', () => {
  const s = mkState([mkJob({ id: 'a', status: 'signaled', signal: 'SIGKILL', endedAt: 42 })]);
  const out = removeJob(s, 'a');
  assertOk(out);

  expect(out.state.jobs).toEqual([]);
  expect(out.summary).toMatch(/Removed a/);
});

test('removeJob: drops terminal jobs', () => {
  const s = mkState([
    mkJob({ id: 'a', status: 'exited', exitCode: 0, endedAt: 10 }),
    mkJob({ id: 'b', status: 'terminated', endedAt: 20 }),
  ]);
  const r1 = removeJob(s, 'a');
  assertOk(r1);

  expect(r1.state.jobs.map((j) => j.id)).toEqual(['b']);

  const r2 = removeJob(r1.state, 'b');
  assertOk(r2);

  expect(r2.state.jobs).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// allocateId
// ──────────────────────────────────────────────────────────────────────

test('allocateId: produces an 8-hex id by default', () => {
  const id = allocateId(emptyState(), () => 0.5);

  expect(id).toMatch(/^[0-9a-f]{8}$/);
});

test('allocateId: rerolls on collision', () => {
  // First two `rand()` calls collide with existing id; third returns a fresh one.
  const existing = mkJob({ id: '00000000' });
  const s = mkState([existing]);

  const seq = [0, 0, 0.999999];
  let i = 0;
  const rand = (): number => seq[Math.min(i++, seq.length - 1)];

  const id = allocateId(s, rand);

  expect(id).not.toBe('00000000');
  expect(id).toMatch(/^[0-9a-f]{8}$/);
});

// ──────────────────────────────────────────────────────────────────────
// partitionJobs / hasLiveJobs
// ──────────────────────────────────────────────────────────────────────

test('partitionJobs: splits running/signaled vs terminal, sorts recents newest-first', () => {
  const s = mkState([
    mkJob({ id: 'a', status: 'exited', exitCode: 0, endedAt: 100 }),
    mkJob({ id: 'b', status: 'running' }),
    mkJob({ id: 'c', status: 'exited', exitCode: 1, endedAt: 300 }),
    mkJob({ id: 'd', status: 'signaled', signal: 'SIGTERM' }),
    mkJob({ id: 'e', status: 'terminated', endedAt: 200 }),
  ]);
  const { running, recent } = partitionJobs(s);

  expect(running.map((j) => j.id)).toEqual(['b', 'd']);
  expect(recent.map((j) => j.id)).toEqual(['c', 'e', 'a']); // 300 > 200 > 100
});

test('partitionJobs: recentCap clamps the terminal list', () => {
  const s = mkState([
    mkJob({ id: 'a', status: 'exited', exitCode: 0, endedAt: 100 }),
    mkJob({ id: 'b', status: 'exited', exitCode: 0, endedAt: 200 }),
    mkJob({ id: 'c', status: 'exited', exitCode: 0, endedAt: 300 }),
  ]);

  expect(partitionJobs(s, { recentCap: 2 }).recent.map((j) => j.id)).toEqual(['c', 'b']);
  expect(partitionJobs(s, { recentCap: 0 }).recent).toEqual([]);
});

test('hasLiveJobs: true iff any running or signaled', () => {
  expect(hasLiveJobs(emptyState())).toBe(false);
  expect(hasLiveJobs(mkState([mkJob({ status: 'exited', exitCode: 0, endedAt: 1 })]))).toBe(false);
  expect(hasLiveJobs(mkState([mkJob({ status: 'running' })]))).toBe(true);
  expect(hasLiveJobs(mkState([mkJob({ status: 'signaled', signal: 'SIGTERM' })]))).toBe(true);
});

// ──────────────────────────────────────────────────────────────────────
// formatters
// ──────────────────────────────────────────────────────────────────────

test('statusIcon: returns a stable glyph per status', () => {
  expect(statusIcon('running')).toBe('●');
  expect(statusIcon('exited')).toBe('✓');
  expect(statusIcon('signaled')).toBe('✗');
  expect(statusIcon('error')).toBe('✗');
  expect(statusIcon('terminated')).toBe('◌');
});

test('formatBytes: binary scaling', () => {
  expect(formatBytes(0)).toBe('0B');
  expect(formatBytes(512)).toBe('512B');
  expect(formatBytes(1024)).toBe('1.0KB');
  expect(formatBytes(1024 * 1024)).toBe('1.0MB');
  expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0GB');
});

test('formatDuration: seconds → m+s → h+m', () => {
  expect(formatDuration(0)).toBe('0s');
  expect(formatDuration(59_000)).toBe('59s');
  expect(formatDuration(60_000)).toBe('1m');
  expect(formatDuration(61_000)).toBe('1m1s');
  expect(formatDuration(3_600_000)).toBe('1h');
  expect(formatDuration(3_660_000)).toBe('1h1m');
});

test('formatJobLine: running - duration + bytes', () => {
  const j = mkJob({
    id: 'abc',
    label: 'tests',
    command: 'npm test',
    status: 'running',
    startedAt: 1_000_000,
    stdoutBytes: 2048,
    stderrBytes: 1024,
  });
  const out = formatJobLine(j, 1_042_000);

  expect(out).toContain('[abc]');
  expect(out).toContain('tests');
  expect(out).toContain('●');
  expect(out).toContain('npm test');
  expect(out).toMatch(/running 42s/);
  expect(out).toMatch(/3\.0KB/);
});

test('formatJobLine: exited shows exit code + wall clock', () => {
  const j = mkJob({
    id: 'abc',
    command: 'make',
    status: 'exited',
    exitCode: 0,
    startedAt: 1_000_000,
    endedAt: 1_005_000,
  });

  expect(formatJobLine(j, 9_999_999)).toMatch(/exited 0 after 5s/);
});

test('formatJobLine: signaled shows the signal name', () => {
  const j = mkJob({
    id: 'abc',
    command: 'sleep 9999',
    status: 'signaled',
    signal: 'SIGTERM',
    startedAt: 1_000_000,
    endedAt: 1_003_000,
  });

  expect(formatJobLine(j, 9_999_999)).toMatch(/SIGTERM after 3s/);
});

test('formatJobLine: terminated has a distinct phrasing', () => {
  const j = mkJob({
    id: 'abc',
    command: 'tail -f log',
    status: 'terminated',
    startedAt: 1_000_000,
    endedAt: 1_010_000,
  });

  expect(formatJobLine(j, 9_999_999)).toMatch(/terminated \(pi session ended\)/);
});

test('formatState: empty vs populated', () => {
  expect(formatState(emptyState(), 0)).toBe('(no background jobs)');

  const s = mkState([mkJob({ id: 'a' })]);

  expect(formatState(s, 1_000_000)).toContain('[a]');
});

// ──────────────────────────────────────────────────────────────────────
// formatJobHeader: the stable single-line inline-card header
// ──────────────────────────────────────────────────────────────────────

test('formatJobHeader: running shows ● + running duration', () => {
  const j = mkJob({
    id: 'j-1',
    command: 'npm run dev',
    status: 'running',
    startedAt: 1_000_000,
    stdoutBytes: 3891,
    stderrBytes: 1126,
  });
  const out = formatJobHeader(j, 1_132_000);

  expect(out.startsWith('● ')).toBe(true);
  expect(out).toContain('[j-1]');
  expect(out).toContain('npm run dev');
  expect(out).toContain('running 2m12s');
  expect(out).toContain('stdout 3.8KB / stderr 1.1KB');
});

test('formatJobHeader: clean exit shows ✓ + exit code + duration', () => {
  const j = mkJob({
    id: 'j-2',
    command: 'pytest -q tests/',
    status: 'exited',
    exitCode: 0,
    startedAt: 1_000_000,
    endedAt: 1_008_000,
    stdoutBytes: 1228, // stderrBytes stays at 0 → no split
  });
  const out = formatJobHeader(j, 9_999_999);

  expect(out.startsWith('✓ ')).toBe(true);
  expect(out).toContain('[j-2]');
  expect(out).toContain('pytest -q tests/');
  expect(out).toContain('exit 0 in 8s');
  expect(out).toContain('1.2KB');
  expect(out).not.toContain('stderr 0B');
});

test('formatJobHeader: non-zero exit gets ✗ glyph', () => {
  const j = mkJob({
    id: 'j-3',
    command: 'build.sh',
    status: 'exited',
    exitCode: 1,
    startedAt: 1_000_000,
    endedAt: 1_000_400,
  });

  expect(formatJobHeader(j, 9_999_999).startsWith('✗ ')).toBe(true);
});

test('formatJobHeader: signaled gets ⚠ glyph + signal name', () => {
  const j = mkJob({
    id: 'j-4',
    command: 'sleep 9999',
    status: 'signaled',
    signal: 'SIGTERM',
    startedAt: 1_000_000,
    endedAt: 1_002_000,
  });
  const out = formatJobHeader(j, 9_999_999);

  expect(out.startsWith('⚠ ')).toBe(true);
  expect(out).toContain('SIGTERM after 2s');
});

test('formatJobHeader: error status uses ✗ and surfaces the message', () => {
  const j = mkJob({
    id: 'j-5',
    command: 'nopebin',
    status: 'error',
    error: 'ENOENT',
    startedAt: 1_000_000,
    endedAt: 1_000_000,
  });

  expect(formatJobHeader(j, 9_999_999)).toMatch(/^✗ \[j-5\].*error: ENOENT/);
});

test('formatJobHeader: terminated gets ◌ glyph', () => {
  const j = mkJob({
    id: 'j-6',
    command: 'tail -f log',
    status: 'terminated',
    startedAt: 1_000_000,
    endedAt: 1_010_000,
  });

  expect(formatJobHeader(j, 9_999_999).startsWith('◌ ')).toBe(true);
});

test('formatJobHeader: timedOut=true overrides glyph + phrase regardless of status', () => {
  const j = mkJob({
    id: 'j-7',
    command: 'sleep 600',
    status: 'running',
    startedAt: 1_000_000,
    stdoutBytes: 0,
    stderrBytes: 0,
  });
  const out = formatJobHeader(j, 1_152_000, { timedOut: true });

  expect(out.startsWith('⌛ ')).toBe(true);
  expect(out).toContain('still running 2m32s');
});

test('formatJobHeader: includes the optional label segment', () => {
  const j = mkJob({
    id: 'abc',
    label: 'tests',
    command: 'npm test',
    status: 'running',
    startedAt: 1_000_000,
  });
  const out = formatJobHeader(j, 1_042_000);

  expect(out).toMatch(/\[abc\] tests {2}npm test/);
});

test('formatJobHeader: bytes summary shows split only when both streams have data', () => {
  const stdoutOnly = mkJob({
    id: 'a',
    command: 'echo hi',
    status: 'exited',
    exitCode: 0,
    startedAt: 1_000_000,
    endedAt: 1_000_100,
    stdoutBytes: 16,
    stderrBytes: 0,
  });

  expect(formatJobHeader(stdoutOnly, 9_999_999)).toContain('16B');
  expect(formatJobHeader(stdoutOnly, 9_999_999)).not.toContain('stdout 16B');

  const both = mkJob({
    id: 'b',
    command: 'mix',
    status: 'exited',
    exitCode: 1,
    startedAt: 1_000_000,
    endedAt: 1_000_100,
    stdoutBytes: 100,
    stderrBytes: 50,
  });

  expect(formatJobHeader(both, 9_999_999)).toContain('stdout 100B / stderr 50B');
});

// ──────────────────────────────────────────────────────────────────────
// formatJobRow: structured columns for the overlay job list
// ──────────────────────────────────────────────────────────────────────

test('formatJobRow: running job exposes phrase/duration/bytes/cmd columns', () => {
  const j = mkJob({
    id: 'j-1',
    command: 'npm run dev',
    status: 'running',
    startedAt: 1_000_000,
    stdoutBytes: 3891,
    stderrBytes: 307,
  });
  const row = formatJobRow(j, 1_132_000, { width: 80 });

  expect(row.id).toBe('[j-1]');
  expect(row.statusGlyph).toBe('●');
  expect(row.statusPhrase).toBe('running');
  expect(row.duration).toBe('2m12s');
  expect(row.bytes).toBe('4.1KB');
  expect(row.cmd).toBe('npm run dev');
});

test('formatJobRow: exited phrase carries the exit code', () => {
  const j = mkJob({
    id: 'j-2',
    command: 'pytest -q tests/',
    status: 'exited',
    exitCode: 0,
    startedAt: 1_000_000,
    endedAt: 1_008_000,
    stdoutBytes: 1228,
  });
  const row = formatJobRow(j, 9_999_999, { width: 80 });

  expect(row.statusGlyph).toBe('✓');
  expect(row.statusPhrase).toBe('exited 0');
  expect(row.duration).toBe('8s');
});

test('formatJobRow: non-zero exit gets ✗', () => {
  const j = mkJob({
    id: 'j-3',
    command: 'build.sh',
    status: 'exited',
    exitCode: 1,
    startedAt: 1_000_000,
    endedAt: 1_000_400,
  });
  const row = formatJobRow(j, 9_999_999, { width: 80 });

  expect(row.statusGlyph).toBe('✗');
  expect(row.statusPhrase).toBe('exited 1');
});

test('formatJobRow: truncates the cmd to fit the available width', () => {
  const j = mkJob({
    id: 'j-9',
    command: 'a'.repeat(200),
    status: 'running',
    startedAt: 1_000_000,
  });
  const row = formatJobRow(j, 1_001_000, { width: 80 });

  expect(row.cmd.length).toBeLessThan(200);
  expect(row.cmd.endsWith('…')).toBe(true);
});

test('formatJobRow: wider terminals get a longer cmd column', () => {
  const j = mkJob({
    id: 'j-9',
    command: 'a'.repeat(200),
    status: 'running',
    startedAt: 1_000_000,
  });
  const narrow = formatJobRow(j, 1_001_000, { width: 80 });
  const wide = formatJobRow(j, 1_001_000, { width: 160 });

  expect(wide.cmd.length).toBeGreaterThan(narrow.cmd.length);
});

// ──────────────────────────────────────────────────────────────────────
// formatLogTailHeader / formatLogTailExitHeader
// ──────────────────────────────────────────────────────────────────────

test('formatLogTailHeader: running job shows pid + bytes split + follow chip', () => {
  const j = mkJob({ id: 'j-1', command: 'npm run dev', status: 'running', pid: 84210, startedAt: 1_000_000 });
  const chip = formatLogTailHeader(j, { stdoutBytes: 3891, stderrBytes: 1126, following: true });

  expect(chip).toContain('pid 84210');
  expect(chip).toContain('stdout 3.8KB / stderr 1.1KB');
  expect(chip).toContain('follow');
});

test('formatLogTailHeader: following=false drops the follow segment', () => {
  const j = mkJob({ id: 'j-1', command: 'npm run dev', status: 'running', pid: 84210, startedAt: 1_000_000 });
  const chip = formatLogTailHeader(j, { stdoutBytes: 3891, stderrBytes: 1126, following: false });

  expect(chip).not.toContain('follow');
});

test('formatLogTailHeader: omits the pid segment when the job has no pid yet', () => {
  const j = mkJob({ id: 'j-1', command: 'npm run dev', status: 'running', startedAt: 1_000_000 });
  delete j.pid;
  const chip = formatLogTailHeader(j, { stdoutBytes: 0, stderrBytes: 0, following: true });

  expect(chip).not.toContain('pid');
});

test('formatLogTailExitHeader: exited shows exit phrase + bytes + log path', () => {
  const j = mkJob({
    id: 'j-2',
    command: 'pytest -q',
    status: 'exited',
    exitCode: 0,
    startedAt: 1_000_000,
    endedAt: 1_008_000,
    stdoutBytes: 1228,
    logFile: '/tmp/pi-bg-bash/abcd/j-2.log',
  });
  const chip = formatLogTailExitHeader(j);

  expect(chip).toContain('exit 0 in 8s');
  expect(chip).toContain('1.2KB');
  expect(chip).toContain('log /tmp/pi-bg-bash/abcd/j-2.log');
});

test('formatLogTailExitHeader: signaled phrase uses the signal name', () => {
  const j = mkJob({
    id: 'j-2',
    command: 'sleep 9999',
    status: 'signaled',
    signal: 'SIGTERM',
    startedAt: 1_000_000,
    endedAt: 1_003_000,
  });

  expect(formatLogTailExitHeader(j)).toContain('SIGTERM after 3s');
});

test('formatLogTailExitHeader: omits log segment when no path is available', () => {
  const j = mkJob({
    id: 'j-2',
    command: 'echo hi',
    status: 'exited',
    exitCode: 0,
    startedAt: 1_000_000,
    endedAt: 1_000_100,
  });

  expect(formatLogTailExitHeader(j, {})).not.toContain('log ');
});
