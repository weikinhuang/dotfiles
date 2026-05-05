/**
 * Tests for lib/node/pi/research-journal.ts.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  appendJournal,
  readJournal,
  sumJournalCostUsd,
  tailJournal,
} from '../../../../lib/node/pi/research-journal.ts';

let cwd: string;
let journal: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi-journal-'));
  journal = join(cwd, 'journal.md');
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('appendJournal', () => {
  test('creates the file on first call', () => {
    appendJournal(journal, {
      level: 'info',
      heading: 'First entry',
      ts: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)),
    });

    expect(existsSync(journal)).toBe(true);

    const text = readFileSync(journal, 'utf8');

    expect(text).toBe('## [2025-01-01T00:00:00.000Z] [info] First entry\n');
  });

  test('includes the body block when present', () => {
    appendJournal(journal, {
      level: 'step',
      heading: 'Planner done',
      body: 'Produced 5 sub-questions.',
      ts: new Date(Date.UTC(2025, 0, 1, 0, 0, 1)),
    });

    const text = readFileSync(journal, 'utf8');

    expect(text).toBe('## [2025-01-01T00:00:01.000Z] [step] Planner done\n\nProduced 5 sub-questions.\n');
  });

  test('successive entries are blank-line separated', () => {
    appendJournal(journal, { level: 'info', heading: 'A', ts: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)) });
    appendJournal(journal, { level: 'info', heading: 'B', ts: new Date(Date.UTC(2025, 0, 1, 0, 0, 1)) });

    const text = readFileSync(journal, 'utf8');

    expect(text).toBe('## [2025-01-01T00:00:00.000Z] [info] A\n\n## [2025-01-01T00:00:01.000Z] [info] B\n');
  });

  test('defaults to new Date when ts is omitted', () => {
    const before = new Date();
    appendJournal(journal, { level: 'info', heading: 'X' });
    const after = new Date();

    const entries = readJournal(journal);
    const ts = new Date(entries[0].ts);

    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  test('monotonic ordering is respected by readJournal', () => {
    appendJournal(journal, { level: 'info', heading: 'first', ts: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)) });
    appendJournal(journal, { level: 'info', heading: 'second', ts: new Date(Date.UTC(2025, 0, 1, 0, 0, 1)) });
    appendJournal(journal, { level: 'info', heading: 'third', ts: new Date(Date.UTC(2025, 0, 1, 0, 0, 2)) });

    const entries = readJournal(journal);

    expect(entries.map((e) => e.heading)).toEqual(['first', 'second', 'third']);
  });
});

describe('readJournal', () => {
  test('returns [] when the file does not exist', () => {
    expect(readJournal(join(cwd, 'nope.md'))).toEqual([]);
  });

  test('parses heading-only and heading+body entries', () => {
    appendJournal(journal, { level: 'info', heading: 'heading-only', ts: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)) });
    appendJournal(journal, {
      level: 'warn',
      heading: 'with body',
      body: 'line 1\nline 2',
      ts: new Date(Date.UTC(2025, 0, 1, 0, 0, 1)),
    });

    const entries = readJournal(journal);

    expect(entries).toEqual([
      { ts: '2025-01-01T00:00:00.000Z', level: 'info', heading: 'heading-only' },
      { ts: '2025-01-01T00:00:01.000Z', level: 'warn', heading: 'with body', body: 'line 1\nline 2' },
    ]);
  });

  test('multi-line body is preserved', () => {
    appendJournal(journal, {
      level: 'error',
      heading: 'boom',
      body: 'stack trace:\n  at foo\n  at bar',
      ts: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)),
    });

    const entries = readJournal(journal);

    expect(entries[0].body).toBe('stack trace:\n  at foo\n  at bar');
  });

  test('body with leading indentation round-trips without losing it', () => {
    // Regression: an earlier implementation stripped all leading
    // whitespace (not just newlines), which silently ate the
    // indentation of the first body line.
    appendJournal(journal, {
      level: 'info',
      heading: 'code block',
      body: '    indented first line\n    line two\nflush',
      ts: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)),
    });

    const entries = readJournal(journal);

    expect(entries[0].body).toBe('    indented first line\n    line two\nflush');
  });

  test('tolerates CRLF line endings in an externally-edited file', () => {
    writeFileSync(
      journal,
      '## [2025-01-01T00:00:00.000Z] [info] win\r\n\r\nwindows body\r\n\r\n## [2025-01-01T00:00:01.000Z] [step] next\r\n',
    );

    const entries = readJournal(journal);

    expect(entries.map((e) => e.heading)).toEqual(['win', 'next']);
    expect(entries[0].body).toBe('windows body');
  });
});

describe('tailJournal', () => {
  test('returns the last n entries, oldest-first within the slice', () => {
    for (let i = 0; i < 5; i++) {
      appendJournal(journal, {
        level: 'info',
        heading: `e${i}`,
        ts: new Date(Date.UTC(2025, 0, 1, 0, 0, i)),
      });
    }

    const tail = tailJournal(journal, 2);

    expect(tail.map((e) => e.heading)).toEqual(['e3', 'e4']);
  });

  test('n larger than total returns everything', () => {
    appendJournal(journal, { level: 'info', heading: 'one', ts: new Date() });

    const tail = tailJournal(journal, 10);

    expect(tail.length).toBe(1);
  });

  test('n <= 0 returns []', () => {
    appendJournal(journal, { level: 'info', heading: 'a', ts: new Date() });

    expect(tailJournal(journal, 0)).toEqual([]);
    expect(tailJournal(journal, -1)).toEqual([]);
  });

  test('missing file returns []', () => {
    expect(tailJournal(join(cwd, 'nope.md'), 3)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Failure modes.
// ──────────────────────────────────────────────────────────────────────

describe('readJournal — failure modes', () => {
  test('text before the first heading is ignored', () => {
    writeFileSync(
      journal,
      'preamble text that predates any entries\nmore preamble\n\n## [2025-01-01T00:00:00.000Z] [info] first\n',
    );

    const entries = readJournal(journal);

    expect(entries.length).toBe(1);
    expect(entries[0].heading).toBe('first');
  });

  test('entry with an unknown level is demoted into the previous entry body', () => {
    writeFileSync(
      journal,
      '## [2025-01-01T00:00:00.000Z] [info] one\n\n## [2025-01-01T00:00:01.000Z] [bogus] two\ncontinuation\n',
    );

    const entries = readJournal(journal);

    expect(entries.length).toBe(1);
    expect(entries[0].heading).toBe('one');
    // The bogus heading is preserved as body text of the only
    // recognized entry — callers see it, understand something is
    // wrong, and can decide what to do. We do not crash.
    expect(entries[0].body).toContain('[bogus]');
  });

  test('completely malformed file returns []', () => {
    writeFileSync(journal, 'not a journal at all\n\nno headings here either\n');

    expect(readJournal(journal)).toEqual([]);
  });
});

describe('appendJournal — atomic-write contract', () => {
  test('no .tmp- files remain after a sequence of appends', () => {
    for (let i = 0; i < 20; i++) {
      appendJournal(journal, {
        level: 'info',
        heading: `e${i}`,
        body: `body ${i}\nline\n`,
        ts: new Date(Date.UTC(2025, 0, 1, 0, 0, i)),
      });
    }

    const dir = cwd;
    const residue = readFileSync(journal, 'utf8');

    expect(residue).toContain('e0');
    expect(residue).toContain('e19');

    // tempfiles sit alongside the target in the same dir
    const tmp = readdirSync(dir).filter((n) => n.includes('.tmp-'));

    expect(tmp).toEqual([]);
  });

  // Mid-write crash atomicity (process dies between tempfile write and
  // rename → target either holds prior bytes or new bytes, never a
  // mix) is a property of `atomic-write.atomicWriteFile` itself and is
  // covered by `tests/lib/node/pi/atomic-write.spec.ts`. We do not
  // re-test it here because `appendJournal` adds no additional
  // atomicity surface — it reads, composes, and calls
  // `atomicWriteFile` once.
});

describe('sumJournalCostUsd', () => {
  test('missing journal returns 0', () => {
    expect(sumJournalCostUsd(join(cwd, 'absent.md'))).toBe(0);
  });

  test('empty journal returns 0', () => {
    writeFileSync(journal, '', 'utf8');

    expect(sumJournalCostUsd(journal)).toBe(0);
  });

  test('journal with no cost-delta entries returns 0', () => {
    appendJournal(journal, { level: 'step', heading: 'planner produced 3 sub-questions' });
    appendJournal(journal, { level: 'step', heading: 'fanout complete' });

    expect(sumJournalCostUsd(journal)).toBe(0);
  });

  test('sums every cost-delta heading', () => {
    appendJournal(journal, { level: 'step', heading: 'cost delta · planning · 0.012000 USD' });
    appendJournal(journal, { level: 'step', heading: 'cost delta · fanout · 0.400000 USD' });
    appendJournal(journal, { level: 'step', heading: 'cost delta · synth · 0.080500 USD' });
    appendJournal(journal, { level: 'step', heading: 'cost delta · review · 0.005000 USD' });

    expect(sumJournalCostUsd(journal)).toBeCloseTo(0.4975, 6);
  });

  test('ignores malformed cost lines', () => {
    appendJournal(journal, { level: 'step', heading: 'cost delta · planning · 0.1 USD' });
    // Truncated / wrong shape — must not poison the total.
    appendJournal(journal, { level: 'step', heading: 'cost delta · oops' });
    appendJournal(journal, { level: 'step', heading: 'cost delta · x · abc USD' });
    appendJournal(journal, { level: 'step', heading: 'cost delta · y · -1.0 USD' });

    expect(sumJournalCostUsd(journal)).toBeCloseTo(0.1, 6);
  });

  test('scientific / exponent floats are rejected (keep the regex strict)', () => {
    appendJournal(journal, { level: 'step', heading: 'cost delta · x · 1e-3 USD' });

    expect(sumJournalCostUsd(journal)).toBe(0);
  });

  test('accumulates across resumes (multiple matching headings are summed)', () => {
    // First run's entries.
    appendJournal(journal, { level: 'step', heading: 'cost delta · planning · 0.010 USD' });
    appendJournal(journal, { level: 'step', heading: 'cost delta · fanout · 0.200 USD' });
    // Resume run appends more.
    appendJournal(journal, { level: 'step', heading: 'cost delta · fanout · 0.050 USD' });
    appendJournal(journal, { level: 'step', heading: 'cost delta · review · 0.001 USD' });

    expect(sumJournalCostUsd(journal)).toBeCloseTo(0.261, 6);
  });
});
