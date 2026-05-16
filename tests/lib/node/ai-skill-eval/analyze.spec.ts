// Tests for lib/node/ai-skill-eval/analyze.ts - the R5.2 post-hoc analyzer.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  analysisReportPath,
  analyzeRecordPath,
  buildAnalyzerPrompt,
  extractSkillBodyFromPrompt,
  loadAnalyzerTemplate,
  loadCompareRecords,
  parseAnalyzerVerdict,
  promptFilePath,
  renderAnalysisMarkdown,
  runAnalyze,
  setAnalyzerTemplateForTest,
  type AnalyzeRecord,
  type CriticInvoker,
  type RunAnalyzeResult,
} from '../../../../lib/node/ai-skill-eval/analyze.ts';
import { compareOutputDir, compareRecordPath, type CompareRecord } from '../../../../lib/node/ai-skill-eval/compare.ts';
import { iterationPath } from '../../../../lib/node/ai-skill-eval/workspace.ts';

/** Write `body` to `<iter>/with_skill/prompts/<evalId>.txt` wrapped in the SKILL markers buildEvalPrompt emits. */
function seedPrompt(workspace: string, skill: string, iteration: number, evalId: string, skillBody: string): string {
  const path = promptFilePath(workspace, skill, iteration, evalId);
  mkdirSync(join(path, '..'), { recursive: true });
  const contents = [
    'You are an AI coding assistant...',
    '',
    '===== SKILL =====',
    skillBody,
    '===== END SKILL =====',
    '',
    `Scenario: (eval ${evalId})`,
  ].join('\n');
  writeFileSync(path, contents);
  return path;
}

/** Write a reply transcript to `<iter>/with_skill/results/<evalId>/run-1.txt`. */
function seedReply(workspace: string, skill: string, iteration: number, evalId: string, body: string): string {
  const dir = join(iterationPath(workspace, skill, iteration), 'with_skill', 'results', evalId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'run-1.txt');
  writeFileSync(path, body);
  return path;
}

/** Seed a compare record on disk at the R5.1 path so loadCompareRecords can find it. */
function seedCompareRecord(workspace: string, record: CompareRecord): string {
  const path = compareRecordPath(workspace, record.skill, record.iteration_a, record.iteration_b, record.eval_id);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

describe('loadAnalyzerTemplate', () => {
  afterEach(() => setAnalyzerTemplateForTest(null));

  test('reads the shipped prompts/analyzer.md and caches it', () => {
    setAnalyzerTemplateForTest(null);
    const a = loadAnalyzerTemplate();
    const b = loadAnalyzerTemplate();

    expect(a).toBe(b);
    expect(a).toContain('Post-hoc Analyzer');
    expect(a).toContain('improvement_suggestions');
  });

  test('setAnalyzerTemplateForTest overrides and resets the cache', () => {
    setAnalyzerTemplateForTest('STUB');

    expect(loadAnalyzerTemplate()).toBe('STUB');

    setAnalyzerTemplateForTest(null);

    expect(loadAnalyzerTemplate()).toContain('Post-hoc Analyzer');
  });
});

describe('extractSkillBodyFromPrompt', () => {
  test('extracts the SKILL body between the buildEvalPrompt markers', () => {
    const prompt = [
      'You are an AI...',
      '',
      '===== SKILL =====',
      'skill line 1',
      'skill line 2',
      '===== END SKILL =====',
      '',
      'Scenario: go',
    ].join('\n');

    expect(extractSkillBodyFromPrompt(prompt)).toBe('skill line 1\nskill line 2');
  });

  test('falls back to the whole file when markers are missing', () => {
    const prompt = 'no markers here';

    expect(extractSkillBodyFromPrompt(prompt)).toBe(prompt);
  });
});

describe('buildAnalyzerPrompt', () => {
  afterEach(() => setAnalyzerTemplateForTest(null));

  test('inlines both skills + transcripts and names every path', () => {
    const prompt = buildAnalyzerPrompt(
      {
        skill: 'my-skill',
        evalId: 'positive-1',
        evalPrompt: 'scenario text',
        expectations: ['first expectation', 'second expectation'],
        winnerIteration: 2,
        loserIteration: 1,
        winnerLabel: 'A',
        comparatorReason: 'A is clearer',
        winnerSkillPath: '/w/skill-w.md',
        loserSkillPath: '/w/skill-l.md',
        winnerSkillBody: 'WIN-BODY',
        loserSkillBody: 'LOSE-BODY',
        winnerTranscriptPath: '/w/reply-w.txt',
        loserTranscriptPath: '/w/reply-l.txt',
        winnerTranscript: 'WIN-TRANSCRIPT',
        loserTranscript: 'LOSE-TRANSCRIPT',
      },
      'RUBRIC-STUB',
    );

    expect(prompt).toContain('RUBRIC-STUB');
    expect(prompt).toContain('Skill: my-skill');
    expect(prompt).toContain('Eval:  positive-1');
    expect(prompt).toContain('Winner: iteration-2 (blind label A)');
    expect(prompt).toContain('Loser:  iteration-1');
    expect(prompt).toContain('winner_skill_path: /w/skill-w.md');
    expect(prompt).toContain('loser_skill_path: /w/skill-l.md');
    expect(prompt).toContain('winner_transcript_path: /w/reply-w.txt');
    expect(prompt).toContain('loser_transcript_path: /w/reply-l.txt');
    expect(prompt).toContain('A is clearer');
    expect(prompt).toContain('scenario text');
    expect(prompt).toContain('1. first expectation');
    expect(prompt).toContain('2. second expectation');
    expect(prompt).toContain('winner_skill (iteration-2)');
    expect(prompt).toContain('loser_skill (iteration-1)');
    expect(prompt).toContain('WIN-BODY');
    expect(prompt).toContain('LOSE-BODY');
    expect(prompt).toContain('WIN-TRANSCRIPT');
    expect(prompt).toContain('LOSE-TRANSCRIPT');
    expect(prompt).toContain('STRICT JSON');
    expect(prompt).toContain('improvement_suggestions');
  });

  test('renders a placeholder when expectations[] is empty', () => {
    const prompt = buildAnalyzerPrompt(
      {
        skill: 's',
        evalId: 'e',
        evalPrompt: 'p',
        expectations: [],
        winnerIteration: 1,
        loserIteration: 2,
        winnerLabel: 'B',
        comparatorReason: '',
        winnerSkillPath: '/w',
        loserSkillPath: '/l',
        winnerSkillBody: 'W',
        loserSkillBody: 'L',
        winnerTranscriptPath: '/wt',
        loserTranscriptPath: '/lt',
        winnerTranscript: 'WT',
        loserTranscript: 'LT',
      },
      'RUBRIC',
    );

    expect(prompt).toContain('(none - judge on content + structure only)');
  });
});

describe('parseAnalyzerVerdict', () => {
  test('parses a full verdict with optional sections', () => {
    const raw = JSON.stringify({
      comparison_summary: { winner_iteration: 2, loser_iteration: 1, comparator_reasoning: 'A wins' },
      winner_strengths: ['clear', 'specific'],
      loser_weaknesses: ['vague'],
      improvement_suggestions: [
        {
          priority: 'high',
          category: 'instructions',
          suggestion: 'add step-by-step',
          expected_impact: 'reduce ambiguity',
        },
        { priority: 'LOW', category: 'tools', suggestion: 'add validator', expected_impact: '' },
      ],
      instruction_following: {
        winner: { score: 9, issues: ['minor'] },
        loser: { score: 6, issues: ['missed step 3', 'ignored template'] },
      },
      transcript_insights: {
        winner_execution_pattern: 'read -> exec -> validate',
        loser_execution_pattern: 'read -> improvise',
      },
    });

    const v = parseAnalyzerVerdict(`chatter ${raw} post`);

    expect(v.comparison_summary).toEqual({ winner_iteration: 2, loser_iteration: 1, comparator_reasoning: 'A wins' });
    expect(v.winner_strengths).toEqual(['clear', 'specific']);
    expect(v.loser_weaknesses).toEqual(['vague']);
    expect(v.improvement_suggestions).toHaveLength(2);
    expect(v.improvement_suggestions[0]).toMatchObject({
      priority: 'high',
      category: 'instructions',
      suggestion: 'add step-by-step',
    });
    // Case-insensitive priority coercion.
    expect(v.improvement_suggestions[1]?.priority).toBe('low');
    expect(v.instruction_following?.winner?.score).toBe(9);
    expect(v.instruction_following?.loser?.issues).toEqual(['missed step 3', 'ignored template']);
    expect(v.transcript_insights?.winner_execution_pattern).toBe('read -> exec -> validate');
  });

  test('omits optional sections when absent and survives unknown priorities', () => {
    const raw = JSON.stringify({
      winner_strengths: ['a'],
      loser_weaknesses: ['b'],
      improvement_suggestions: [{ priority: 'moderate', category: 'x', suggestion: 'do x', expected_impact: 'y' }],
    });
    const v = parseAnalyzerVerdict(raw);

    expect(v.improvement_suggestions[0]?.priority).toBe('medium');
    expect(v.instruction_following).toBeUndefined();
    expect(v.transcript_insights).toBeUndefined();
    expect(v.comparison_summary.winner_iteration).toBeNull();
  });

  test('skips suggestions with no text and filters blank strengths', () => {
    const raw = JSON.stringify({
      winner_strengths: ['keep', '', '  '],
      loser_weaknesses: ['one'],
      improvement_suggestions: [
        { priority: 'high', suggestion: '', expected_impact: 'nope' },
        { priority: 'high', suggestion: 'real change', category: 'tools' },
      ],
    });
    const v = parseAnalyzerVerdict(raw);

    expect(v.winner_strengths).toEqual(['keep']);
    expect(v.improvement_suggestions).toHaveLength(1);
    expect(v.improvement_suggestions[0]?.suggestion).toBe('real change');
    expect(v.improvement_suggestions[0]?.expected_impact).toBe('');
  });

  test('throws on missing JSON / malformed required fields', () => {
    expect(() => parseAnalyzerVerdict('no json here')).toThrow('did not contain a JSON object');
    expect(() =>
      parseAnalyzerVerdict(
        JSON.stringify({ winner_strengths: 'not-an-array', loser_weaknesses: [], improvement_suggestions: [] }),
      ),
    ).toThrow(/winner_strengths/);
  });
});

describe('loadCompareRecords', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ai-skill-eval-analyze-load-'));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  test('throws when the compare directory does not exist', () => {
    expect(() => loadCompareRecords(ws, 'missing', 1, 2)).toThrow(/no compare output/);
  });

  test('reads every compare-*.json, ignores malformed / mismatched siblings', () => {
    const dir = compareOutputDir(ws, 's', 1, 2);
    mkdirSync(dir, { recursive: true });
    seedCompareRecord(ws, {
      skill: 's',
      eval_id: 'b-second',
      iteration_a: 1,
      iteration_b: 2,
      label_mapping: { A: 1, B: 2 },
      output_a_path: '/a',
      output_b_path: '/b',
      winner_label: 'A',
      winner_iteration: 1,
      reason: 'B wins',
      raw_verdict: {},
    });
    seedCompareRecord(ws, {
      skill: 's',
      eval_id: 'a-first',
      iteration_a: 1,
      iteration_b: 2,
      label_mapping: { A: 1, B: 2 },
      output_a_path: '/a',
      output_b_path: '/b',
      winner_label: 'tie',
      winner_iteration: null,
      reason: '',
      raw_verdict: {},
    });
    // Distractors that loadCompareRecords should skip.
    writeFileSync(join(dir, 'compare-bad.json'), '{not json');
    writeFileSync(join(dir, 'compare-shape.json'), JSON.stringify({ skill: 's' }));
    writeFileSync(join(dir, 'summary.json'), '{}');

    const records = loadCompareRecords(ws, 's', 1, 2);

    expect(records.map((r) => r.eval_id)).toEqual(['a-first', 'b-second']);
  });
});

describe('runAnalyze', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ai-skill-eval-analyze-run-'));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
    setAnalyzerTemplateForTest(null);
  });

  test('analyzes decided records, persists JSON + analysis.md, unblinds sides', () => {
    // iteration-1 loses, iteration-2 wins for e1. Winner_label 'A' means
    // output_a_path is the winner's transcript.
    const winnerReply = seedReply(ws, 's', 2, 'e1', 'WIN-REPLY');
    const loserReply = seedReply(ws, 's', 1, 'e1', 'LOSE-REPLY');
    seedPrompt(ws, 's', 2, 'e1', 'iteration-2 SKILL body');
    seedPrompt(ws, 's', 1, 'e1', 'iteration-1 SKILL body');

    seedCompareRecord(ws, {
      skill: 's',
      eval_id: 'e1',
      iteration_a: 1,
      iteration_b: 2,
      label_mapping: { A: 2, B: 1 },
      output_a_path: winnerReply,
      output_b_path: loserReply,
      winner_label: 'A',
      winner_iteration: 2,
      reason: 'A is clearer\nand more complete',
      raw_verdict: {},
    });
    // Tie - should be reported under `skipped`.
    seedCompareRecord(ws, {
      skill: 's',
      eval_id: 'tied',
      iteration_a: 1,
      iteration_b: 2,
      label_mapping: { A: 1, B: 2 },
      output_a_path: '/does/not/matter',
      output_b_path: '/does/not/matter',
      winner_label: 'tie',
      winner_iteration: null,
      reason: 'equal',
      raw_verdict: {},
    });

    const seenPrompts: string[] = [];
    const critic: CriticInvoker = (_cmd, promptFile, outputFile) => {
      seenPrompts.push(readFileSync(promptFile, 'utf8'));
      const stdout = JSON.stringify({
        comparison_summary: {
          winner_iteration: 2,
          loser_iteration: 1,
          comparator_reasoning: 'A more specific',
        },
        winner_strengths: ['explicit steps'],
        loser_weaknesses: ['vague WHEN clause'],
        improvement_suggestions: [
          {
            priority: 'high',
            category: 'instructions',
            suggestion: 'replace \u201cas needed\u201d with a numbered list',
            expected_impact: 'removes ambiguity',
          },
        ],
      });
      writeFileSync(outputFile, stdout);
      return { exitCode: 0, stdout };
    };

    const result = runAnalyze({
      workspace: ws,
      skill: 's',
      iterationA: 1,
      iterationB: 2,
      criticCmd: ':',
      evals: [
        { id: 'e1', prompt: 'scenario-1', expectations: ['e-exp'] },
        { id: 'tied', prompt: 'scenario-t', expectations: [] },
      ],
      critic,
      template: 'RUBRIC-STUB',
    });

    expect(result.records).toHaveLength(1);
    expect(result.skipped.map((s) => s.eval_id)).toEqual(['tied']);
    expect(result.errors).toEqual([]);

    const rec = result.records[0];

    expect(rec.winner_iteration).toBe(2);
    expect(rec.loser_iteration).toBe(1);
    expect(rec.winner_transcript_path).toBe(winnerReply);
    expect(rec.loser_transcript_path).toBe(loserReply);
    expect(rec.verdict.winner_strengths).toEqual(['explicit steps']);
    expect(rec.verdict.improvement_suggestions[0]?.priority).toBe('high');

    // Prompt delivered to the critic sees the unblinded winner/loser skills.
    expect(seenPrompts[0]).toContain('iteration-2 SKILL body');
    expect(seenPrompts[0]).toContain('iteration-1 SKILL body');
    expect(seenPrompts[0]).toContain('Winner: iteration-2 (blind label A)');

    // Per-eval JSON persisted.
    const jsonPath = analyzeRecordPath(ws, 's', 1, 2, 'e1');
    const disk = JSON.parse(readFileSync(jsonPath, 'utf8')) as AnalyzeRecord;

    expect(disk.winner_iteration).toBe(2);
    expect(disk.verdict.loser_weaknesses).toEqual(['vague WHEN clause']);

    // Combined markdown report landed next to the JSON records.
    const md = readFileSync(analysisReportPath(ws, 's', 1, 2), 'utf8');

    expect(md).toContain('analyze s: iteration-1 vs iteration-2');
    expect(md).toContain('winner iteration-2, loser iteration-1');
    expect(md).toContain('replace \u201cas needed\u201d with a numbered list');
    expect(md).toContain('skipped (ties): 1');
  });

  test('missing prompt / reply files surface as errors; critic exit + JSON errors are isolated', () => {
    // Both iterations have prompts+replies for bad-exit and bad-json, but
    // missing-skill-iter-1 has no iteration-1 prompt → error.
    seedPrompt(ws, 's', 2, 'missing-skill-iter-1', 'iter-2 body');
    const winTrans = seedReply(ws, 's', 2, 'missing-skill-iter-1', 'w');
    const loseTrans = seedReply(ws, 's', 1, 'missing-skill-iter-1', 'l');
    seedCompareRecord(ws, {
      skill: 's',
      eval_id: 'missing-skill-iter-1',
      iteration_a: 1,
      iteration_b: 2,
      label_mapping: { A: 2, B: 1 },
      output_a_path: winTrans,
      output_b_path: loseTrans,
      winner_label: 'A',
      winner_iteration: 2,
      reason: 'w',
      raw_verdict: {},
    });

    seedPrompt(ws, 's', 2, 'bad-exit', 'wb');
    seedPrompt(ws, 's', 1, 'bad-exit', 'lb');
    const we1 = seedReply(ws, 's', 2, 'bad-exit', 'w');
    const le1 = seedReply(ws, 's', 1, 'bad-exit', 'l');
    seedCompareRecord(ws, {
      skill: 's',
      eval_id: 'bad-exit',
      iteration_a: 1,
      iteration_b: 2,
      label_mapping: { A: 2, B: 1 },
      output_a_path: we1,
      output_b_path: le1,
      winner_label: 'A',
      winner_iteration: 2,
      reason: 'w',
      raw_verdict: {},
    });

    seedPrompt(ws, 's', 2, 'bad-json', 'wj');
    seedPrompt(ws, 's', 1, 'bad-json', 'lj');
    const we2 = seedReply(ws, 's', 2, 'bad-json', 'w');
    const le2 = seedReply(ws, 's', 1, 'bad-json', 'l');
    seedCompareRecord(ws, {
      skill: 's',
      eval_id: 'bad-json',
      iteration_a: 1,
      iteration_b: 2,
      label_mapping: { A: 2, B: 1 },
      output_a_path: we2,
      output_b_path: le2,
      winner_label: 'A',
      winner_iteration: 2,
      reason: 'w',
      raw_verdict: {},
    });

    const critic: CriticInvoker = (_cmd, promptFile, outputFile) => {
      if (promptFile.includes('bad-exit')) {
        writeFileSync(outputFile, '');
        return { exitCode: 1, stdout: '' };
      }
      // bad-json: plausible exit, unparseable stdout.
      writeFileSync(outputFile, 'no json here');
      return { exitCode: 0, stdout: 'no json here' };
    };

    const result = runAnalyze({
      workspace: ws,
      skill: 's',
      iterationA: 1,
      iterationB: 2,
      criticCmd: ':',
      evals: [
        { id: 'missing-skill-iter-1', prompt: 'p', expectations: [] },
        { id: 'bad-exit', prompt: 'p', expectations: [] },
        { id: 'bad-json', prompt: 'p', expectations: [] },
      ],
      critic,
      template: 'RUBRIC',
    });

    expect(result.records).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors.map((e) => e.eval_id).sort()).toEqual(['bad-exit', 'bad-json', 'missing-skill-iter-1']);
    expect(result.errors.find((e) => e.eval_id === 'missing-skill-iter-1')?.reason).toMatch(/failed to read/);
    expect(result.errors.find((e) => e.eval_id === 'bad-exit')?.reason).toMatch(/critic exit 1/);
    expect(result.errors.find((e) => e.eval_id === 'bad-json')?.reason).toMatch(/did not contain a JSON object/);
  });

  test('honours `only` filter and skips evals missing from evals.json', () => {
    for (const id of ['keep', 'filter-out']) {
      seedPrompt(ws, 's', 2, id, 'w');
      seedPrompt(ws, 's', 1, id, 'l');
      const w = seedReply(ws, 's', 2, id, 'wr');
      const l = seedReply(ws, 's', 1, id, 'lr');
      seedCompareRecord(ws, {
        skill: 's',
        eval_id: id,
        iteration_a: 1,
        iteration_b: 2,
        label_mapping: { A: 2, B: 1 },
        output_a_path: w,
        output_b_path: l,
        winner_label: 'A',
        winner_iteration: 2,
        reason: '',
        raw_verdict: {},
      });
    }
    // Orphan record whose eval isn't in evals.json.
    seedPrompt(ws, 's', 2, 'orphan', 'w');
    seedPrompt(ws, 's', 1, 'orphan', 'l');
    const ow = seedReply(ws, 's', 2, 'orphan', 'wr');
    const ol = seedReply(ws, 's', 1, 'orphan', 'lr');
    seedCompareRecord(ws, {
      skill: 's',
      eval_id: 'orphan',
      iteration_a: 1,
      iteration_b: 2,
      label_mapping: { A: 2, B: 1 },
      output_a_path: ow,
      output_b_path: ol,
      winner_label: 'A',
      winner_iteration: 2,
      reason: '',
      raw_verdict: {},
    });

    const critic: CriticInvoker = (_cmd, _p, outputFile) => {
      const stdout = JSON.stringify({
        winner_strengths: ['ok'],
        loser_weaknesses: ['meh'],
        improvement_suggestions: [
          { priority: 'low', category: 'instructions', suggestion: 'tweak', expected_impact: '' },
        ],
      });
      writeFileSync(outputFile, stdout);
      return { exitCode: 0, stdout };
    };

    const result = runAnalyze({
      workspace: ws,
      skill: 's',
      iterationA: 1,
      iterationB: 2,
      criticCmd: ':',
      evals: [
        { id: 'keep', prompt: 'p', expectations: [] },
        { id: 'filter-out', prompt: 'p', expectations: [] },
      ],
      only: ['keep'],
      critic,
      template: 'RUBRIC',
    });

    expect(result.records.map((r) => r.eval_id)).toEqual(['keep']);
    expect(result.errors).toEqual([]);
  });
});

describe('renderAnalysisMarkdown', () => {
  test('renders per-eval sections with strengths / weaknesses / suggestions', () => {
    const result: RunAnalyzeResult = {
      skill: 's',
      iteration_a: 1,
      iteration_b: 2,
      records: [
        {
          skill: 's',
          eval_id: 'e1',
          iteration_a: 1,
          iteration_b: 2,
          winner_iteration: 2,
          loser_iteration: 1,
          winner_label: 'A',
          winner_skill_path: '/w-skill',
          loser_skill_path: '/l-skill',
          winner_transcript_path: '/w-reply',
          loser_transcript_path: '/l-reply',
          comparator_reason: 'A was clearer\nand more complete',
          verdict: {
            comparison_summary: { winner_iteration: 2, loser_iteration: 1, comparator_reasoning: 'A wins' },
            winner_strengths: ['clear steps', 'example provided'],
            loser_weaknesses: ['vague WHEN'],
            improvement_suggestions: [
              {
                priority: 'high',
                category: 'instructions',
                suggestion: 'replace "as needed" with numbered list',
                expected_impact: 'reduce ambiguity',
              },
              { priority: 'low', category: 'tools', suggestion: 'add linter', expected_impact: '' },
            ],
            transcript_insights: {
              winner_execution_pattern: 'read -> validate',
              loser_execution_pattern: 'read -> guess',
            },
            raw: {},
          },
        },
      ],
      skipped: [{ eval_id: 'tied', reason: 'tie - no loser to analyze' }],
      errors: [{ eval_id: 'broken', reason: 'critic exit 1' }],
    };

    const md = renderAnalysisMarkdown(result);

    expect(md).toContain('# analyze s: iteration-1 vs iteration-2');
    expect(md).toContain('- analyzed: 1');
    expect(md).toContain('- skipped (ties): 1');
    expect(md).toContain('- errors: 1');
    expect(md).toContain('## e1 - winner iteration-2, loser iteration-1');
    expect(md).toContain('> A was clearer and more complete');
    expect(md).toContain('### Winner strengths (iteration-2)');
    expect(md).toContain('- clear steps');
    expect(md).toContain('### Loser weaknesses (iteration-1)');
    expect(md).toContain('- vague WHEN');
    expect(md).toContain('### Suggestions for iteration-1');
    expect(md).toContain(
      '- **[high]** _instructions_ - replace "as needed" with numbered list _(impact: reduce ambiguity)_',
    );
    expect(md).toContain('- **[low]** _tools_ - add linter');
    expect(md).toContain('### Transcript insights');
    expect(md).toContain('- **winner:** read -> validate');
    expect(md).toContain('## skipped');
    expect(md).toContain('- tied: tie - no loser to analyze');
    expect(md).toContain('## errors');
    expect(md).toContain('- broken: critic exit 1');
  });
});
