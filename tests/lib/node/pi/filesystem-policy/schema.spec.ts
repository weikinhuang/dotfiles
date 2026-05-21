/**
 * Tests for lib/node/pi/filesystem-policy/schema.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  DEFAULT_POLICY,
  emptyPolicy,
  emptyReadPolicy,
  emptyRules,
  emptyWritePolicy,
  mergePolicies,
  mergeReadPolicies,
  mergeRules,
  mergeWritePolicies,
} from '../../../../../lib/node/pi/filesystem-policy/schema.ts';

describe('emptyRules / emptyPolicy', () => {
  test('emptyRules returns the right shape', () => {
    expect(emptyRules()).toEqual({ basenames: [], segments: [], paths: [] });
  });

  test('emptyReadPolicy / emptyWritePolicy / emptyPolicy compose', () => {
    expect(emptyReadPolicy()).toEqual({ deny: emptyRules(), allow: emptyRules() });
    expect(emptyWritePolicy()).toEqual({ allow: emptyRules(), deny: emptyRules() });
    expect(emptyPolicy()).toEqual({
      read: { deny: emptyRules(), allow: emptyRules() },
      write: { allow: emptyRules(), deny: emptyRules() },
    });
  });

  test('each empty call returns a fresh, mutable object', () => {
    const a = emptyRules();
    const b = emptyRules();
    a.basenames.push('.env');
    expect(b.basenames).toEqual([]);
  });
});

describe('mergeRules', () => {
  test('additive across sources, skips undefined / null fields', () => {
    expect(
      mergeRules(
        { basenames: ['.env'] },
        { segments: ['node_modules'] },
        { basenames: ['*.key'], paths: ['~/.ssh'] },
        undefined,
        null,
      ),
    ).toEqual({
      basenames: ['.env', '*.key'],
      segments: ['node_modules'],
      paths: ['~/.ssh'],
    });
  });

  test('empty input yields an empty rule set', () => {
    expect(mergeRules()).toEqual(emptyRules());
  });

  test('coerces non-string array items', () => {
    expect(mergeRules({ basenames: [42 as unknown as string, '.env'] }).basenames).toEqual(['42', '.env']);
  });

  test('non-array values are dropped silently (callers warn)', () => {
    expect(mergeRules({ basenames: 'oops' as unknown as string[], segments: ['ok'] })).toEqual({
      basenames: [],
      segments: ['ok'],
      paths: [],
    });
  });
});

describe('mergeReadPolicies / mergeWritePolicies', () => {
  test('mergeReadPolicies routes deny vs allow correctly', () => {
    expect(mergeReadPolicies({ deny: { basenames: ['.env'] } }, { allow: { basenames: ['.env.local'] } })).toEqual({
      deny: { basenames: ['.env'], segments: [], paths: [] },
      allow: { basenames: ['.env.local'], segments: [], paths: [] },
    });
  });

  test('mergeWritePolicies routes allow vs deny correctly', () => {
    expect(
      mergeWritePolicies(
        { allow: { paths: ['.'] } },
        { deny: { segments: ['.git/hooks'] } },
        { allow: { paths: ['/tmp'] } },
      ),
    ).toEqual({
      allow: { basenames: [], segments: [], paths: ['.', '/tmp'] },
      deny: { basenames: [], segments: ['.git/hooks'], paths: [] },
    });
  });
});

describe('mergePolicies', () => {
  test('additive across sources, ignores undefined', () => {
    const merged = mergePolicies(
      { read: { deny: { basenames: ['.env'] } } },
      { write: { allow: { paths: ['.'] } } },
      undefined,
      { write: { deny: { segments: ['.git/hooks'] } } },
    );

    expect(merged.read.deny.basenames).toEqual(['.env']);
    expect(merged.write.allow.paths).toEqual(['.']);
    expect(merged.write.deny.segments).toEqual(['.git/hooks']);
  });

  test('empty input yields empty policy', () => {
    expect(mergePolicies()).toEqual(emptyPolicy());
  });

  test('DEFAULT_POLICY merges through cleanly', () => {
    const merged = mergePolicies(DEFAULT_POLICY);
    expect(merged.read.deny.basenames).toEqual(DEFAULT_POLICY.read.deny.basenames);
    // Mutating the merged copy must NOT bleed into the frozen default.
    merged.write.allow.paths.push('/etc');
    expect(DEFAULT_POLICY.write.allow.paths).not.toContain('/etc');
  });
});

describe('DEFAULT_POLICY', () => {
  test('matches plan section 6 baseline (read.deny secrets, write.allow ./tmp)', () => {
    expect(DEFAULT_POLICY.read.deny.basenames).toEqual(['.env', '.env.*', '.envrc']);
    expect(DEFAULT_POLICY.read.deny.paths).toEqual([
      '~/.ssh',
      '~/.aws',
      '~/.gnupg',
      '~/.config/gh',
      '~/.kube',
      '~/.docker/config.json',
    ]);
    expect(DEFAULT_POLICY.write.allow.paths).toEqual(['.', '/tmp']);
    expect(DEFAULT_POLICY.write.deny.basenames).toEqual(['.env', '.env.*']);
    expect(DEFAULT_POLICY.write.deny.segments).toEqual(['.git/hooks', '.git/config']);
  });

  test('top-level shape is frozen', () => {
    expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_POLICY.read)).toBe(true);
    expect(Object.isFrozen(DEFAULT_POLICY.write)).toBe(true);
  });
});
