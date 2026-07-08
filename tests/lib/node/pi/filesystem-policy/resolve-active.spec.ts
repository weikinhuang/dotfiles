/**
 * Tests for lib/node/pi/filesystem-policy/resolve-active.ts.
 */

import { describe, expect, test, vi } from 'vitest';

import {
  filesystemProjectPolicyPath,
  filesystemUserPolicyPath,
} from '../../../../../lib/node/pi/filesystem-policy/load.ts';
import {
  type ActivePersonaWriteRoots,
  resolveActiveFilesystemPolicy,
} from '../../../../../lib/node/pi/filesystem-policy/resolve-active.ts';

describe('resolveActiveFilesystemPolicy', () => {
  test('reads the user then project layer and applies shipped defaults', () => {
    const readLayer = vi.fn().mockReturnValue('');
    const { policy, warnings } = resolveActiveFilesystemPolicy('/repo', {
      readLayer,
      getActivePersona: () => undefined,
    });

    expect(warnings).toEqual([]);
    // Layers are read from the resolved user + project policy paths, in order.
    expect(readLayer).toHaveBeenNthCalledWith(1, filesystemUserPolicyPath());
    expect(readLayer).toHaveBeenNthCalledWith(2, filesystemProjectPolicyPath('/repo'));
    // Shipped DEFAULT_POLICY is folded in.
    expect(policy.read.deny.basenames).toContain('.env');
    expect(policy.write.allow.paths).toContain('.');
  });

  test('folds a project layer additively on top of the user layer', () => {
    const readLayer = (path: string): string => {
      if (path === filesystemUserPolicyPath()) return '{"read":{"deny":{"basenames":["a.pem"]}}}';
      if (path === filesystemProjectPolicyPath('/repo')) return '{"read":{"deny":{"basenames":["b.pem"]}}}';
      return '';
    };
    const { policy } = resolveActiveFilesystemPolicy('/repo', {
      readLayer,
      getActivePersona: () => undefined,
    });
    expect(policy.read.deny.basenames).toEqual(expect.arrayContaining(['a.pem', 'b.pem']));
  });

  test('folds active persona writeRoots into write.allow.paths', () => {
    const persona: ActivePersonaWriteRoots = { name: 'plan', resolvedWriteRoots: ['/repo/plans'] };
    const { policy } = resolveActiveFilesystemPolicy('/repo', {
      readLayer: () => '',
      getActivePersona: () => persona,
    });
    expect(policy.write.allow.paths).toContain('/repo/plans');
  });

  test('skips the persona overlay when the persona has no writeRoots', () => {
    const persona: ActivePersonaWriteRoots = { name: 'chat', resolvedWriteRoots: [] };
    const withPersona = resolveActiveFilesystemPolicy('/repo', {
      readLayer: () => '',
      getActivePersona: () => persona,
    });
    const withoutPersona = resolveActiveFilesystemPolicy('/repo', {
      readLayer: () => '',
      getActivePersona: () => undefined,
    });
    expect(withPersona.policy.write.allow.paths).toEqual(withoutPersona.policy.write.allow.paths);
  });

  test('surfaces layer-parse warnings from a malformed layer', () => {
    const readLayer = (path: string): string => (path === filesystemUserPolicyPath() ? '{ not valid json ' : '');
    const { warnings } = resolveActiveFilesystemPolicy('/repo', {
      readLayer,
      getActivePersona: () => undefined,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].source).toBe(filesystemUserPolicyPath());
  });
});
