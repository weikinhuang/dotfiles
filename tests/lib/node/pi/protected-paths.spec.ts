/**
 * Tests for lib/node/pi/paths.ts.
 */

import { homedir } from 'node:os';
import { expect, test } from 'vitest';
import {
  basenameOf,
  classify,
  classifyRead,
  classifyWrite,
  DEFAULT_CONFIG,
  emptyConfig,
  emptyRules,
  expandTilde,
  globToRegex,
  isInsideWorkspace,
  isUnderPath,
  mergeConfigs,
  mergeRules,
  pathContainsSegment,
  type ProtectionConfig,
} from '../../../../lib/node/pi/paths.ts';

const HOME = homedir();
const CWD_INSIDE_HOME = `${HOME}/some-project`;
const CWD_OUTSIDE_HOME = '/tmp/some-project';

// Concrete copy of DEFAULT_CONFIG so tests don't accidentally mutate the
// frozen default.
const defaults = (): ProtectionConfig => mergeConfigs(DEFAULT_CONFIG);

// ──────────────────────────────────────────────────────────────────────
// expandTilde / globToRegex / basename helpers
// ──────────────────────────────────────────────────────────────────────

test('expandTilde: bare ~ and ~/foo', () => {
  expect(expandTilde('~')).toBe(HOME);
  expect(expandTilde('~/foo')).toBe(`${HOME}/foo`);
  expect(expandTilde('~/.env')).toBe(`${HOME}/.env`);
});

test('expandTilde: non-tilde paths pass through unchanged', () => {
  expect(expandTilde('./foo')).toBe('./foo');
  expect(expandTilde('/absolute/path')).toBe('/absolute/path');
  expect(expandTilde('$HOME/foo')).toBe('$HOME/foo');
  expect(expandTilde('')).toBe('');
});

test('expandTilde: ~user/ syntax is NOT supported (falls through)', () => {
  expect(expandTilde('~alice/secret')).toBe('~alice/secret');
});

test('globToRegex: supports * and ? and escapes metacharacters', () => {
  expect(globToRegex('.env').test('.env')).toBe(true);
  expect(globToRegex('.env').test('.environment')).toBe(false);
  expect(globToRegex('.env.*').test('.env.local')).toBe(true);
  expect(globToRegex('.env.*').test('.env')).toBe(false); // star requires ≥1 char
  expect(globToRegex('*.key').test('server.key')).toBe(true);
  expect(globToRegex('*.key').test('server.pem')).toBe(false);
  expect(globToRegex('?').test('a')).toBe(true);
  expect(globToRegex('?').test('ab')).toBe(false);
});

test('basenameOf: trailing segment after last sep', () => {
  expect(basenameOf('/a/b/c.txt')).toBe('c.txt');
  expect(basenameOf('c.txt')).toBe('c.txt');
  expect(basenameOf('/only-slash/')).toBe('');
});

test('isInsideWorkspace', () => {
  expect(isInsideWorkspace('/tmp/some-project/src/x.ts', CWD_OUTSIDE_HOME)).toBe(true);
  expect(isInsideWorkspace('/tmp/elsewhere/x.ts', CWD_OUTSIDE_HOME)).toBe(false);
  expect(isInsideWorkspace(CWD_OUTSIDE_HOME, CWD_OUTSIDE_HOME)).toBe(false);
});

test('pathContainsSegment: only full path segments trigger', () => {
  expect(pathContainsSegment('/tmp/p/node_modules/foo', 'node_modules')).toBe(true);
  expect(pathContainsSegment('/tmp/p/src/node_modules_lookalike/x', 'node_modules')).toBe(false);
  expect(pathContainsSegment('/tmp/p/.git/HEAD', '.git')).toBe(true);
  expect(pathContainsSegment('/tmp/p/.git', '.git')).toBe(true);
  expect(pathContainsSegment('/tmp/p/.github/workflows/ci.yml', '.git')).toBe(false);
  expect(pathContainsSegment('/tmp/p/foo', '')).toBe(false);
});

test('isUnderPath: prefix match respects path separators', () => {
  expect(isUnderPath('/home/me/.ssh/id_rsa', '/home/me/.ssh')).toBe(true);
  expect(isUnderPath('/home/me/.ssh', '/home/me/.ssh')).toBe(true);
  expect(isUnderPath('/home/me/.sshkeys', '/home/me/.ssh')).toBe(false);
  expect(isUnderPath('/home/me/.ssh/nested/deep', '/home/me/.ssh')).toBe(true);
  expect(isUnderPath('/anywhere', '')).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// mergeRules / mergeConfigs
// ──────────────────────────────────────────────────────────────────────

test('mergeRules: additive across sources, skips undefined fields', () => {
  const merged = mergeRules(
    { basenames: ['.env'] },
    { segments: ['node_modules'] },
    { basenames: ['*.key'], paths: ['~/.ssh'] },
    undefined,
    null,
  );

  expect(merged).toEqual({
    basenames: ['.env', '*.key'],
    segments: ['node_modules'],
    paths: ['~/.ssh'],
  });
});

test('mergeRules: empty input → empty rule set', () => {
  expect(mergeRules()).toEqual(emptyRules());
});

test('mergeRules: coerces non-string array items defensively', () => {
  const merged = mergeRules({ basenames: [123 as unknown as string, '.env'] });

  expect(merged.basenames).toEqual(['123', '.env']);
});

test('mergeConfigs: merges read and write independently', () => {
  const merged = mergeConfigs(
    { read: { basenames: ['.env'] } },
    { write: { segments: ['node_modules'] } },
    { read: { paths: ['~/.ssh'] }, write: { basenames: ['*.db'] } },
    undefined,
  );

  expect(merged.read).toEqual({ basenames: ['.env'], segments: [], paths: ['~/.ssh'] });
  expect(merged.write).toEqual({ basenames: ['*.db'], segments: ['node_modules'], paths: [] });
});

test('mergeConfigs: empty input → empty config', () => {
  expect(mergeConfigs()).toEqual(emptyConfig());
});

// ──────────────────────────────────────────────────────────────────────
// DEFAULT_CONFIG
// ──────────────────────────────────────────────────────────────────────

test('DEFAULT_CONFIG: read category gates .env*, .envrc, ~/.ssh', () => {
  expect(DEFAULT_CONFIG.read.basenames).toContain('.env');
  expect(DEFAULT_CONFIG.read.basenames).toContain('.env.*');
  expect(DEFAULT_CONFIG.read.basenames).toContain('.envrc');
  expect(DEFAULT_CONFIG.read.paths).toContain('~/.ssh');
});

test('DEFAULT_CONFIG: write category adds node_modules and .git', () => {
  expect(DEFAULT_CONFIG.write.segments).toContain('node_modules');
  expect(DEFAULT_CONFIG.write.segments).toContain('.git');
});

// ──────────────────────────────────────────────────────────────────────
// classify — low-level
// ──────────────────────────────────────────────────────────────────────

test('classify: path-prefix rule beats outside-workspace for useful detail', () => {
  const rules = { basenames: [], segments: [], paths: ['~/.ssh'] };
  const res = classify('~/.ssh/config', CWD_OUTSIDE_HOME, rules);

  expect(res?.reason).toBe('path-prefix');
  expect(res?.detail ?? '').toMatch(/~\/\.ssh/);
});

test('classify: checkOutsideWorkspace=false skips the boundary check', () => {
  const rules = emptyRules();

  // With check: outside-workspace fires.
  expect(classify('/etc/hosts', CWD_OUTSIDE_HOME, rules)?.reason).toBe('outside-workspace');
  // Without: /etc/hosts is fine if no other rule matches.
  expect(classify('/etc/hosts', CWD_OUTSIDE_HOME, rules, { checkOutsideWorkspace: false })).toBe(null);
});

test('classify: basename and segment matching against defaults', () => {
  const rules = mergeRules(DEFAULT_CONFIG.read, DEFAULT_CONFIG.write);

  expect(classify('src/.env', CWD_OUTSIDE_HOME, rules)?.reason).toBe('basename');
  expect(classify('src/.envrc', CWD_OUTSIDE_HOME, rules)?.reason).toBe('basename');
  expect(classify('src/node_modules/x', CWD_OUTSIDE_HOME, rules)?.reason).toBe('segment');
  expect(classify('.git/config', CWD_OUTSIDE_HOME, rules)?.reason).toBe('segment');
});

// ──────────────────────────────────────────────────────────────────────
// classifyRead
// ──────────────────────────────────────────────────────────────────────

test('classifyRead: gates .env / .envrc / ~/.ssh with defaults', () => {
  const c = defaults();

  expect(classifyRead('src/.env', CWD_OUTSIDE_HOME, c)?.reason).toBe('basename');
  expect(classifyRead('src/.env.local', CWD_OUTSIDE_HOME, c)?.reason).toBe('basename');
  expect(classifyRead('src/.envrc', CWD_OUTSIDE_HOME, c)?.reason).toBe('basename');
  expect(classifyRead('~/.ssh/id_rsa', CWD_OUTSIDE_HOME, c)?.reason).toBe('path-prefix');
  expect(classifyRead('~/.ssh', CWD_OUTSIDE_HOME, c)?.reason).toBe('path-prefix');
});

test('classifyRead: does NOT gate on outside-workspace', () => {
  const c = defaults();

  // Reading /etc/hosts or a neighboring repo's README is fine by default.
  expect(classifyRead('/etc/hosts', CWD_OUTSIDE_HOME, c)).toBe(null);
  expect(classifyRead('/tmp/other-project/README.md', CWD_OUTSIDE_HOME, c)).toBe(null);
  expect(classifyRead('~/notes.txt', CWD_OUTSIDE_HOME, c)).toBe(null);
});

test('classifyRead: does NOT gate on write-only rules (node_modules, .git)', () => {
  const c = defaults();

  // Reading node_modules / .git contents is routine (inspecting vendored code,
  // git logs via file inspection, etc.) — only writing to them is dangerous.
  expect(classifyRead('node_modules/react/index.js', CWD_OUTSIDE_HOME, c)).toBe(null);
  expect(classifyRead('.git/HEAD', CWD_OUTSIDE_HOME, c)).toBe(null);
});

test('classifyRead: ~-expanded paths resolve correctly', () => {
  const c = defaults();

  // Key regression guard: `~/.ssh/config` must NOT become `cwd/~/.ssh/config`.
  expect(classifyRead('~/.ssh/config', CWD_OUTSIDE_HOME, c)?.reason).toBe('path-prefix');
  expect(classifyRead('~/.env', CWD_OUTSIDE_HOME, c)?.reason).toBe('basename');
});

// ──────────────────────────────────────────────────────────────────────
// classifyWrite
// ──────────────────────────────────────────────────────────────────────

test('classifyWrite: gates everything read-sensitive PLUS write-only categories', () => {
  const c = defaults();

  // Read-sensitive
  expect(classifyWrite('src/.env', CWD_OUTSIDE_HOME, c)?.reason).toBe('basename');
  expect(classifyWrite('src/.envrc', CWD_OUTSIDE_HOME, c)?.reason).toBe('basename');
  expect(classifyWrite('~/.ssh/config', CWD_OUTSIDE_HOME, c)?.reason).toBe('path-prefix');
  // Write-only
  expect(classifyWrite('src/node_modules/pkg/x.js', CWD_OUTSIDE_HOME, c)?.reason).toBe('segment');
  expect(classifyWrite('.git/config', CWD_OUTSIDE_HOME, c)?.reason).toBe('segment');
});

test('classifyWrite: gates outside-workspace', () => {
  const c = defaults();

  expect(classifyWrite('/etc/hosts', CWD_OUTSIDE_HOME, c)?.reason).toBe('outside-workspace');
  expect(classifyWrite('~/notes.txt', CWD_OUTSIDE_HOME, c)?.reason).toBe('outside-workspace');
});

test('classifyWrite: clean paths inside workspace pass', () => {
  const c = defaults();

  expect(classifyWrite('./foo.ts', CWD_OUTSIDE_HOME, c)).toBe(null);
  expect(classifyWrite('src/index.ts', CWD_OUTSIDE_HOME, c)).toBe(null);
});

test('classifyWrite: ~-expanded paths inside workspace (home-rooted cwd)', () => {
  const c = defaults();

  expect(classifyWrite('~/some-project/src/x.ts', CWD_INSIDE_HOME, c)).toBe(null);
  expect(classifyWrite('~/some-project/.env', CWD_INSIDE_HOME, c)?.reason).toBe('basename');
  expect(classifyWrite('~/some-project/node_modules/foo', CWD_INSIDE_HOME, c)?.reason).toBe('segment');
  expect(classifyWrite('~/other/x.ts', CWD_INSIDE_HOME, c)?.reason).toBe('outside-workspace');
});

test('classifyWrite: ~user/ falls through as relative path', () => {
  const c = defaults();

  // Documented conservative fallback.
  expect(classifyWrite('~alice/secret', CWD_OUTSIDE_HOME, c)).toBe(null);
});

// ──────────────────────────────────────────────────────────────────────
// Custom config end-to-end
// ──────────────────────────────────────────────────────────────────────

test('custom config: user rules merge into effective gate', () => {
  const userConfig = {
    read: { basenames: ['secrets.yml'] },
    write: { segments: ['.terraform'] },
  };
  const c = mergeConfigs(DEFAULT_CONFIG, userConfig);

  // Read category picked up secrets.yml
  expect(classifyRead('config/secrets.yml', CWD_OUTSIDE_HOME, c)?.reason).toBe('basename');
  // Read category DIDN'T pick up .terraform (write-only)
  expect(classifyRead('infra/.terraform/state', CWD_OUTSIDE_HOME, c)).toBe(null);
  // Write category sees both (via read ∪ write)
  expect(classifyWrite('config/secrets.yml', CWD_OUTSIDE_HOME, c)?.reason).toBe('basename');
  expect(classifyWrite('infra/.terraform/state', CWD_OUTSIDE_HOME, c)?.reason).toBe('segment');
});

test('custom config: empty config gates only outside-workspace on writes', () => {
  const c = emptyConfig();

  expect(classifyRead('src/.env', CWD_OUTSIDE_HOME, c)).toBe(null);
  expect(classifyWrite('src/.env', CWD_OUTSIDE_HOME, c)).toBe(null);
  expect(classifyWrite('/etc/hosts', CWD_OUTSIDE_HOME, c)?.reason).toBe('outside-workspace');
});
