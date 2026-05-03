/* eslint-disable no-use-before-define */

/**
 * Tests for lib/node/pi/deep-research-structural-check.ts.
 *
 * Fixture-based: every test writes a hand-authored run root under
 * a temp sandbox, calls `checkReportStructure`, and asserts the
 * failure set. A second layer of tests exercises the CLI entry
 * point (spawning `node <module>`) so the `kind=bash`
 * iteration-loop check's shell contract is covered end-to-end.
 *
 * Plan coverage:
 *   - missing footnote (body [^n] without a matching definition)
 *   - unresolved placeholder ({{SRC:...}} remaining in report)
 *   - missing section (fewer `## …` headings than sub-questions)
 *   - mismatched URL (footnote URL not in sources/*.json)
 *   - dangling footnote definition (no marker references it)
 *   - duplicate footnote id
 *   - bare URL in body not in the source store
 *   - happy-path full pass
 *   - missing report short-circuits to `report-exists` fail
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { checkReportStructure, formatFailures } from '../../../../lib/node/pi/deep-research-structural-check.ts';
import { type DeepResearchPlan, writePlan } from '../../../../lib/node/pi/research-plan.ts';
import { type SourceRef } from '../../../../lib/node/pi/research-sources.ts';

// ──────────────────────────────────────────────────────────────────────
// Sandbox helpers.
// ──────────────────────────────────────────────────────────────────────

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-dr-structural-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Materialize a minimal deep-research run root under the sandbox.
 * Writes `plan.json`, `report.md`, and one or more
 * `sources/<id>.json` sidecars (each accompanied by a stub
 * `.md` so `listRun` accepts the ref).
 */
function makeRun(opts: {
  slug?: string;
  plan: DeepResearchPlan;
  report: string;
  sources?: SourceRef[];
  /** Omit `report.md` entirely. */
  omitReport?: boolean;
  /** Omit `plan.json` entirely. */
  omitPlan?: boolean;
}): string {
  const slug = opts.slug ?? opts.plan.slug;
  const runRoot = join(sandbox, 'research', slug);
  mkdirSync(runRoot, { recursive: true });
  if (!opts.omitPlan) {
    writePlan(join(runRoot, 'plan.json'), opts.plan);
  }
  if (!opts.omitReport) {
    writeFileSync(join(runRoot, 'report.md'), opts.report);
  }
  const sources = opts.sources ?? [];
  if (sources.length > 0) {
    mkdirSync(join(runRoot, 'sources'), { recursive: true });
    for (const ref of sources) {
      writeFileSync(join(runRoot, 'sources', `${ref.id}.json`), `${JSON.stringify(ref, null, 2)}\n`);
      writeFileSync(join(runRoot, 'sources', `${ref.id}.md`), `# ${ref.title}\n`);
    }
  }
  return runRoot;
}

function makePlan(overrides: Partial<DeepResearchPlan> = {}): DeepResearchPlan {
  return {
    kind: 'deep-research',
    slug: 'demo',
    question: 'What is the state of X in 2025?',
    status: 'synth',
    budget: { maxSubagents: 2, maxFetches: 4, maxCostUsd: 1, wallClockSec: 300 },
    subQuestions: [
      { id: 'sq-1', question: 'Overview?', status: 'complete' },
      { id: 'sq-2', question: 'Timeline?', status: 'complete' },
      { id: 'sq-3', question: 'Trade-offs?', status: 'complete' },
    ],
    ...overrides,
  };
}

function makeSource(id: string, url: string, title = `Source ${id}`): SourceRef {
  return {
    id,
    url,
    title,
    fetchedAt: '2025-04-05T06:07:08.000Z',
    contentHash: `${id}${id}${id}`,
    method: 'cached',
    mediaType: 'text/markdown',
  };
}

/**
 * Compose a valid deep-research report with three sub-questions,
 * three sources, and three in-body footnote markers. Used as the
 * baseline that every "negative" test perturbs.
 */
function validReport(): string {
  return [
    '# Research: What is the state of X in 2025?',
    '',
    'This report addresses the question.',
    '',
    '## Overview?',
    '',
    'Background paragraph citing a source [^1].',
    '',
    '## Timeline?',
    '',
    'Dates and milestones [^2].',
    '',
    '## Trade-offs?',
    '',
    'Discussion of alternatives [^3].',
    '',
    '## Conclusion',
    '',
    'Wrap-up paragraph.',
    '',
    '[^1]: Source 1 — https://example.com/a',
    '[^2]: Source 2 — https://example.com/b',
    '[^3]: Source 3 — https://example.com/c',
    '',
  ].join('\n');
}

function validSources(): SourceRef[] {
  return [
    makeSource('aaa111111111', 'https://example.com/a', 'Source 1'),
    makeSource('bbb222222222', 'https://example.com/b', 'Source 2'),
    makeSource('ccc333333333', 'https://example.com/c', 'Source 3'),
  ];
}

// ──────────────────────────────────────────────────────────────────────
// Happy path.
// ──────────────────────────────────────────────────────────────────────

describe('checkReportStructure — happy path', () => {
  test('well-formed report with matching sources + sections passes', () => {
    const runRoot = makeRun({ plan: makePlan(), report: validReport(), sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.stats.sections).toBe(3);
    expect(result.stats.footnoteMarkers).toBe(3);
    expect(result.stats.footnoteEntries).toBe(3);
    expect(result.stats.placeholders).toBe(0);
    expect(result.stats.sourcesInStore).toBe(3);
    expect(result.stats.subQuestions).toBe(3);
  });

  test('inline sourceIndex override skips the disk probe', () => {
    // No `sources/` materialized on disk; we hand the index in.
    const runRoot = makeRun({ plan: makePlan(), report: validReport() });

    const result = checkReportStructure({ runRoot, sourceIndex: validSources() });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// report-exists.
// ──────────────────────────────────────────────────────────────────────

describe('checkReportStructure — report-exists', () => {
  test('missing report.md short-circuits to a single failure', () => {
    const runRoot = makeRun({
      plan: makePlan(),
      report: 'ignored — omitReport: true is set below',
      sources: validSources(),
      omitReport: true,
    });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].id).toBe('report-exists');
    expect(result.failures[0].message).toContain('report.md not found');
  });
});

// ──────────────────────────────────────────────────────────────────────
// footnote-markers-resolve.
// ──────────────────────────────────────────────────────────────────────

describe('checkReportStructure — footnote-markers-resolve', () => {
  test('body [^n] marker without a matching definition fails', () => {
    // `validReport` has 3 markers + 3 defs. Drop the [^3] def so
    // the marker becomes dangling.
    const report = validReport().replace('[^3]: Source 3 — https://example.com/c\n', '');
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(false);

    const ids = result.failures.filter((f) => f.id === 'footnote-markers-resolve');

    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids[0].message).toContain('[^3]');
  });

  test('dangling [^n]: definition with no body marker fails', () => {
    // Remove the [^2] body marker but keep the def.
    const report = validReport().replace('Dates and milestones [^2].', 'Dates and milestones.');
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(false);

    const matches = result.failures.filter(
      (f) => f.id === 'footnote-markers-resolve' && f.message.includes('defines [^2]:'),
    );

    expect(matches).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// footnote-urls-in-store.
// ──────────────────────────────────────────────────────────────────────

describe('checkReportStructure — footnote-urls-in-store', () => {
  test('mismatched URL fails with a specific diagnostic', () => {
    // Source [^3] points at a URL that isn't in the store.
    const report = validReport().replace(
      '[^3]: Source 3 — https://example.com/c',
      '[^3]: Source 3 — https://example.com/unknown',
    );
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(false);

    const mismatch = result.failures.filter((f) => f.id === 'footnote-urls-in-store');

    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].message).toContain('example.com/unknown');
  });

  test('tracking-parameter URL is normalized and passes', () => {
    // footnote URL carries a utm_source=... param; the store has
    // the canonical URL. normalizeUrl collapses them.
    const report = validReport().replace(
      '[^1]: Source 1 — https://example.com/a',
      '[^1]: Source 1 — https://example.com/a?utm_source=newsletter&utm_medium=email',
    );
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(true);
  });

  test('footnote without a URL fails with footnote-urls-in-store', () => {
    const report = validReport().replace('[^3]: Source 3 — https://example.com/c', '[^3]: Source 3');
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(false);

    const missingUrl = result.failures.find((f) => f.id === 'footnote-urls-in-store' && f.message.includes('no URL'));

    expect(missingUrl).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// no-unresolved-placeholders.
// ──────────────────────────────────────────────────────────────────────

describe('checkReportStructure — no-unresolved-placeholders', () => {
  test('remaining {{SRC:...}} placeholder fails', () => {
    const report = validReport().replace(
      'Discussion of alternatives [^3].',
      'Discussion of alternatives {{SRC:ccc333333333}}.',
    );
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(false);

    const unresolved = result.failures.filter((f) => f.id === 'no-unresolved-placeholders');

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].message).toContain('{{SRC:ccc333333333}}');
    expect(result.stats.placeholders).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// every-sub-question-has-section.
// ──────────────────────────────────────────────────────────────────────

describe('checkReportStructure — every-sub-question-has-section', () => {
  test('plan with 3 sub-questions but report with 2 sections fails', () => {
    // Drop the third section entirely (heading + body).
    const report = validReport()
      .replace('## Trade-offs?\n\nDiscussion of alternatives [^3].\n\n', '')
      // Also drop the [^3] marker + def so we don't spurious-fail on
      // footnote checks; we want to isolate the missing-section fail.
      .replace('[^3]: Source 3 — https://example.com/c\n', '');
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(false);

    const missingSec = result.failures.filter((f) => f.id === 'every-sub-question-has-section');

    expect(missingSec).toHaveLength(1);
    expect(missingSec[0].message).toContain('2');
    expect(missingSec[0].message).toContain('3');
  });

  test('`## Conclusion` does NOT count as a sub-question section', () => {
    // Same plan; the synth lost the final section, leaving only
    // Overview / Timeline / Conclusion.
    const report = [
      '# title',
      '',
      '## Overview?',
      '',
      'a [^1]',
      '',
      '## Timeline?',
      '',
      'b [^2]',
      '',
      '## Conclusion',
      '',
      'wrap',
      '',
      '[^1]: Source 1 — https://example.com/a',
      '[^2]: Source 2 — https://example.com/b',
    ].join('\n');
    const runRoot = makeRun({
      plan: makePlan(),
      report,
      sources: [validSources()[0], validSources()[1]],
    });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.id === 'every-sub-question-has-section')).toBe(true);
    expect(result.stats.sections).toBe(2);
  });

  test('section-unavailable stub counts as a section', () => {
    // Three headings, one of which is the stub form.
    const report = [
      '# title',
      '',
      '## Overview?',
      '',
      'body a [^1]',
      '',
      '## Timeline?',
      '',
      '[section unavailable: quarantined]',
      '',
      '## Trade-offs?',
      '',
      'body c [^2]',
      '',
      '## Conclusion',
      '',
      'wrap',
      '',
      '[^1]: Source 1 — https://example.com/a',
      '[^2]: Source 3 — https://example.com/c',
    ].join('\n');
    const runRoot = makeRun({
      plan: makePlan(),
      report,
      sources: [validSources()[0], validSources()[2]],
    });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(true);
    expect(result.stats.sections).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────
// no-duplicate-footnote-ids.
// ──────────────────────────────────────────────────────────────────────

describe('checkReportStructure — every-section-cites-a-source', () => {
  test('section without any [^n] marker fails', () => {
    const report = [
      '# title',
      '',
      '## Overview?',
      '',
      'body a [^1]',
      '',
      '## Timeline?',
      '',
      'prose without any citation at all',
      '',
      '## Trade-offs?',
      '',
      'body c [^2]',
      '',
      '## Conclusion',
      '',
      'wrap',
      '',
      '[^1]: Source 1 — https://example.com/a',
      '[^2]: Source 2 — https://example.com/b',
      '',
    ].join('\n');
    const runRoot = makeRun({
      plan: makePlan(),
      report,
      sources: [
        makeSource('aaa111111111', 'https://example.com/a', 'Source 1'),
        makeSource('bbb222222222', 'https://example.com/b', 'Source 2'),
      ],
    });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(false);

    const fails = result.failures.filter((f) => f.id === 'every-section-cites-a-source');

    expect(fails).toHaveLength(1);
    expect(fails[0]?.location).toBe('Timeline?');
  });

  test('[section unavailable: …] stub sections are exempt', () => {
    const report = [
      '# title',
      '',
      '## Overview?',
      '',
      'body a [^1]',
      '',
      '## Timeline?',
      '',
      '[section unavailable: quarantined]',
      '',
      '## Trade-offs?',
      '',
      'body c [^2]',
      '',
      '## Conclusion',
      '',
      'wrap',
      '',
      '[^1]: Source 1 — https://example.com/a',
      '[^2]: Source 2 — https://example.com/b',
      '',
    ].join('\n');
    const runRoot = makeRun({
      plan: makePlan(),
      report,
      sources: [
        makeSource('aaa111111111', 'https://example.com/a', 'Source 1'),
        makeSource('bbb222222222', 'https://example.com/b', 'Source 2'),
      ],
    });

    const result = checkReportStructure({ runRoot });

    const fails = result.failures.filter((f) => f.id === 'every-section-cites-a-source');

    expect(fails).toEqual([]);
  });

  test('zero-citation report (every section uncited) fails with one failure per section', () => {
    const report = [
      '# title',
      '',
      'abstract',
      '',
      '## Overview?',
      '',
      'uncited prose a',
      '',
      '## Timeline?',
      '',
      'uncited prose b',
      '',
      '## Trade-offs?',
      '',
      'uncited prose c',
      '',
      '## Conclusion',
      '',
      'wrap',
      '',
    ].join('\n');
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    const fails = result.failures.filter((f) => f.id === 'every-section-cites-a-source');

    expect(fails.map((f) => f.location)).toEqual(['Overview?', 'Timeline?', 'Trade-offs?']);
  });
});

describe('checkReportStructure — no-duplicate-footnote-ids', () => {
  test('duplicate [^1]: definition fails', () => {
    // Append a second [^1] definition.
    const report = validReport().replace(
      '[^1]: Source 1 — https://example.com/a\n',
      '[^1]: Source 1 — https://example.com/a\n[^1]: Source 1 — https://example.com/a\n',
    );
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(false);

    const dup = result.failures.filter((f) => f.id === 'no-duplicate-footnote-ids');

    expect(dup.some((f) => f.message.includes('^1'))).toBe(true);
  });

  test('gap in numbering ([^1], [^3] with no [^2]) fails', () => {
    const report = [
      '# title',
      '',
      '## Overview?',
      '',
      'cite [^1]',
      '',
      '## Timeline?',
      '',
      'cite [^3]',
      '',
      '## Trade-offs?',
      '',
      'cite [^3]',
      '',
      '## Conclusion',
      '',
      'wrap',
      '',
      '[^1]: Source 1 — https://example.com/a',
      '[^3]: Source 3 — https://example.com/c',
    ].join('\n');
    const runRoot = makeRun({
      plan: makePlan(),
      report,
      sources: [validSources()[0], validSources()[2]],
    });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(false);

    const dense = result.failures.find((f) => f.id === 'no-duplicate-footnote-ids' && f.message.includes('dense'));

    expect(dense).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// no-bare-urls-in-body.
// ──────────────────────────────────────────────────────────────────────

describe('checkReportStructure — no-bare-urls-in-body', () => {
  test('bare URL in body that is not in the store fails', () => {
    const report = validReport().replace(
      'Background paragraph citing a source [^1].',
      'Background paragraph citing https://hallucinated.example.com and a source [^1].',
    );
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(false);

    const bare = result.failures.filter((f) => f.id === 'no-bare-urls-in-body');

    expect(bare).toHaveLength(1);
    expect(bare[0].message).toContain('hallucinated.example.com');
  });

  test('bare URL in body that IS in the store passes silently', () => {
    const report = validReport().replace(
      'Background paragraph citing a source [^1].',
      'Background paragraph — see https://example.com/a — and source [^1].',
    );
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(true);
    expect(result.stats.bareUrlsInBody).toBeGreaterThanOrEqual(1);
  });

  test('sentence-ending punctuation does not cling to the URL', () => {
    // `...see https://example.com/a.` would previously capture the
    // trailing `.` and fail store lookup. The trim helper drops
    // trailing punctuation before normalizing, so this passes.
    const report = validReport().replace(
      'Background paragraph citing a source [^1].',
      'Background paragraph citing a source [^1]. See https://example.com/a.',
    );
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(true);
    expect(result.stats.bareUrlsInBody).toBeGreaterThanOrEqual(1);
  });

  test('sentence-ending punctuation on a footnote URL is tolerated', () => {
    // Same fix applies to footnote definition URLs — a trailing
    // period shouldn't demote the store-match to a mismatch.
    const report = validReport().replace(
      '[^1]: Source 1 — https://example.com/a',
      '[^1]: Source 1 — https://example.com/a.',
    );
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.ok).toBe(true);
  });

  test('URLs inside the footnotes block are NOT flagged', () => {
    // validReport already has URLs inside the footnote definitions;
    // the happy-path test asserts ok=true, so this is covered —
    // here we additionally assert bareUrlsInBody=0, i.e. the
    // partitioning works.
    const runRoot = makeRun({ plan: makePlan(), report: validReport(), sources: validSources() });

    const result = checkReportStructure({ runRoot });

    expect(result.stats.bareUrlsInBody).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatFailures.
// ──────────────────────────────────────────────────────────────────────

describe('formatFailures', () => {
  test('empty result formats to an empty string', () => {
    expect(formatFailures({ ok: true, failures: [], stats: makeStats() })).toBe('');
  });

  test('joins failures one-per-line with [id] prefix', () => {
    const text = formatFailures({
      ok: false,
      failures: [
        { id: 'no-unresolved-placeholders', message: 'bad 1', location: '{{SRC:x}}' },
        { id: 'footnote-markers-resolve', message: 'bad 2' },
      ],
      stats: makeStats(),
    });

    expect(text.split('\n')).toEqual([
      '[no-unresolved-placeholders] bad 1 [{{SRC:x}}]',
      '[footnote-markers-resolve] bad 2',
    ]);
  });
});

function makeStats(): {
  footnoteMarkers: number;
  footnoteEntries: number;
  sections: number;
  subQuestions: number;
  placeholders: number;
  sourcesInStore: number;
  bareUrlsInBody: number;
} {
  return {
    footnoteMarkers: 0,
    footnoteEntries: 0,
    sections: 0,
    subQuestions: 0,
    placeholders: 0,
    sourcesInStore: 0,
    bareUrlsInBody: 0,
  };
}

// ──────────────────────────────────────────────────────────────────────
// CLI smoke test — exercise the `node <module> <runRoot>` shape
// the `kind=bash` iteration-loop check will invoke.
// ──────────────────────────────────────────────────────────────────────

describe('deep-research-structural-check CLI', () => {
  const modulePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'lib',
    'node',
    'pi',
    'deep-research-structural-check.ts',
  );

  test('module file exists', () => {
    expect(existsSync(modulePath)).toBe(true);
  });

  test('exits 0 with stdout "ok …" on a passing run', () => {
    const runRoot = makeRun({ plan: makePlan(), report: validReport(), sources: validSources() });
    const result = spawnSync(process.execPath, [modulePath, runRoot], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok');
    expect(result.stderr).toBe('');
  });

  test('exits 1 with diagnostics on stderr on a failing run', () => {
    const report = validReport().replace(
      'Discussion of alternatives [^3].',
      'Discussion of alternatives {{SRC:ccc333333333}}.',
    );
    const runRoot = makeRun({ plan: makePlan(), report, sources: validSources() });
    const result = spawnSync(process.execPath, [modulePath, runRoot], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[no-unresolved-placeholders]');
    expect(result.stderr).toContain('{{SRC:ccc333333333}}');
  });

  test('exits 2 on missing argument', () => {
    const result = spawnSync(process.execPath, [modulePath], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Usage:');
  });
});
