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

describe('readJournal - failure modes', () => {
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
    // recognized entry - callers see it, understand something is
    // wrong, and can decide what to do. We do not crash.
    expect(entries[0].body).toContain('[bogus]');
  });

  test('completely malformed file returns []', () => {
    writeFileSync(journal, 'not a journal at all\n\nno headings here either\n');

    expect(readJournal(journal)).toEqual([]);
  });
});

describe('appendJournal - atomic-write contract', () => {
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
  // atomicity surface - it reads, composes, and calls
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
    // Truncated / wrong shape - must not poison the total.
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

  test('falls back to `cost report` body total when no cost-delta entries exist', () => {
    // Shape written by research-budget-live.appendSummary at
    // pipeline exit: per-phase `phase=...spent=...USD` lines, then
    // a blank line, then a `total=<USD> USD wall=<s>s` line. This
    // is what real pipeline runs produce today; the cost-hook path
    // that writes `cost delta` headings depends on
    // `usage.cost.total` being populated by the provider SDK, which
    // does not always happen (e.g. llama-cpp / self-hosted).
    appendJournal(journal, {
      level: 'step',
      heading: 'cost report',
      body: [
        'phase=planner spent=0.000455 USD wall=49.42s',
        'phase=plan-crit spent=0.000257 USD wall=33.48s',
        'phase=fanout spent=0.000583 USD wall=477.22s',
        'phase=synth spent=0.000129 USD wall=61.40s',
        '',
        'total=0.001424 USD wall=621.53s',
      ].join('\n'),
    });

    expect(sumJournalCostUsd(journal)).toBeCloseTo(0.001424, 6);
  });

  test('sums `total=` across multiple `cost report` entries (resume case)', () => {
    // Prior run wrote its own cost report, resume run wrote another.
    // Cumulative spend is the sum of both totals.
    appendJournal(journal, {
      level: 'step',
      heading: 'cost report',
      body: 'phase=planner spent=1.00 USD wall=10.00s\n\ntotal=1.000000 USD wall=10.00s',
    });
    appendJournal(journal, {
      level: 'step',
      heading: 'cost report',
      body: 'phase=fanout spent=2.50 USD wall=30.00s\n\ntotal=2.500000 USD wall=30.00s',
    });

    expect(sumJournalCostUsd(journal)).toBeCloseTo(3.5, 6);
  });

  test('ignores cost-report entries with no parseable total line', () => {
    appendJournal(journal, {
      level: 'step',
      heading: 'cost report',
      body: 'phase=planner spent=0.5 USD wall=10.00s',
    });
    appendJournal(journal, {
      level: 'step',
      heading: 'cost report',
      body: 'total=not-a-number USD',
    });
    appendJournal(journal, {
      level: 'step',
      heading: 'cost report',
      // Heading-only report (no body).
    });

    expect(sumJournalCostUsd(journal)).toBe(0);
  });

  test('only `cost report` heading (not a nested body line) is matched', () => {
    // A step entry whose heading happens to contain `cost report`
    // as part of a longer string must NOT be parsed as a cost
    // report. The match requires the heading to equal 'cost report'
    // exactly.
    appendJournal(journal, {
      level: 'step',
      heading: 'emit cost report summary',
      body: 'total=99.0 USD wall=0s',
    });

    expect(sumJournalCostUsd(journal)).toBe(0);
  });

  test('returns max when both cost-delta and cost-report sources are present', () => {
    // Both sources populated for the same work should agree, but
    // if they drift (e.g. a turn missed by the hook), `max` is
    // defensive and picks the larger figure.
    appendJournal(journal, { level: 'step', heading: 'cost delta · planning · 0.400 USD' });
    appendJournal(journal, { level: 'step', heading: 'cost delta · fanout · 0.500 USD' });
    appendJournal(journal, {
      level: 'step',
      heading: 'cost report',
      // Hook sum = 0.9, but the report total is higher (1.0);
      // report total wins because we take the max.
      body: 'total=1.000000 USD wall=10s',
    });

    expect(sumJournalCostUsd(journal)).toBeCloseTo(1.0, 6);
  });
});
