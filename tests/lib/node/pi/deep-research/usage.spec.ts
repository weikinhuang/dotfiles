/**
 * Tests for lib/node/pi/deep-research/usage.ts.
 *
 * The `/research` handler, its `--help` path, and the empty-arg
 * path all print `DEEP_RESEARCH_USAGE`. This spec pins the shape
 * the extension relies on (a `Usage:` header plus every sub-form
 * and flag) so an accidental edit that drops a documented flag is
 * caught here rather than at runtime.
 */

import { describe, expect, test } from 'vitest';

import { DEEP_RESEARCH_USAGE } from '../../../../../lib/node/pi/deep-research/usage.ts';

describe('DEEP_RESEARCH_USAGE', () => {
  test('starts with the Usage header', () => {
    expect(DEEP_RESEARCH_USAGE.startsWith('Usage:\n')).toBe(true);
  });

  test('documents the four /research sub-forms', () => {
    expect(DEEP_RESEARCH_USAGE).toContain('/research <question>');
    expect(DEEP_RESEARCH_USAGE).toContain('/research --list');
    expect(DEEP_RESEARCH_USAGE).toContain('/research --selftest');
    expect(DEEP_RESEARCH_USAGE).toContain('/research --resume [flags]');
  });

  test('documents each resume-mode and question-mode flag', () => {
    for (const flag of [
      '--run-root <path>',
      '--from <stage>',
      '--sq <id>[,<id>...]',
      '--model provider/id',
      '--plan-crit-model provider/id',
      '--fanout-model provider/id',
      '--critic-model provider/id',
      '--fanout-max-turns N',
      '--critic-max-turns N',
      '--review-max-iter N',
      '--fanout-parallel N',
      '--wall-clock <dur>',
    ]) {
      expect(DEEP_RESEARCH_USAGE).toContain(flag);
    }
  });
});
