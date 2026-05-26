/**
 * Tests for lib/node/pi/filesystem-policy/load.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  FILESYSTEM_POLICY_FILENAME,
  filesystemProjectPolicyPath,
  filesystemUserPolicyPath,
  loadFilesystemPolicy,
} from '../../../../../lib/node/pi/filesystem-policy/load.ts';

describe('loadFilesystemPolicy', () => {
  test('path helpers resolve the shared filesystem policy file', () => {
    expect(FILESYSTEM_POLICY_FILENAME).toBe('filesystem.json');
    expect(filesystemUserPolicyPath()).toContain('/filesystem.json');
    expect(filesystemProjectPolicyPath('/repo')).toBe('/repo/.pi/filesystem.json');
  });

  test('shipped defaults are applied when no layers supplied', () => {
    const { policy, warnings } = loadFilesystemPolicy([]);
    expect(warnings).toEqual([]);
    // From DEFAULT_POLICY.
    expect(policy.read.deny.basenames).toContain('.env');
    expect(policy.write.allow.paths).toContain('.');
  });

  test('includeDefaults: false starts from empty', () => {
    const { policy } = loadFilesystemPolicy([], { includeDefaults: false });
    expect(policy.read.deny.basenames).toEqual([]);
    expect(policy.write.allow.paths).toEqual([]);
  });

  test('JSONC with comments parses cleanly', () => {
    const raw = `{
      // trailing comment
      "read": {
        "deny": {
          "basenames": ["secrets.yml"], // sensitive secrets file
          "segments": [],
          "paths": []
        }
      }
    }`;
    const { policy, warnings } = loadFilesystemPolicy([{ source: 'project', raw }], { includeDefaults: false });
    expect(warnings).toEqual([]);
    expect(policy.read.deny.basenames).toEqual(['secrets.yml']);
  });

  test('layers are additive, last layer adds without clobbering', () => {
    const { policy } = loadFilesystemPolicy(
      [
        { source: 'user', raw: '{"read":{"deny":{"basenames":["a.pem"]}}}' },
        { source: 'project', raw: '{"read":{"deny":{"basenames":["b.pem"]}}}' },
      ],
      { includeDefaults: false },
    );
    expect(policy.read.deny.basenames).toEqual(['a.pem', 'b.pem']);
  });

  test('persona overlay merges into write.allow.paths', () => {
    const { policy } = loadFilesystemPolicy([], {
      includeDefaults: false,
      personaOverlay: { source: 'persona:plan', paths: ['/repo/plans/'] },
    });
    expect(policy.write.allow.paths).toEqual(['/repo/plans/']);
  });

  test('malformed JSONC produces a warning, layer is skipped', () => {
    const { policy, warnings } = loadFilesystemPolicy(
      [
        { source: 'user', raw: '{ this is not json ' },
        { source: 'project', raw: '{"read":{"deny":{"basenames":["ok.pem"]}}}' },
      ],
      { includeDefaults: false },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].source).toBe('user');
    expect(policy.read.deny.basenames).toEqual(['ok.pem']);
  });

  test('non-object top-level produces a warning', () => {
    const { warnings } = loadFilesystemPolicy([{ source: 'user', raw: '[1,2,3]' }]);
    expect(warnings.find((w) => w.reason.includes('object at top level'))).toBeDefined();
  });

  test('mis-typed leaf fields produce per-field warnings and are dropped', () => {
    const raw = `{
      "read": {
        "deny": {
          "basenames": "should-be-array",
          "segments": [".git", 42],
          "paths": ["/ok"]
        }
      }
    }`;
    const { policy, warnings } = loadFilesystemPolicy([{ source: 'user', raw }], { includeDefaults: false });
    expect(warnings.find((w) => w.reason.includes('basenames'))).toBeDefined();
    expect(warnings.find((w) => w.reason.includes('segments[1]'))).toBeDefined();
    expect(policy.read.deny.basenames).toEqual([]);
    expect(policy.read.deny.segments).toEqual(['.git']);
    expect(policy.read.deny.paths).toEqual(['/ok']);
  });

  test('blank layer is skipped without warnings', () => {
    const { warnings } = loadFilesystemPolicy([{ source: 'user', raw: '   \n' }]);
    expect(warnings).toEqual([]);
  });

  test('non-object `read` value is rejected', () => {
    const raw = '{"read": "oops", "write": {"allow": {"paths": ["."]}}}';
    const { policy, warnings } = loadFilesystemPolicy([{ source: 'user', raw }], { includeDefaults: false });
    expect(warnings.find((w) => w.reason.includes('`read` must be an object'))).toBeDefined();
    expect(policy.write.allow.paths).toEqual(['.']);
  });
});
