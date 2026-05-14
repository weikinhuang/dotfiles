/**
 * Tests for `lib/node/pi/mode/write-gate.ts`.
 */

import { expect, test } from 'vitest';

import { decideWriteGate } from '../../../../../lib/node/pi/persona/write-gate.ts';
import { assertKind } from '../helpers.ts';

const baseOpts = {
  resolvedWriteRoots: ['/repo/plans/'] as readonly string[],
  sessionAllow: new Set<string>(),
  hasUI: true,
  violationDefault: 'deny' as const,
  personaName: 'plan',
};

// ──────────────────────────────────────────────────────────────────────
// allow paths
// ──────────────────────────────────────────────────────────────────────

test('decideWriteGate: path inside writeRoots → allow (no prompt)', () => {
  const decision = decideWriteGate({
    ...baseOpts,
    absolutePath: '/repo/plans/foo.md',
    inputPath: 'plans/foo.md',
  });

  expect(decision).toEqual({ kind: 'allow' });
});

test('decideWriteGate: path in sessionAllow → allow (cached approval, even outside roots)', () => {
  const decision = decideWriteGate({
    ...baseOpts,
    absolutePath: '/repo/src/foo.ts',
    inputPath: 'src/foo.ts',
    sessionAllow: new Set(['/repo/src/foo.ts']),
  });

  expect(decision).toEqual({ kind: 'allow' });
});

test('decideWriteGate: sessionAllow wins over writeRoots check (cache short-circuits)', () => {
  // Path inside roots AND in sessionAllow → still allow; either branch suffices.
  const decision = decideWriteGate({
    ...baseOpts,
    absolutePath: '/repo/plans/foo.md',
    inputPath: 'plans/foo.md',
    sessionAllow: new Set(['/repo/plans/foo.md']),
  });

  expect(decision).toEqual({ kind: 'allow' });
});

test('decideWriteGate: nested path inside writeRoots → allow', () => {
  const decision = decideWriteGate({
    ...baseOpts,
    absolutePath: '/repo/plans/v1/proposal.md',
    inputPath: 'plans/v1/proposal.md',
  });

  expect(decision).toEqual({ kind: 'allow' });
});

// ──────────────────────────────────────────────────────────────────────
// prompt paths (UI available)
// ──────────────────────────────────────────────────────────────────────

test('decideWriteGate: outside writeRoots + UI → prompt, detail names roots', () => {
  const decision = decideWriteGate({
    ...baseOpts,
    absolutePath: '/repo/src/foo.ts',
    inputPath: 'src/foo.ts',
  });

  assertKind(decision, 'prompt');

  expect(decision.detail).toContain('persona "plan"');
  expect(decision.detail).toContain('/repo/plans/');
});

test('decideWriteGate: empty writeRoots + UI → prompt, detail says "disallows writes"', () => {
  const decision = decideWriteGate({
    ...baseOpts,
    absolutePath: '/repo/anything.md',
    inputPath: 'anything.md',
    resolvedWriteRoots: [],
  });

  assertKind(decision, 'prompt');

  expect(decision.detail).toContain('persona "plan" disallows writes');
});

test('decideWriteGate: prompt detail lists multiple roots', () => {
  const decision = decideWriteGate({
    ...baseOpts,
    absolutePath: '/repo/foo.txt',
    inputPath: 'foo.txt',
    resolvedWriteRoots: ['/repo/plans/', '/repo/docs/'],
  });

  assertKind(decision, 'prompt');

  expect(decision.detail).toContain('/repo/plans/');
  expect(decision.detail).toContain('/repo/docs/');
});

// ──────────────────────────────────────────────────────────────────────
// no-UI paths (PI_PERSONA_VIOLATION_DEFAULT)
// ──────────────────────────────────────────────────────────────────────

test('decideWriteGate: outside roots + no UI + violationDefault=deny → block', () => {
  const decision = decideWriteGate({
    ...baseOpts,
    absolutePath: '/repo/src/foo.ts',
    inputPath: 'src/foo.ts',
    hasUI: false,
    violationDefault: 'deny',
  });

  assertKind(decision, 'block');

  expect(decision.reason).toContain('No UI for approval');
  expect(decision.reason).toContain('src/foo.ts');
  expect(decision.reason).toContain('PI_PERSONA_VIOLATION_DEFAULT=allow');
});

test('decideWriteGate: outside roots + no UI + violationDefault=allow → allow', () => {
  const decision = decideWriteGate({
    ...baseOpts,
    absolutePath: '/repo/src/foo.ts',
    inputPath: 'src/foo.ts',
    hasUI: false,
    violationDefault: 'allow',
  });

  expect(decision).toEqual({ kind: 'allow' });
});

test('decideWriteGate: empty roots + no UI + violationDefault=deny → block', () => {
  const decision = decideWriteGate({
    ...baseOpts,
    absolutePath: '/repo/anything.md',
    inputPath: 'anything.md',
    resolvedWriteRoots: [],
    hasUI: false,
    violationDefault: 'deny',
  });

  expect(decision.kind).toBe('block');
});

test('decideWriteGate: sessionAllow short-circuits even without UI', () => {
  const decision = decideWriteGate({
    ...baseOpts,
    absolutePath: '/repo/src/foo.ts',
    inputPath: 'src/foo.ts',
    sessionAllow: new Set(['/repo/src/foo.ts']),
    hasUI: false,
    violationDefault: 'deny',
  });

  expect(decision).toEqual({ kind: 'allow' });
});

// ──────────────────────────────────────────────────────────────────────
// integration: simulate sessionAllow accumulation across calls
// ──────────────────────────────────────────────────────────────────────

test('decideWriteGate: repeated outside-roots calls — first prompts, second is cached', () => {
  // Simulates the shell: prompt → user picks "allow this session" → caller
  // adds path to sessionAllow → next call to the same path returns allow.
  const sessionAllow = new Set<string>();
  const path = '/repo/src/foo.ts';

  const first = decideWriteGate({ ...baseOpts, absolutePath: path, inputPath: 'src/foo.ts', sessionAllow });

  expect(first.kind).toBe('prompt');

  // Caller's post-prompt handling adds the path:
  sessionAllow.add(path);

  const second = decideWriteGate({ ...baseOpts, absolutePath: path, inputPath: 'src/foo.ts', sessionAllow });

  expect(second).toEqual({ kind: 'allow' });
});
