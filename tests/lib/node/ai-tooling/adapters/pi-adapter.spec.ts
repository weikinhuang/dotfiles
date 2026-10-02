import { expect, test } from 'vitest';

import { piToNormalized } from '../../../../../lib/node/ai-tooling/adapters/pi-adapter.ts';
import { runDetectors } from '../../../../../lib/node/ai-tooling/analyze/detectors.ts';
import { renderReport } from '../../../../../lib/node/ai-tooling/analyze/report.ts';
import { piCacheIncident } from '../../../../fixtures/pi-cache-incident.ts';

test('Azure incident retains real cache writes and produces critical range-attributed diagnoses', () => {
  const session = piToNormalized(piCacheIncident(), 'sanitized-01a0fd44');
  expect(session.turns[28].cachingModel).toBe('openai');
  expect(session.turns[28].tokens.cacheWriteInput).toBe(86410);
  expect(session.turns[28].cost?.cacheWrite).toBeCloseTo(0.43205);
  const findings = runDetectors(session);
  expect(findings).toContainEqual(expect.objectContaining({ detector: 'cache-write-dominant', severity: 'critical' }));
  const plateau = findings.find((finding) => finding.detector === 'cache-poisoning' && finding.range.startIndex === 8);
  expect(plateau?.explanation).toContain('64k');
  const expectedWrites = session.turns.slice(8, 28).reduce((sum, turn) => sum + (turn.cost?.cacheWrite ?? 0), 0);
  expect(plateau?.dollarsAttributed).toBeCloseTo(expectedWrites);
  const collapse = findings.find((finding) => finding.detector === 'cache-bust' && finding.range.startIndex === 28);
  expect(collapse?.explanation).toContain('64k to 17k');
  const report = renderReport(session, findings, { turns: true });
  expect(report).not.toContain('no cost/caching pathologies detected');
  expect(report).toContain('rewritten tokens');
  expect(session.costNeedsBackfill).toBe(false);
});
