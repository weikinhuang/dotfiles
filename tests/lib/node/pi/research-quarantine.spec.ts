/**
 * Tests for lib/node/pi/research-quarantine.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { failureCounter, quarantine, type QuarantineReason } from '../../../../lib/node/pi/research-quarantine.ts';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi-quarantine-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('quarantine', () => {
  test('moves the artifact into sibling _quarantined/<name>-<ts>/', () => {
    const findings = join(cwd, 'findings');
    mkdirSync(findings);
    const f = join(findings, 'f-1.md');
    writeFileSync(f, '# finding\n');

    const ts = new Date(Date.UTC(2025, 0, 2, 3, 4, 5));
    const r = quarantine(f, 'malformed', { now: ts });

    expect(existsSync(f)).toBe(false);
    expect(existsSync(r.movedTo)).toBe(true);
    expect(r.movedTo).toBe(join(findings, '_quarantined', 'f-1.md-20250102T030405Z', 'f-1.md'));
    expect(readFileSync(r.movedTo, 'utf8')).toBe('# finding\n');
  });

  test('writes a reason.json alongside the moved artifact', () => {
    const f = join(cwd, 'a.json');
    writeFileSync(f, '{}');

    const ts = new Date(Date.UTC(2025, 5, 7, 1, 2, 3));
    const r = quarantine(f, 'schema violation: missing "kind"', { now: ts, caller: 'test-caller' });

    expect(existsSync(r.reasonFile)).toBe(true);

    const parsed = JSON.parse(readFileSync(r.reasonFile, 'utf8')) as QuarantineReason;

    expect(parsed.reason).toBe('schema violation: missing "kind"');
    expect(parsed.originalPath).toBe(f);
    expect(parsed.ts).toBe('2025-06-07T01:02:03.000Z');
    expect(parsed.caller).toBe('test-caller');
  });

  test('moves the .provenance.json sidecar alongside the artifact', () => {
    const f = join(cwd, 'findings', 'f-2.md');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '---\nmodel: "x"\n---\n# body\n');
    writeFileSync(`${f}.provenance.json`, JSON.stringify({ model: 'x' }));

    const r = quarantine(f, 'bad', { now: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)) });

    expect(existsSync(`${f}.provenance.json`)).toBe(false);
    expect(existsSync(`${r.movedTo}.provenance.json`)).toBe(true);
    expect(JSON.parse(readFileSync(`${r.movedTo}.provenance.json`, 'utf8'))).toEqual({ model: 'x' });
  });

  test('tolerates a missing provenance sidecar', () => {
    const f = join(cwd, 'plain.txt');
    writeFileSync(f, 'hi');

    expect(() => quarantine(f, 'why')).not.toThrow();
  });

  test('breaks same-second ties with a numeric suffix', () => {
    const findings = join(cwd, 'f');
    mkdirSync(findings);
    const ts = new Date(Date.UTC(2025, 0, 1, 0, 0, 0));

    const a = join(findings, 'x.md');
    writeFileSync(a, 'a');
    const r1 = quarantine(a, 'first', { now: ts });

    const b = join(findings, 'x.md');
    writeFileSync(b, 'b');
    const r2 = quarantine(b, 'second', { now: ts });

    expect(r1.movedTo).not.toBe(r2.movedTo);
    expect(r2.movedTo).toContain('x.md-20250101T000000Z-1');
  });

  test('dryRun reports the target paths without touching the filesystem', () => {
    const f = join(cwd, 'p.json');
    writeFileSync(f, '{}');

    const r = quarantine(f, 'preview', { now: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)), dryRun: true });

    expect(existsSync(f)).toBe(true);
    expect(existsSync(r.movedTo)).toBe(false);
    expect(existsSync(r.reasonFile)).toBe(false);
    expect(r.movedTo).toBe(join(cwd, '_quarantined', 'p.json-20250101T000000Z', 'p.json'));
  });

  test('throws when the source does not exist', () => {
    expect(() => quarantine(join(cwd, 'nope.md'), 'why')).toThrow(/does not exist/);
  });
});

describe('failureCounter', () => {
  test('bump increments and returns the new value', () => {
    const c = failureCounter(join(cwd, 'state.json'));

    expect(c.bump('id-1')).toBe(1);
    expect(c.bump('id-1')).toBe(2);
    expect(c.bump('id-1')).toBe(3);
    expect(c.bump('id-2')).toBe(1);
  });

  test('get returns 0 for unknown ids', () => {
    const c = failureCounter(join(cwd, 'state.json'));

    expect(c.get('unknown')).toBe(0);
  });

  test('persists across counter instances', () => {
    const state = join(cwd, 'state.json');
    const a = failureCounter(state);
    a.bump('id');
    a.bump('id');

    const b = failureCounter(state);

    expect(b.get('id')).toBe(2);
    expect(b.bump('id')).toBe(3);
  });

  test('reset removes the entry', () => {
    const c = failureCounter(join(cwd, 'state.json'));
    c.bump('id');
    c.bump('id');

    c.reset('id');

    expect(c.get('id')).toBe(0);
    expect(c.bump('id')).toBe(1);
  });

  test('reset on an unknown id is a no-op', () => {
    const c = failureCounter(join(cwd, 'state.json'));

    expect(() => c.reset('never')).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Failure modes.
// ──────────────────────────────────────────────────────────────────────

describe('failureCounter - failure modes', () => {
  test('corrupt state file is treated as empty state', () => {
    const state = join(cwd, 'state.json');
    writeFileSync(state, 'not json {');
    const c = failureCounter(state);

    expect(c.get('id')).toBe(0);
    // A bump after corrupt-load rewrites the file cleanly.
    expect(c.bump('id')).toBe(1);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual({ id: 1 });
  });

  test('state file that is not a plain object is treated as empty', () => {
    const state = join(cwd, 'state.json');
    writeFileSync(state, '[]');
    const c = failureCounter(state);

    expect(c.get('id')).toBe(0);
  });

  test('negative / non-integer counter values are silently dropped on load', () => {
    const state = join(cwd, 'state.json');
    writeFileSync(state, JSON.stringify({ good: 5, bad: -1, also_bad: 1.5, worse: 'str' }));
    const c = failureCounter(state);

    expect(c.get('good')).toBe(5);
    expect(c.get('bad')).toBe(0);
    expect(c.get('also_bad')).toBe(0);
    expect(c.get('worse')).toBe(0);
  });

  test('atomic-write contract - no temp files after operations', () => {
    const dir = join(cwd, 'dir');
    mkdirSync(dir);
    const c = failureCounter(join(dir, 'state.json'));
    c.bump('a');
    c.bump('b');
    c.reset('a');

    const residue = readdirSync(dir).filter((n) => n.includes('.tmp-'));

    expect(residue).toEqual([]);
  });
});

describe('quarantine - failure modes', () => {
  test('produces a traversable directory even under deeply nested parents', () => {
    const deep = join(cwd, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    const f = join(deep, 'x.json');
    writeFileSync(f, '{}');

    const r = quarantine(f, 'why', { now: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)) });

    expect(r.movedTo.startsWith(join(deep, '_quarantined'))).toBe(true);
    expect(existsSync(r.reasonFile)).toBe(true);
  });

  test('sidecar invariant: provenance survives the move alongside the artifact', () => {
    // This is the cross-module invariant the Phase 5 failure-mode
    // suite will formalize; we assert it locally here too.
    const f = join(cwd, 'report.md');
    writeFileSync(f, '# r\n');
    writeFileSync(`${f}.provenance.json`, '{"model":"m","thinkingLevel":null,"timestamp":"t","promptHash":"h"}');

    const r = quarantine(f, 'structural failure', { now: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)) });

    expect(existsSync(`${r.movedTo}.provenance.json`)).toBe(true);
    // Neither the original artifact nor its sidecar remain at the
    // source path.
    expect(existsSync(f)).toBe(false);
    expect(existsSync(`${f}.provenance.json`)).toBe(false);
  });
});
