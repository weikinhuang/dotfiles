import { describe, expect, it } from 'vitest';

import type { ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import { reminderContentAnchor } from '../../../../../lib/node/pi/reminder-identity.ts';
import {
  createExtractionJob,
  EXTRACTION_JOB_ENTRY,
  extractionAuditOutcome,
  extractionJobMetadata,
  formatExtractionJobs,
  pendingExtractionJobs,
  resolveExtractionSpan,
  scanExtractionJobs,
  updateExtractionStage,
  type ExtractionJob,
  type ExtractionJobIdentity,
} from '../../../../../lib/node/pi/roleplay/extraction-jobs.ts';

const identity: ExtractionJobIdentity = {
  cast: 'private-cast',
  fromAnchor: 'entry:private-start:0',
  toAnchor: 'entry:private-end:0',
  sourceRecapId: 'private-recap-entry',
  fromTurn: 1,
  toTurn: 3,
};

function entry(data: unknown): Record<string, unknown> {
  return { type: 'custom', customType: EXTRACTION_JOB_ENTRY, data };
}

function job(index = 0): ExtractionJob {
  return createExtractionJob({ ...identity, fromAnchor: `entry:start-${index}:0` }, 10);
}

function complete(value: ExtractionJob): ExtractionJob {
  return updateExtractionStage(
    updateExtractionStage(value, 'facts', 'complete', 20),
    'timeline',
    'skipped',
    20,
    'disabled',
  );
}

function message(id: string, content = 'RAW SECRET SCENE'): ReminderMessage {
  return { role: 'user', content, cacheReminderEntryId: id };
}

describe('durable extraction jobs', () => {
  it('keeps unbounded identity lookup separate from bounded terminal presentation', () => {
    const records = Array.from({ length: 35 }, (_, i) => entry(complete(job(i))));
    const shown = scanExtractionJobs(records, identity.cast);
    const all = scanExtractionJobs(records, identity.cast, { terminalLimit: Number.MAX_SAFE_INTEGER });
    expect(shown).toHaveLength(20);
    expect(all).toHaveLength(35);
    expect(all.find((value) => value.id === job(0).id)?.facts.status).toBe('complete');
  });

  it('classifies empty results, malformed output, write errors and model failures without raw error text', () => {
    expect(extractionAuditOutcome('')).toEqual({ status: 'complete' });
    expect(extractionAuditOutcome('no-beats')).toEqual({ status: 'skipped', reason: 'no-results' });
    expect(extractionAuditOutcome('invalid-output')).toEqual({ status: 'failed', reason: 'invalid-output' });
    expect(extractionAuditOutcome('write-error')).toEqual({ status: 'failed', reason: 'write-error' });
    expect(JSON.stringify(extractionAuditOutcome('PRIVATE_PROVIDER_ERROR'))).not.toContain('PRIVATE');
  });

  it('creates metadata-only deterministic cast/span identities, independent of recap retries', () => {
    const extra = { ...identity, scene: 'RAW SECRET SCENE', recap: 'RAW SECRET RECAP', error: 'PRIVATE MODEL ERROR' };
    const first = createExtractionJob(extra, 10);
    expect(first).toMatchObject({
      ...identity,
      facts: { status: 'pending', attempts: 0 },
      timeline: { status: 'pending' },
    });
    expect(first.id).toMatch(/^[a-f0-9]{64}$/);
    expect(createExtractionJob({ ...identity, sourceRecapId: 'another-commit' }, 99).id).toBe(first.id);
    for (const change of [{ cast: 'other' }, { fromAnchor: 'other' }, { toAnchor: 'other' }])
      expect(createExtractionJob({ ...identity, ...change }, 10).id).not.toBe(first.id);
    expect(JSON.stringify(first)).not.toMatch(/RAW SECRET|PRIVATE MODEL|scene|recap"|error/);
    expect(first).not.toHaveProperty('scene');
    expect(first).not.toHaveProperty('recap');
  });

  it('recovers interrupted work after recap commit without changing recap or claiming prior coverage', () => {
    const queued = job();
    const running = updateExtractionStage(queued, 'facts', 'running', 11);
    const recap = { type: 'custom', customType: 'roleplay-recap', data: { text: 'committed recap', coveredTurns: 3 } };
    const branch = [recap, entry(queued), entry(running)];
    const restored = scanExtractionJobs(branch, identity.cast, { now: 12 });
    expect(restored).toHaveLength(1);
    expect(restored[0].facts).toEqual({
      status: 'interrupted',
      attempts: 1,
      reason: 'restored-running',
      updatedAt: 12,
    });
    expect(restored[0].timeline.status).toBe('pending');
    expect(pendingExtractionJobs(restored, 'facts')).toEqual(restored);
    expect(scanExtractionJobs([recap], identity.cast)).toEqual([]);
    expect(branch[2].data).toEqual(running);
    expect(recap.data.text).toBe('committed recap');
    expect(scanExtractionJobs(branch, identity.cast, { restore: false })[0].facts.status).toBe('running');
    // The caller can append the restored full state, then resume normally.
    const retry = updateExtractionStage(restored[0], 'facts', 'running', 13);
    expect(retry.facts.attempts).toBe(2);
    expect(scanExtractionJobs([...branch, entry(restored[0]), entry(retry)], identity.cast)[0].facts.attempts).toBe(2);
  });

  it('persists stage completion and retries only unfinished stages', () => {
    const queued = job();
    const facts = updateExtractionStage(updateExtractionStage(queued, 'facts', 'running', 11), 'facts', 'complete', 12);
    const timeline = updateExtractionStage(facts, 'timeline', 'running', 13);
    const failed = updateExtractionStage(timeline, 'timeline', 'failed', 14, 'write-error');
    const restored = scanExtractionJobs([entry(queued), entry(facts), entry(timeline), entry(failed)], identity.cast);
    expect(pendingExtractionJobs(restored, 'facts')).toEqual([]);
    expect(pendingExtractionJobs(restored, 'timeline')).toHaveLength(1);
    expect(pendingExtractionJobs(restored, 'all')).toHaveLength(1);
    const retry = updateExtractionStage(restored[0], 'timeline', 'running', 15);
    expect(retry.timeline).toEqual({ status: 'running', attempts: 2, updatedAt: 15 });
    expect(retry.facts).toEqual(facts.facts);
    const done = updateExtractionStage(retry, 'timeline', 'complete', 16);
    const persisted = scanExtractionJobs([entry(done)], identity.cast);
    expect(pendingExtractionJobs(persisted)).toEqual([]);
    expect(updateExtractionStage(done, 'facts', 'running', 17)).toEqual(done);
    expect(updateExtractionStage(complete(queued), 'timeline', 'running', 21).timeline.status).toBe('skipped');
  });

  it('does not duplicate jobs or reset completed stages on repeated scheduling', () => {
    const queued = job();
    const facts = updateExtractionStage(queued, 'facts', 'complete', 11);
    const duplicate = createExtractionJob({ ...identity, fromAnchor: queued.fromAnchor }, 99);
    const recapRetry = { ...duplicate, createdAt: 10, sourceRecapId: 'different-recap' };
    const reduced = scanExtractionJobs(
      [entry(queued), entry(facts), entry(queued), entry(duplicate), entry(recapRetry)],
      identity.cast,
    );
    expect(reduced).toEqual([facts]);
    const same = scanExtractionJobs([entry(queued), entry(queued)], identity.cast);
    expect(same).toEqual([queued]);
  });

  it('reads only the supplied tree path and stops at both scene and cast boundaries', () => {
    const shared = job();
    const left = updateExtractionStage(shared, 'facts', 'complete', 11);
    const right = updateExtractionStage(shared, 'timeline', 'skipped', 12, 'disabled');
    expect(scanExtractionJobs([entry(shared), entry(left)], identity.cast)).toEqual([left]);
    expect(scanExtractionJobs([entry(shared), entry(right)], identity.cast)).toEqual([right]);
    expect(scanExtractionJobs([entry(shared)], 'different-cast')).toEqual([]);
    for (const customType of ['roleplay-newscene', 'roleplay-cast-change']) {
      const marker = { type: 'custom', customType, data: { cast: identity.cast } };
      expect(scanExtractionJobs([entry(shared), marker, entry({ malformed: true })], identity.cast)).toEqual([]);
      expect(scanExtractionJobs([entry(shared), marker, entry(right)], identity.cast)).toEqual([right]);
    }
    expect(
      scanExtractionJobs([entry(shared), { type: 'custom', customType: 'roleplay-newscene' }], identity.cast),
    ).toEqual([]);
  });

  it('retains the last 20 terminal jobs plus every unfinished job, even failed/interrupted ones', () => {
    const terminal = Array.from({ length: 25 }, (_, index) => complete(job(index)));
    const pending = job(30);
    const failed = updateExtractionStage(job(31), 'timeline', 'failed', 21, 'model-error');
    const running = updateExtractionStage(job(32), 'facts', 'running', 21);
    const entries = [entry(pending), entry(failed), ...terminal.map(entry), entry(running)];
    const result = scanExtractionJobs(entries, identity.cast);
    expect(result).toHaveLength(23);
    expect(result.map((value) => value.id)).toEqual([
      pending.id,
      failed.id,
      ...terminal.slice(5).map((value) => value.id),
      running.id,
    ]);
    expect(scanExtractionJobs(entries, identity.cast, { terminalLimit: 0 })).toHaveLength(3);
    expect(scanExtractionJobs(entries, identity.cast, { terminalLimit: 1 })).toHaveLength(4);
    expect(
      scanExtractionJobs(
        Array.from({ length: 30 }, (_, index) => entry(job(index))),
        identity.cast,
      ),
    ).toHaveLength(30);
  });

  it('resolves original message keys using a strictly exclusive, present end anchor', () => {
    const start = message(identity.fromAnchor, 'UNIQUE RAW START');
    const middle = message('entry:middle:0');
    const end = message(identity.toAnchor);
    const messages = [message('before'), start, middle, end, message('after')];
    const queued = createExtractionJob(identity, 10);
    expect(resolveExtractionSpan(queued, messages)).toEqual([start, middle]);
    expect(
      resolveExtractionSpan({ fromAnchor: reminderContentAnchor(start), toAnchor: identity.toAnchor }, [start, end]),
    ).toEqual([start]);
    expect(resolveExtractionSpan(queued, [start, middle])).toBeNull();
    expect(resolveExtractionSpan(queued, [middle, end])).toBeNull();
    expect(resolveExtractionSpan(queued, [end, start])).toBeNull();
    expect(resolveExtractionSpan(queued, [start, start, end])).toBeNull();
    expect(resolveExtractionSpan(queued, [start, end, end])).toBeNull();
    expect(
      resolveExtractionSpan({ fromAnchor: identity.fromAnchor, toAnchor: identity.fromAnchor }, messages),
    ).toBeNull();
  });

  it('does not guess span coverage after compaction removes either anchor', () => {
    const queued = createExtractionJob(identity, 10);
    const compacted = [message('compacted-summary'), message(identity.toAnchor)];
    const recovered = scanExtractionJobs([entry(queued), { type: 'compaction' }], identity.cast);
    expect(recovered).toEqual([queued]);
    expect(resolveExtractionSpan(recovered[0], compacted)).toBeNull();
    expect(resolveExtractionSpan(recovered[0], [message(identity.fromAnchor)])).toBeNull();
    const unavailable = updateExtractionStage(recovered[0], 'facts', 'failed', 11, 'span-unavailable');
    expect(scanExtractionJobs([entry(unavailable)], identity.cast)[0].facts.reason).toBe('span-unavailable');
  });

  it('redacts identifiers and arbitrary data from default text and safe debug DTOs', () => {
    const queued = createExtractionJob(identity, 10);
    const failed = updateExtractionStage(queued, 'timeline', 'failed', 11, 'model-error');
    expect(formatExtractionJobs([failed])).toBe('Job 1: turns 1-3; facts pending; timeline failed (model-error)');
    const metadata = extractionJobMetadata([failed]);
    expect(metadata).toEqual([{ ordinal: 1, fromTurn: 1, toTurn: 3, facts: failed.facts, timeline: failed.timeline }]);
    for (const secret of [identity.cast, identity.fromAnchor, identity.toAnchor, identity.sourceRecapId, queued.id]) {
      expect(JSON.stringify(metadata)).not.toContain(secret);
      expect(formatExtractionJobs([failed])).not.toContain(secret);
    }
    metadata[0].facts.status = 'complete';
    expect(failed.facts.status).toBe('pending');
    const noTurns = createExtractionJob(
      { cast: 'cast', fromAnchor: 'start', toAnchor: 'end', sourceRecapId: 'recap' },
      10,
    );
    expect(formatExtractionJobs([noTurns])).toContain('turns unavailable');
    const untrusted = { ...failed, facts: { ...failed.facts, reason: 'RAW SECRET ERROR' } } as unknown as ExtractionJob;
    expect(extractionJobMetadata([untrusted])).toEqual([]);
    expect(formatExtractionJobs([untrusted])).toBe('');
  });

  it('rejects invalid/untrusted records instead of copying raw text or using numeric coverage', () => {
    const valid = job();
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...valid, id: 'forged' },
      { ...valid, scene: 'RAW SECRET SCENE' },
      { ...valid, text: 'RAW SECRET SCENE' },
      { ...valid, cutoff: 3 },
      { ...valid, sourceRecapId: '' },
      { ...valid, cast: '' },
      { ...valid, toAnchor: valid.fromAnchor },
      { ...valid, updatedAt: 9 },
      { ...valid, fromTurn: -1 },
      { ...valid, toTurn: 0.1 },
      { ...valid, fromTurn: 5, toTurn: 2 },
      { ...valid, facts: { ...valid.facts, status: 'unknown' } },
      { ...valid, facts: { ...valid.facts, reason: 'PRIVATE ERROR' } },
      { ...valid, facts: { ...valid.facts, attempts: -1 } },
      { ...valid, facts: { ...valid.facts, status: 'running', attempts: 0 } },
      { ...valid, facts: { ...valid.facts, attempts: Number.NaN } },
      { ...valid, facts: { ...valid.facts, updatedAt: Number.POSITIVE_INFINITY } },
      { ...valid, facts: { ...valid.facts, text: 'RAW SECRET' } },
    ];
    expect(scanExtractionJobs(invalid.map(entry), identity.cast)).toEqual([]);
    expect(scanExtractionJobs([entry(valid), ...invalid.map(entry)], identity.cast)).toEqual([valid]);
    expect(
      scanExtractionJobs([{ type: 'message', customType: EXTRACTION_JOB_ENTRY, data: valid }], identity.cast),
    ).toEqual([]);
    expect(() => createExtractionJob({ ...identity, toAnchor: identity.fromAnchor }, 10)).toThrow(
      'Invalid extraction job metadata',
    );
    expect(() => createExtractionJob(identity, -1)).toThrow('Invalid extraction job metadata');
    expect(() => updateExtractionStage(valid, 'facts', 'running', 9)).toThrow('Invalid extraction stage update');
    expect(() => scanExtractionJobs([], identity.cast, { terminalLimit: -1 })).toThrow(
      'Invalid extraction scan options',
    );
    expect(() => scanExtractionJobs([], identity.cast, { now: Number.NaN })).toThrow('Invalid extraction scan options');
  });

  it('never mutates snapshots or lets an older stage state overwrite a newer completed stage', () => {
    const queued = job();
    const running = updateExtractionStage(queued, 'facts', 'running', 11);
    const runningAgain = updateExtractionStage(running, 'facts', 'running', 12);
    expect(runningAgain.facts.attempts).toBe(1);
    const done = updateExtractionStage(runningAgain, 'facts', 'complete', 13);
    expect(scanExtractionJobs([entry(done), entry(running)], identity.cast)).toEqual([done]);
    const result = scanExtractionJobs([entry(done)], identity.cast);
    result[0].facts.status = 'failed';
    expect(done.facts.status).toBe('complete');
    expect(queued.facts).toEqual({ status: 'pending', attempts: 0, updatedAt: 10 });
  });
});
