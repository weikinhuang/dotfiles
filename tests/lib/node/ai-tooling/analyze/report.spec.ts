import { describe, expect, test } from 'vitest';

import { type Finding } from '../../../../../lib/node/ai-tooling/analyze/detectors.ts';
import { renderReport, reportJson } from '../../../../../lib/node/ai-tooling/analyze/report.ts';
import {
  emptyTurnTokens,
  type NormalizedSession,
  type NormalizedTurn,
} from '../../../../../lib/node/ai-tooling/analyze/turn-model.ts';
import { setColorEnabled } from '../../../../../lib/node/ai-tooling/format.ts';

setColorEnabled(false); // deterministic, ANSI-free assertions

function mkTurn(index: number, cacheRead: number, cacheWrite: number): NormalizedTurn {
  const tokens = {
    ...emptyTurnTokens(),
    input: 2,
    output: 100,
    cacheReadInput: cacheRead,
    cacheWriteInput: cacheWrite,
  };
  return {
    index,
    timestamp: new Date(Date.UTC(2026, 5, 26) + index * 1000).toISOString(),
    role: 'assistant',
    cachingModel: 'anthropic',
    tokens,
    cost: {
      input: 0,
      output: 0.001,
      cacheRead: cacheRead * 1e-7,
      cacheWrite: cacheWrite * 1.25e-6,
      total: 0.001 + cacheRead * 1e-7 + cacheWrite * 1.25e-6,
    },
  };
}

function mkSession(turns: NormalizedTurn[]): NormalizedSession {
  return {
    harness: 'pi',
    sessionId: '019f0109',
    model: 'claude-opus-4-8',
    startTime: turns[0].timestamp,
    endTime: turns[turns.length - 1].timestamp,
    turns,
    costNeedsBackfill: false,
  };
}

const FINDING: Finding = {
  detector: 'cache-poisoning',
  severity: 'critical',
  range: { startIndex: 16, endIndex: 55, turnCount: 40, startTime: 'a', endTime: 'b' },
  dollarsAttributed: 27.98,
  explanation: 'cacheRead frozen at ~39k tokens across 40 turns',
  remediation: 'move volatile content off the cache breakpoint',
};

describe('renderReport', () => {
  test('shows header, cost split, and write share', () => {
    const out = renderReport(mkSession([mkTurn(0, 0, 30000), mkTurn(1, 30000, 500)]), []);
    expect(out).toContain('session-doctor: pi 019f0109');
    expect(out).toContain('claude-opus-4-8');
    expect(out).toContain('total');
    expect(out).toContain('cacheWrite');
    expect(out).toContain('write share');
  });

  test('prints a healthy banner when there are no findings', () => {
    const out = renderReport(mkSession([mkTurn(0, 0, 30000)]), []);
    expect(out).toContain('no cost/caching pathologies detected');
  });

  test('renders a findings section with range, dollars, and remediation', () => {
    const out = renderReport(mkSession([mkTurn(0, 0, 30000)]), [FINDING]);
    expect(out).toContain('Findings (1');
    expect(out).toContain('cache-poisoning');
    expect(out).toContain('turns 16-55');
    expect(out).toContain('$27.98');
    expect(out).toContain('move volatile content off the cache breakpoint');
  });

  test('a single-turn finding renders as "turn N"', () => {
    const ttl: Finding = { ...FINDING, detector: 'ttl-expiry', range: { startIndex: 33, endIndex: 33, turnCount: 1 } };
    const out = renderReport(mkSession([mkTurn(0, 0, 30000)]), [ttl]);
    expect(out).toContain('turn 33');
    expect(out).not.toContain('turns 33-33');
  });

  test('annotates model changes with a section and a per-turn tag', () => {
    const t0 = mkTurn(0, 0, 30000);
    const t1 = mkTurn(1, 30000, 500);
    t0.model = 'us.anthropic.claude-opus-4-8';
    t1.model = 'claude-haiku-4-5';
    const out = renderReport(mkSession([t0, t1]), [], { turns: true });
    expect(out).toContain('Model changes (1)');
    // provider prefix stripped for the compact label
    expect(out).toContain('claude-opus-4-8 → claude-haiku-4-5');
    expect(out).toContain('turn 1');
    // the switch turn is tagged in the per-turn table
    expect(out).toContain('[→claude-haiku-4-5]');
  });
});

describe('reportJson', () => {
  test('serializes totals, write share, and findings', () => {
    const json = reportJson(mkSession([mkTurn(0, 0, 30000), mkTurn(1, 30000, 500)]), [FINDING]);
    expect(json.harness).toBe('pi');
    expect(json.sessionId).toBe('019f0109');
    expect(json.turns).toBe(2);
    expect(json.cost.total).toBeGreaterThan(0);
    expect(json.writeShare).toBeGreaterThan(0);
    expect(json.findings).toHaveLength(1);
    expect(json.findings[0]).toMatchObject({
      detector: 'cache-poisoning',
      startIndex: 16,
      endIndex: 55,
      dollarsAttributed: 27.98,
    });
  });

  test('omits perTurn unless requested', () => {
    const json = reportJson(mkSession([mkTurn(0, 0, 30000)]), []);
    expect(json.perTurn).toBeUndefined();
  });

  test('includes the per-turn series when includeTurns is set', () => {
    const json = reportJson(mkSession([mkTurn(0, 0, 30000), mkTurn(1, 30000, 500)]), [], true);
    expect(json.perTurn).toHaveLength(2);
    expect(json.perTurn![0]).toMatchObject({ index: 0, contextTokens: 30002 });
    expect(json.perTurn![0].tokens.cacheWriteInput).toBe(30000);
  });
});

describe('renderReport --turns', () => {
  test('appends a per-turn table with a header and a row per turn', () => {
    const out = renderReport(mkSession([mkTurn(0, 0, 30000), mkTurn(1, 30000, 500)]), [], { turns: true });
    expect(out).toContain('Per-turn');
    expect(out).toContain('cacheR');
    expect(out).toContain('ctx');
    // a data row for turn 0 and turn 1
    expect(out).toMatch(/\n\s+0 /);
    expect(out).toMatch(/\n\s+1 /);
  });

  test('tags turns inside a localized finding range (poison)', () => {
    const turns = Array.from({ length: 4 }, (_, i) => mkTurn(i, 40000, 100000));
    const poison: Finding = {
      ...FINDING,
      range: { startIndex: 1, endIndex: 2, turnCount: 2 },
    };
    const out = renderReport(mkSession(turns), [poison], { turns: true });
    const rows = out.split('\n').filter((l) => /^\s+\d+ /.test(l));
    expect(rows[1]).toContain('poison');
    expect(rows[2]).toContain('poison');
    expect(rows[0]).not.toContain('poison');
  });

  test('does not tag turns with the session-wide cache-write-dominant lens', () => {
    const wd: Finding = {
      ...FINDING,
      detector: 'cache-write-dominant',
      range: { startIndex: 0, endIndex: 1, turnCount: 2 },
    };
    const out = renderReport(mkSession([mkTurn(0, 0, 30000), mkTurn(1, 30000, 500)]), [wd], { turns: true });
    expect(out).not.toContain('cache-write-dominant\n'); // not as a per-turn tag
    const rows = out.split('\n').filter((l) => /^\s+\d+ /.test(l));
    expect(rows.every((r) => !r.includes('write-dom'))).toBe(true);
  });
});
