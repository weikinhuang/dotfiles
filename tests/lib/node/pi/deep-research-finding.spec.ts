/**
 * Tests for lib/node/pi/deep-research-finding.ts.
 *
 * Validator + classifyFindings + source-title normalization.
 * Quarantine moves are covered end-to-end via the pipeline spec;
 * here we exercise the pure helpers in isolation.
 */

import { describe, expect, test, vi } from 'vitest';

import {
  classifyFindings,
  extractFindingSourceUrls,
  FINDING_HEADINGS,
  FINDING_MAX_CHARS,
  FINDING_MAX_REPROMPTS,
  normalizeSourceTitles,
  validateFindingText,
} from '../../../../lib/node/pi/deep-research-finding.ts';
import { type TinyAdapter } from '../../../../lib/node/pi/research-tiny.ts';
import { assertErr, assertKind, assertOk } from './helpers.ts';

const VALID = [
  '# Sub-question: What is the capital of France?',
  '',
  '## Findings',
  '- Paris is the capital city [S1].',
  '',
  '## Sources',
  '- [S1] https://example.com/paris - Paris page',
  '',
  '## Open questions',
  '- None.',
].join('\n');

// ──────────────────────────────────────────────────────────────────────
// validateFindingText.
// ──────────────────────────────────────────────────────────────────────

describe('validateFindingText', () => {
  test('accepts a minimal well-formed document', () => {
    const result = validateFindingText(VALID);

    assertOk(result);

    expect(result.sections.subQuestion).toBe('What is the capital of France?');
    expect(result.sections.findings).toContain('Paris is the capital');
    expect(result.sections.sources).toContain('[S1]');
    expect(result.sections.openQuestions).toBe('- None.');
    expect(result.truncated).toBe(false);
  });

  test('rejects empty body', () => {
    const result = validateFindingText('   ');

    assertErr(result);

    expect(result.diff).toContain('empty');
  });

  test('rejects missing title heading', () => {
    const text = VALID.replace(FINDING_HEADINGS.title, '#');
    const result = validateFindingText(text);

    expect(result.ok).toBe(false);
  });

  test('rejects missing Findings section', () => {
    const text = VALID.replace('## Findings\n', '');
    const result = validateFindingText(text);

    assertErr(result);

    expect(result.issues.join(' ')).toContain('missing section "## Findings"');
  });

  test('rejects out-of-order sections', () => {
    // Swap Sources and Findings order.
    const text = [
      '# Sub-question: Q',
      '',
      '## Sources',
      '- [S1] https://example.com/x - desc',
      '',
      '## Findings',
      '- claim [S1]',
      '',
      '## Open questions',
      '- None.',
    ].join('\n');
    const result = validateFindingText(text);

    assertErr(result);

    expect(result.diff).toContain('order');
  });

  test('rejects empty sub-question body after the colon', () => {
    const text = VALID.replace('# Sub-question: What is the capital of France?', '# Sub-question:  ');
    const result = validateFindingText(text);

    expect(result.ok).toBe(false);
  });

  test('truncates over-long bodies with a sentinel comment', () => {
    const filler = 'x'.repeat(FINDING_MAX_CHARS * 2);
    const text = VALID.replace('## Open questions', `## Open questions\n- ${filler}`);
    const result = validateFindingText(text);

    assertOk(result);

    expect(result.truncated).toBe(true);
    expect(result.normalized.length).toBeLessThanOrEqual(FINDING_MAX_CHARS);
    expect(result.normalized).toContain('<!-- truncated -->');
  });
});

// ──────────────────────────────────────────────────────────────────────
// classifyFindings - failure-counter policy.
// ──────────────────────────────────────────────────────────────────────

describe('classifyFindings', () => {
  test('accepts valid findings on first try regardless of counter', () => {
    const action = classifyFindings({ text: VALID, subQuestionId: 'sq-1', priorFailures: 0 });

    expect(action.kind).toBe('accept');
  });

  test('first malformed → reprompt (not quarantine)', () => {
    const action = classifyFindings({ text: 'not even markdown', subQuestionId: 'sq-1', priorFailures: 0 });

    assertKind(action, 'reprompt');

    expect(action.reprompt).toContain('sq-1');
    expect(action.reprompt).toContain('Rewrite');
  });

  test(`after ${FINDING_MAX_REPROMPTS} prior failures, another malformed → quarantine`, () => {
    const action = classifyFindings({
      text: 'still broken',
      subQuestionId: 'sq-1',
      priorFailures: FINDING_MAX_REPROMPTS,
    });

    assertKind(action, 'quarantine');

    expect(action.reason).toContain('malformed findings');
  });
});

// ──────────────────────────────────────────────────────────────────────
// normalizeSourceTitles (tiny-adapter integration).
// ──────────────────────────────────────────────────────────────────────

describe('normalizeSourceTitles', () => {
  test('no-ops when adapter is disabled', async () => {
    const adapter: TinyAdapter<unknown> = {
      isEnabled: () => false,
      callTinyRewrite: () => Promise.resolve(null),
      callTinyClassify: () => Promise.resolve(null),
      callTinyMatch: () => Promise.resolve(null),
      getTotalCost: () => 0,
    };
    const body = '- [S1] https://example.com - Raw Page Title | SiteName';
    const out = await normalizeSourceTitles({
      sections: { subQuestion: '', findings: '', sources: body, openQuestions: '' },
      adapter,
      ctx: { cwd: '/tmp', model: undefined, modelRegistry: { find: () => undefined, authStorage: null } },
    });

    expect(out).toBe(body);
  });

  test('rewrites source descriptions via tiny normalize-title', async () => {
    const rewrite = vi.fn<(ctx: unknown, task: string, input: string) => Promise<string | null>>(
      (_ctx, task, input) => {
        if (task !== 'normalize-title') return Promise.resolve(null);
        return Promise.resolve(input.replace(' | SiteName', '').trim());
      },
    );
    const adapter: TinyAdapter<unknown> = {
      isEnabled: () => true,
      callTinyRewrite: rewrite,
      callTinyClassify: () => Promise.resolve(null),
      callTinyMatch: () => Promise.resolve(null),
      getTotalCost: () => 0,
    };
    const body = [
      '- [S1] https://example.com - Raw Page Title | SiteName',
      '- [S2] https://foo.test/x - Foo Bar Baz | SiteName',
    ].join('\n');
    const out = await normalizeSourceTitles({
      sections: { subQuestion: '', findings: '', sources: body, openQuestions: '' },
      adapter,
      ctx: { cwd: '/tmp', model: undefined, modelRegistry: { find: () => undefined, authStorage: null } },
    });

    expect(out).toContain('Raw Page Title');
    expect(out).not.toContain('| SiteName');
    expect(rewrite).toHaveBeenCalledTimes(2);
  });

  test('preserves description when tiny returns null', async () => {
    const adapter: TinyAdapter<unknown> = {
      isEnabled: () => true,
      callTinyRewrite: () => Promise.resolve(null),
      callTinyClassify: () => Promise.resolve(null),
      callTinyMatch: () => Promise.resolve(null),
      getTotalCost: () => 0,
    };
    const body = '- [S1] https://example.com - Untouched';
    const out = await normalizeSourceTitles({
      sections: { subQuestion: '', findings: '', sources: body, openQuestions: '' },
      adapter,
      ctx: { cwd: '/tmp', model: undefined, modelRegistry: { find: () => undefined, authStorage: null } },
    });

    expect(out).toBe(body);
  });

  test('tolerates sources with no dash-separated description', async () => {
    const adapter: TinyAdapter<unknown> = {
      isEnabled: () => true,
      callTinyRewrite: () => Promise.resolve('should-not-fire'),
      callTinyClassify: () => Promise.resolve(null),
      callTinyMatch: () => Promise.resolve(null),
      getTotalCost: () => 0,
    };
    const body = '- [S1] https://example.com';
    const out = await normalizeSourceTitles({
      sections: { subQuestion: '', findings: '', sources: body, openQuestions: '' },
      adapter,
      ctx: { cwd: '/tmp', model: undefined, modelRegistry: { find: () => undefined, authStorage: null } },
    });

    expect(out).toBe(body);
  });
});

// ──────────────────────────────────────────────────────────────────────
// extractFindingSourceUrls
// ──────────────────────────────────────────────────────────────────────

describe('extractFindingSourceUrls', () => {
  test('returns URLs in document order from a valid ## Sources block', () => {
    const body = [
      '# Sub-question: demo',
      '',
      '## Findings',
      '- claim [S1]',
      '',
      '## Sources',
      '- [S1] https://example.com/a - first',
      '- [S2] https://example.com/b - second',
      '',
      '## Open questions',
      '- None.',
    ].join('\n');

    expect(extractFindingSourceUrls(body)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  test('returns [] when the ## Sources section is missing', () => {
    const body = '# Sub-question: demo\n\n## Findings\n- nothing.\n';

    expect(extractFindingSourceUrls(body)).toEqual([]);
  });

  test('returns [] when ## Sources is empty', () => {
    const body = '# Sub-question: demo\n\n## Findings\n- x\n\n## Sources\n\n## Open questions\n- None.\n';

    expect(extractFindingSourceUrls(body)).toEqual([]);
  });

  test('stops scanning at the next ## heading', () => {
    const body = [
      '## Sources',
      '- [S1] https://example.com/a - first',
      '## Open questions',
      '- [S99] https://evil.example - not-a-source',
    ].join('\n');

    expect(extractFindingSourceUrls(body)).toEqual(['https://example.com/a']);
  });

  test('skips lines that do not match the schema', () => {
    const body = [
      '## Sources',
      '  free-form preamble',
      '- not a source line',
      '- [S1] https://example.com/a - desc',
      '- [bad] https://nope.example - garbage',
    ].join('\n');

    expect(extractFindingSourceUrls(body)).toEqual(['https://example.com/a']);
  });

  test('accepts source lines without trailing description', () => {
    const body = '## Sources\n- [S1] https://example.com/a\n';

    expect(extractFindingSourceUrls(body)).toEqual(['https://example.com/a']);
  });
});
