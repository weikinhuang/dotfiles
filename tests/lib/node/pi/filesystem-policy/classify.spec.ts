/**
 * Tests for lib/node/pi/filesystem-policy/classify.ts.
 */

import { homedir } from 'node:os';

import { describe, expect, test } from 'vitest';

import {
  basenameOf,
  classifyRead,
  classifyWrite,
  expandTilde,
  globToRegex,
  isInsideWorkspace,
  isUnderPath,
  pathContainsSegment,
} from '../../../../../lib/node/pi/filesystem-policy/classify.ts';
import {
  DEFAULT_POLICY,
  emptyPolicy,
  mergePolicies,
  type FilesystemPolicy,
} from '../../../../../lib/node/pi/filesystem-policy/schema.ts';

const HOME = homedir();
const CWD = '/tmp/some-project';
const HOME_CWD = `${HOME}/work/some-project`;

const defaults = (): FilesystemPolicy => mergePolicies(DEFAULT_POLICY);

// ──────────────────────────────────────────────────────────────────────
// Path helpers
// ──────────────────────────────────────────────────────────────────────

describe('expandTilde', () => {
  test('handles bare ~ and ~/foo', () => {
    expect(expandTilde('~')).toBe(HOME);
    expect(expandTilde('~/foo')).toBe(`${HOME}/foo`);
    expect(expandTilde('~/.env')).toBe(`${HOME}/.env`);
  });

  test('non-tilde paths pass through', () => {
    expect(expandTilde('./foo')).toBe('./foo');
    expect(expandTilde('/abs/path')).toBe('/abs/path');
    expect(expandTilde('$HOME/foo')).toBe('$HOME/foo');
    expect(expandTilde('')).toBe('');
  });

  test('~user/ NOT supported (falls through)', () => {
    expect(expandTilde('~alice/secret')).toBe('~alice/secret');
  });
});

describe('globToRegex', () => {
  test('* and ? plus escapes for metacharacters', () => {
    expect(globToRegex('.env').test('.env')).toBe(true);
    expect(globToRegex('.env').test('.environment')).toBe(false);
    expect(globToRegex('.env.*').test('.env.local')).toBe(true);
    expect(globToRegex('.env.*').test('.env')).toBe(false);
    expect(globToRegex('*.key').test('server.key')).toBe(true);
    expect(globToRegex('?').test('a')).toBe(true);
    expect(globToRegex('?').test('ab')).toBe(false);
  });
});

describe('basenameOf / isInsideWorkspace / isUnderPath', () => {
  test('basenameOf', () => {
    expect(basenameOf('/a/b/c.txt')).toBe('c.txt');
    expect(basenameOf('c.txt')).toBe('c.txt');
    expect(basenameOf('/trailing/')).toBe('');
  });

  test('isInsideWorkspace', () => {
    expect(isInsideWorkspace('/tmp/some-project/src/x.ts', CWD)).toBe(true);
    expect(isInsideWorkspace('/tmp/elsewhere/x.ts', CWD)).toBe(false);
    expect(isInsideWorkspace(CWD, CWD)).toBe(false);
  });

  test('isUnderPath respects separators', () => {
    expect(isUnderPath('/home/me/.ssh/id_rsa', '/home/me/.ssh')).toBe(true);
    expect(isUnderPath('/home/me/.ssh', '/home/me/.ssh')).toBe(true);
    expect(isUnderPath('/home/me/.sshkeys', '/home/me/.ssh')).toBe(false);
    expect(isUnderPath('/anywhere', '')).toBe(false);
  });
});

describe('pathContainsSegment (multi-segment aware)', () => {
  test('single-segment match anywhere in the path', () => {
    expect(pathContainsSegment('/p/node_modules/foo', 'node_modules')).toBe(true);
    expect(pathContainsSegment('/p/.git/HEAD', '.git')).toBe(true);
    expect(pathContainsSegment('/p/.github/workflows/ci.yml', '.git')).toBe(false);
  });

  test('multi-segment `.git/hooks` matches the ordered subsequence', () => {
    expect(pathContainsSegment('/p/.git/hooks/pre-commit', '.git/hooks')).toBe(true);
    expect(pathContainsSegment('/p/.git/HEAD', '.git/hooks')).toBe(false);
    expect(pathContainsSegment('/p/.git/hooks', '.git/hooks')).toBe(true);
  });

  test('empty / lookalike segment does not match', () => {
    expect(pathContainsSegment('/p/foo', '')).toBe(false);
    expect(pathContainsSegment('/p/src/node_modules_lookalike/x', 'node_modules')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// classifyRead - deny then allow-back
// ──────────────────────────────────────────────────────────────────────

describe('classifyRead', () => {
  test('default deny set blocks .env and ~/.ssh', () => {
    const policy = defaults();
    expect(classifyRead('src/.env', CWD, policy)?.reason).toBe('deny-basename');
    expect(classifyRead('src/.envrc', CWD, policy)?.reason).toBe('deny-basename');
    expect(classifyRead('~/.ssh/id_rsa', CWD, policy)?.reason).toBe('deny-path-prefix');
    expect(classifyRead('~/.aws/credentials', CWD, policy)?.reason).toBe('deny-path-prefix');
  });

  test('clean reads are not gated', () => {
    const policy = defaults();
    expect(classifyRead('src/index.ts', CWD, policy)).toBeNull();
    expect(classifyRead('/etc/hosts', CWD, policy)).toBeNull();
  });

  test('allow-back can carve a hole inside a deny prefix', () => {
    const policy = mergePolicies(DEFAULT_POLICY, {
      read: { allow: { paths: ['~/.config/gh/hosts.yml'] } },
    });
    // The file inside the deny prefix is allowed back.
    expect(classifyRead('~/.config/gh/hosts.yml', CWD, policy)).toBeNull();
    // Sibling paths inside the same deny prefix stay denied.
    expect(classifyRead('~/.config/gh/credentials.yml', CWD, policy)?.reason).toBe('deny-path-prefix');
  });

  test('outside-workspace is NOT enforced on reads', () => {
    const policy = defaults();
    expect(classifyRead('/etc/hosts', CWD, policy)).toBeNull();
    expect(classifyRead('~/notes/foo.md', CWD, policy)).toBeNull();
  });

  test('multi-segment denies match nested files', () => {
    const policy = mergePolicies({
      read: { deny: { segments: ['.git/hooks'] } },
    });
    expect(classifyRead('.git/hooks/pre-commit', CWD, policy)?.reason).toBe('deny-segment');
    expect(classifyRead('.git/HEAD', CWD, policy)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// classifyWrite - allow-only with deny-within-allow
// ──────────────────────────────────────────────────────────────────────

describe('classifyWrite', () => {
  test('default policy gates writes outside cwd / /tmp', () => {
    const policy = defaults();
    expect(classifyWrite('./src/x.ts', CWD, policy)).toBeNull();
    expect(classifyWrite('/tmp/scratch.txt', CWD, policy)).toBeNull();
    expect(classifyWrite('/etc/hosts', CWD, policy)?.reason).toBe('outside-allowed-write');
    expect(classifyWrite('~/notes/foo.md', CWD, policy)?.reason).toBe('outside-allowed-write');
  });

  test('write.deny inside the allow set still gates', () => {
    // node_modules is NOT in the shipped defaults anymore - workspaces
    // are write-allowed - but a stricter project policy can opt back
    // in. This test exercises that opt-in shape.
    const policy = mergePolicies(DEFAULT_POLICY, {
      write: { deny: { segments: ['node_modules'] } },
    });
    expect(classifyWrite('./src/.env', CWD, policy)?.reason).toBe('deny-basename');
    expect(classifyWrite('./.git/hooks/pre-commit', CWD, policy)?.reason).toBe('deny-segment');
    expect(classifyWrite('./node_modules/foo/index.js', CWD, policy)?.reason).toBe('deny-segment');
  });

  test('read.deny ALSO gates writes (read ∪ write at write time)', () => {
    const policy = defaults();
    // `~/.ssh` is read.deny, and even if we add it to write.allow,
    // writing should still be blocked because it's read-sensitive.
    const policyWithSshAllow = mergePolicies(policy, {
      write: { allow: { paths: ['~/.ssh'] } },
    });
    expect(classifyWrite('~/.ssh/authorized_keys', CWD, policyWithSshAllow)?.reason).toBe('deny-path-prefix');
  });

  test('persona writeRoots widen the allow set', () => {
    const policy = mergePolicies(DEFAULT_POLICY, {
      write: { allow: { paths: ['~/notes'] } },
    });
    expect(classifyWrite('~/notes/foo.md', CWD, policy)).toBeNull();
  });

  test('paths resolve against the supplied cwd, not process.cwd', () => {
    const policy = mergePolicies({
      write: { allow: { paths: ['.'] } },
    });
    // From a home-rooted cwd, writing inside the cwd is fine.
    expect(classifyWrite('src/x.ts', HOME_CWD, policy)).toBeNull();
    // From a /tmp cwd, the same relative-`.` resolves to /tmp/some-project.
    expect(classifyWrite('src/x.ts', CWD, policy)).toBeNull();
    // But a tilde path is NOT covered by `.`.
    expect(classifyWrite('~/notes/foo.md', CWD, policy)?.reason).toBe('outside-allowed-write');
  });

  test('empty policy gates everything', () => {
    const policy = emptyPolicy();
    expect(classifyWrite('./src/x.ts', CWD, policy)?.reason).toBe('outside-allowed-write');
    expect(classifyWrite('/tmp/x', CWD, policy)?.reason).toBe('outside-allowed-write');
  });

  // ── carve-back inside write.deny / read.deny ──────────────────────

  test('write.allow.segments carves a hole inside write.deny.segments', () => {
    // node_modules is NOT in the shipped defaults; this carve-back
    // shape only makes sense when a stricter project policy added
    // it back to write.deny.segments.
    const policy = mergePolicies(DEFAULT_POLICY, {
      write: {
        allow: { segments: ['node_modules/.vite-temp'] },
        deny: { segments: ['node_modules'] },
      },
    });
    // Carved-out subtree: writes go through.
    expect(classifyWrite('./node_modules/.vite-temp/cache.mjs', CWD, policy)).toBeNull();
    expect(classifyWrite('./node_modules/.vite-temp/sub/dir/x.json', CWD, policy)).toBeNull();
    // Sibling paths inside the same denied segment stay denied.
    expect(classifyWrite('./node_modules/foo/index.js', CWD, policy)?.reason).toBe('deny-segment');
    expect(classifyWrite('./node_modules/.bin/foo', CWD, policy)?.reason).toBe('deny-segment');
  });

  test('write.allow.basenames carves a hole inside write.deny.basenames', () => {
    // .env.local matches both deny.basenames (`.env.*`) and the
    // carve-back basename - the deny is overridden.
    const policy = mergePolicies(DEFAULT_POLICY, {
      write: { allow: { basenames: ['.env.local'] } },
    });
    expect(classifyWrite('./src/.env.local', CWD, policy)).toBeNull();
    expect(classifyWrite('./src/.env.production', CWD, policy)?.reason).toBe('deny-basename');
    expect(classifyWrite('./src/.env', CWD, policy)?.reason).toBe('deny-basename');
  });

  test('carve-back also overrides read.deny when classifying writes', () => {
    // Mirrors the symmetric semantic: read-sensitive paths are
    // write-sensitive UNLESS the user explicitly carved them back.
    const policy = mergePolicies(DEFAULT_POLICY, {
      write: {
        allow: { paths: ['~/.ssh'], segments: ['known_hosts'] },
      },
    });
    // Without the carve-back, this would hit read.deny on ~/.ssh.
    expect(classifyWrite('~/.ssh/known_hosts', CWD, policy)).toBeNull();
    // Sibling secrets inside ~/.ssh stay denied.
    expect(classifyWrite('~/.ssh/id_rsa', CWD, policy)?.reason).toBe('deny-path-prefix');
  });

  test('write.allow.paths is OUTER GATE only - does not carve back', () => {
    // Even though `.` (cwd) and `node_modules/.vite-temp` are both
    // listed in write.allow.paths, the carve-back semantic only
    // applies to basenames / segments. Without segments, writes to
    // node_modules sub-paths still hit deny-segment.
    //
    // `node_modules` is no longer in the shipped defaults, so we add
    // it explicitly to exercise the deny path that this assertion
    // depends on.
    const policy = mergePolicies(DEFAULT_POLICY, {
      write: {
        allow: { paths: ['.', 'node_modules/.vite-temp'] },
        deny: { segments: ['node_modules'] },
      },
    });
    expect(classifyWrite('./node_modules/.vite-temp/x.mjs', CWD, policy)?.reason).toBe('deny-segment');
  });

  test('carve-back cannot widen outside the write.allow.paths gate', () => {
    // Paths outside the outer gate fail at step 1 before the
    // carve-back logic runs.
    const policy = mergePolicies(DEFAULT_POLICY, {
      write: { allow: { segments: ['node_modules/.vite-temp'] } },
    });
    // /etc/foo isn't under cwd or /tmp - outside-allowed-write fires.
    expect(classifyWrite('/etc/node_modules/.vite-temp/x', CWD, policy)?.reason).toBe('outside-allowed-write');
  });
});
