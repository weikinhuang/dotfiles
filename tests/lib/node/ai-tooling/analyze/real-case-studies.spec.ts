import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, test } from 'vitest';

import { piToNormalized, type PiEntry } from '../../../../../lib/node/ai-tooling/adapters/pi-adapter.ts';
import { runDetectors, type Finding } from '../../../../../lib/node/ai-tooling/analyze/detectors.ts';
import { readJsonlLines } from '../../../../../lib/node/ai-tooling/jsonl.ts';
import { sessionCostTotals } from '../../../../../lib/node/ai-tooling/analyze/turn-model.ts';

// End-to-end ground-truth validation against the two real pi case-study
// sessions from the handoff plan. These files live only on the original
// machine (they are large and contain private content, so they are NOT
// committed); the suite skips cleanly when they are absent (CI / Docker).
//
// A passing run here is the "done" bar from the plan §8.3: the detectors must
// flag the right turn ranges and dollars on the poisoned and mixed sessions,
// and must NOT false-positive on the healthy stretches.

const HOME = process.env.HOME ?? '';
const POISONED = path.join(
  HOME,
  '.pi/agent/sessions/--home-whuang-code-git.example.com-cluster-home-cluster-home--',
  '2026-06-25T23-07-21-509Z_019f0109-b625-714e-bd1f-e9ac1a0de902.jsonl',
);
const MIXED = path.join(
  HOME,
  '.pi/agent/sessions/--home-whuang-code-dotfiles--',
  '2026-06-26T02-17-22-617Z_019f01b7-adb9-7f62-b47a-f6da15c7fd58.jsonl',
);

function analyze(file: string): { findings: Finding[]; totalCost: number; turns: number } {
  const session = piToNormalized(readJsonlLines<PiEntry>(file), 'case-study');
  return {
    findings: runDetectors(session),
    totalCost: sessionCostTotals(session).total,
    turns: session.turns.length,
  };
}

function findingFor(findings: Finding[], id: Finding['detector']): Finding[] {
  return findings.filter((f) => f.detector === id);
}

const describePoisoned = fs.existsSync(POISONED) ? describe : describe.skip;
const describeMixed = fs.existsSync(MIXED) ? describe : describe.skip;

describePoisoned('real case study: 019f0109 (poisoned, ~$32)', () => {
  test('session totals match the observed $32 explosion', () => {
    const { totalCost, turns } = analyze(POISONED);
    expect(turns).toBe(56);
    expect(totalCost).toBeGreaterThan(31);
    expect(totalCost).toBeLessThan(33);
  });

  test('cache-poisoning flags the frozen-prefix stretch (turns 16-55, most of the spend)', () => {
    const poison = findingFor(analyze(POISONED).findings, 'cache-poisoning');
    expect(poison).toHaveLength(1);
    expect(poison[0].range.startIndex).toBe(16);
    expect(poison[0].range.endIndex).toBe(55);
    expect(poison[0].severity).toBe('critical');
    expect(poison[0].dollarsAttributed).toBeGreaterThan(25);
  });

  test('cache-write-dominant fires at ~90% write share', () => {
    const wd = findingFor(analyze(POISONED).findings, 'cache-write-dominant');
    expect(wd).toHaveLength(1);
    expect(wd[0].dollarsAttributed).toBeGreaterThan(28);
  });

  test('does NOT poison-flag the healthy opening turns (0-9)', () => {
    const poison = findingFor(analyze(POISONED).findings, 'cache-poisoning');
    expect(poison.every((f) => f.range.startIndex >= 16)).toBe(true);
  });
});

describeMixed('real case study: 019f01b7 (mixed: healthy + poison + TTL + large-context)', () => {
  test('cache-poisoning flags exactly the poisoned run (turns 59-87, ~$25)', () => {
    const poison = findingFor(analyze(MIXED).findings, 'cache-poisoning');
    expect(poison).toHaveLength(1);
    expect(poison[0].range.startIndex).toBe(59);
    expect(poison[0].range.endIndex).toBe(87);
    expect(poison[0].dollarsAttributed).toBeGreaterThan(24);
    expect(poison[0].dollarsAttributed).toBeLessThan(27);
  });

  test('cache-write-dominant does NOT fire (session is mixed at ~65% write share)', () => {
    expect(findingFor(analyze(MIXED).findings, 'cache-write-dominant')).toHaveLength(0);
  });

  test('ttl-expiry flags the idle-gap re-writes including the overnight resume', () => {
    const ttl = findingFor(analyze(MIXED).findings, 'ttl-expiry');
    const idx = ttl.map((f) => f.range.startIndex);
    expect(idx).toContain(33); // 22m gap
    expect(idx).toContain(105); // overnight resume
    // The overnight resume re-wrote a 222k-token context for over a dollar.
    const overnight = ttl.find((f) => f.range.startIndex === 105)!;
    expect(overnight.dollarsAttributed).toBeGreaterThan(1);
  });

  test('does NOT flag a within-TTL cacheRead drop (turn 89, ~81s gap content mutation) as TTL', () => {
    const ttl = findingFor(analyze(MIXED).findings, 'ttl-expiry');
    expect(ttl.every((f) => f.range.startIndex !== 89)).toBe(true);
  });

  test('cache-bust flags the within-TTL mid-session bust (turn 89) that ttl-expiry skips', () => {
    const bust = findingFor(analyze(MIXED).findings, 'cache-bust');
    const idx = bust.map((f) => f.range.startIndex);
    expect(idx).toContain(89);
    const t89 = bust.find((f) => f.range.startIndex === 89)!;
    expect(t89.dollarsAttributed).toBeGreaterThan(1);
  });

  test('large-context-carry surfaces the expensive late-session context tail', () => {
    const lcc = findingFor(analyze(MIXED).findings, 'large-context-carry');
    expect(lcc.length).toBeGreaterThan(0);
    const biggest = lcc.reduce((a, b) => (b.dollarsAttributed > a.dollarsAttributed ? b : a));
    expect(biggest.dollarsAttributed).toBeGreaterThan(5);
  });
});
