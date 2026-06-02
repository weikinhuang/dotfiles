/**
 * Validates the bundled `config/pi/iteration-loop-example.json` matches
 * the on-disk `CheckSpec` shape the iteration-loop storage layer accepts
 * (`<cwd>/.pi/checks/<task>.json`), using the same `isCheckSpecShape`
 * guard `readSpec` runs.
 *
 * Lives under `tests/config/pi/extensions/` alongside the other example
 * specs. The guard module is pure - no pi-runtime imports - so it runs
 * in the same vitest pass as the helper specs.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { isCheckSpecShape } from '../../../../lib/node/pi/iteration-loop/guards.ts';
import { resolveBudget } from '../../../../lib/node/pi/iteration-loop/schema.ts';

const EXAMPLE_PATH = resolve(__dirname, '../../../../config/pi/iteration-loop-example.json');

function loadExample(): unknown {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));
}

describe('config/pi/iteration-loop-example.json', () => {
  test('matches the CheckSpec shape', () => {
    expect(isCheckSpecShape(loadExample())).toBe(true);
  });

  test('declares a bash check with a regex pass predicate', () => {
    const spec = loadExample() as { kind: string; spec: { passOn?: string } };
    expect(spec.kind).toBe('bash');
    expect(spec.spec.passOn).toMatch(/^regex:/);
  });

  test('budget overrides resolve over the built-in defaults', () => {
    const spec = loadExample() as Parameters<typeof resolveBudget>[0];
    expect(resolveBudget(spec)).toEqual({ maxIter: 8, maxCostUsd: 0.25, wallClockSeconds: 900 });
  });
});
