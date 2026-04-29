/**
 * Tests for config/pi/extensions/lib/paths.ts.
 *
 * Run:  node --test config/pi/tests/extensions/protected-paths.test.ts
 *   or: node --test config/pi/tests/
 */

import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { test } from 'node:test';
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
} from '../../extensions/lib/paths.ts';

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
  assert.equal(expandTilde('~'), HOME);
  assert.equal(expandTilde('~/foo'), `${HOME}/foo`);
  assert.equal(expandTilde('~/.env'), `${HOME}/.env`);
});

test('expandTilde: non-tilde paths pass through unchanged', () => {
  assert.equal(expandTilde('./foo'), './foo');
  assert.equal(expandTilde('/absolute/path'), '/absolute/path');
  assert.equal(expandTilde('$HOME/foo'), '$HOME/foo');
  assert.equal(expandTilde(''), '');
});

test('expandTilde: ~user/ syntax is NOT supported (falls through)', () => {
  assert.equal(expandTilde('~alice/secret'), '~alice/secret');
});

test('globToRegex: supports * and ? and escapes metacharacters', () => {
  assert.equal(globToRegex('.env').test('.env'), true);
  assert.equal(globToRegex('.env').test('.environment'), false);
  assert.equal(globToRegex('.env.*').test('.env.local'), true);
  assert.equal(globToRegex('.env.*').test('.env'), false); // star requires ≥1 char
  assert.equal(globToRegex('*.key').test('server.key'), true);
  assert.equal(globToRegex('*.key').test('server.pem'), false);
  assert.equal(globToRegex('?').test('a'), true);
  assert.equal(globToRegex('?').test('ab'), false);
});

test('basenameOf: trailing segment after last sep', () => {
  assert.equal(basenameOf('/a/b/c.txt'), 'c.txt');
  assert.equal(basenameOf('c.txt'), 'c.txt');
  assert.equal(basenameOf('/only-slash/'), '');
});

test('isInsideWorkspace', () => {
  assert.equal(isInsideWorkspace('/tmp/some-project/src/x.ts', CWD_OUTSIDE_HOME), true);
  assert.equal(isInsideWorkspace('/tmp/elsewhere/x.ts', CWD_OUTSIDE_HOME), false);
  assert.equal(isInsideWorkspace(CWD_OUTSIDE_HOME, CWD_OUTSIDE_HOME), false);
});

test('pathContainsSegment: only full path segments trigger', () => {
  assert.equal(pathContainsSegment('/tmp/p/node_modules/foo', 'node_modules'), true);
  assert.equal(pathContainsSegment('/tmp/p/src/node_modules_lookalike/x', 'node_modules'), false);
  assert.equal(pathContainsSegment('/tmp/p/.git/HEAD', '.git'), true);
  assert.equal(pathContainsSegment('/tmp/p/.git', '.git'), true);
  assert.equal(pathContainsSegment('/tmp/p/.github/workflows/ci.yml', '.git'), false);
  assert.equal(pathContainsSegment('/tmp/p/foo', ''), false);
});

test('isUnderPath: prefix match respects path separators', () => {
  assert.equal(isUnderPath('/home/me/.ssh/id_rsa', '/home/me/.ssh'), true);
  assert.equal(isUnderPath('/home/me/.ssh', '/home/me/.ssh'), true);
  assert.equal(isUnderPath('/home/me/.sshkeys', '/home/me/.ssh'), false);
  assert.equal(isUnderPath('/home/me/.ssh/nested/deep', '/home/me/.ssh'), true);
  assert.equal(isUnderPath('/anywhere', ''), false);
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
  assert.deepEqual(merged, {
    basenames: ['.env', '*.key'],
    segments: ['node_modules'],
    paths: ['~/.ssh'],
  });
});

test('mergeRules: empty input → empty rule set', () => {
  assert.deepEqual(mergeRules(), emptyRules());
});

test('mergeRules: coerces non-string array items defensively', () => {
  const merged = mergeRules({ basenames: [123 as unknown as string, '.env'] });
  assert.deepEqual(merged.basenames, ['123', '.env']);
});

test('mergeConfigs: merges read and write independently', () => {
  const merged = mergeConfigs(
    { read: { basenames: ['.env'] } },
    { write: { segments: ['node_modules'] } },
    { read: { paths: ['~/.ssh'] }, write: { basenames: ['*.db'] } },
    undefined,
  );
  assert.deepEqual(merged.read, { basenames: ['.env'], segments: [], paths: ['~/.ssh'] });
  assert.deepEqual(merged.write, { basenames: ['*.db'], segments: ['node_modules'], paths: [] });
});

test('mergeConfigs: empty input → empty config', () => {
  assert.deepEqual(mergeConfigs(), emptyConfig());
});

// ──────────────────────────────────────────────────────────────────────
// DEFAULT_CONFIG
// ──────────────────────────────────────────────────────────────────────

test('DEFAULT_CONFIG: read category gates .env*, .envrc, ~/.ssh', () => {
  assert.ok(DEFAULT_CONFIG.read.basenames.includes('.env'));
  assert.ok(DEFAULT_CONFIG.read.basenames.includes('.env.*'));
  assert.ok(DEFAULT_CONFIG.read.basenames.includes('.envrc'));
  assert.ok(DEFAULT_CONFIG.read.paths.includes('~/.ssh'));
});

test('DEFAULT_CONFIG: write category adds node_modules and .git', () => {
  assert.ok(DEFAULT_CONFIG.write.segments.includes('node_modules'));
  assert.ok(DEFAULT_CONFIG.write.segments.includes('.git'));
});

// ──────────────────────────────────────────────────────────────────────
// classify — low-level
// ──────────────────────────────────────────────────────────────────────

test('classify: path-prefix rule beats outside-workspace for useful detail', () => {
  const rules = { basenames: [], segments: [], paths: ['~/.ssh'] };
  const res = classify('~/.ssh/config', CWD_OUTSIDE_HOME, rules);
  assert.equal(res?.reason, 'path-prefix');
  assert.match(res?.detail ?? '', /~\/\.ssh/);
});

test('classify: checkOutsideWorkspace=false skips the boundary check', () => {
  const rules = emptyRules();
  // With check: outside-workspace fires.
  assert.equal(classify('/etc/hosts', CWD_OUTSIDE_HOME, rules)?.reason, 'outside-workspace');
  // Without: /etc/hosts is fine if no other rule matches.
  assert.equal(classify('/etc/hosts', CWD_OUTSIDE_HOME, rules, { checkOutsideWorkspace: false }), null);
});

test('classify: basename and segment matching against defaults', () => {
  const rules = mergeRules(DEFAULT_CONFIG.read, DEFAULT_CONFIG.write);
  assert.equal(classify('src/.env', CWD_OUTSIDE_HOME, rules)?.reason, 'basename');
  assert.equal(classify('src/.envrc', CWD_OUTSIDE_HOME, rules)?.reason, 'basename');
  assert.equal(classify('src/node_modules/x', CWD_OUTSIDE_HOME, rules)?.reason, 'segment');
  assert.equal(classify('.git/config', CWD_OUTSIDE_HOME, rules)?.reason, 'segment');
});

// ──────────────────────────────────────────────────────────────────────
// classifyRead
// ──────────────────────────────────────────────────────────────────────

test('classifyRead: gates .env / .envrc / ~/.ssh with defaults', () => {
  const c = defaults();
  assert.equal(classifyRead('src/.env', CWD_OUTSIDE_HOME, c)?.reason, 'basename');
  assert.equal(classifyRead('src/.env.local', CWD_OUTSIDE_HOME, c)?.reason, 'basename');
  assert.equal(classifyRead('src/.envrc', CWD_OUTSIDE_HOME, c)?.reason, 'basename');
  assert.equal(classifyRead('~/.ssh/id_rsa', CWD_OUTSIDE_HOME, c)?.reason, 'path-prefix');
  assert.equal(classifyRead('~/.ssh', CWD_OUTSIDE_HOME, c)?.reason, 'path-prefix');
});

test('classifyRead: does NOT gate on outside-workspace', () => {
  const c = defaults();
  // Reading /etc/hosts or a neighboring repo's README is fine by default.
  assert.equal(classifyRead('/etc/hosts', CWD_OUTSIDE_HOME, c), null);
  assert.equal(classifyRead('/tmp/other-project/README.md', CWD_OUTSIDE_HOME, c), null);
  assert.equal(classifyRead('~/notes.txt', CWD_OUTSIDE_HOME, c), null);
});

test('classifyRead: does NOT gate on write-only rules (node_modules, .git)', () => {
  const c = defaults();
  // Reading node_modules / .git contents is routine (inspecting vendored code,
  // git logs via file inspection, etc.) — only writing to them is dangerous.
  assert.equal(classifyRead('node_modules/react/index.js', CWD_OUTSIDE_HOME, c), null);
  assert.equal(classifyRead('.git/HEAD', CWD_OUTSIDE_HOME, c), null);
});

test('classifyRead: ~-expanded paths resolve correctly', () => {
  const c = defaults();
  // Key regression guard: `~/.ssh/config` must NOT become `cwd/~/.ssh/config`.
  assert.equal(classifyRead('~/.ssh/config', CWD_OUTSIDE_HOME, c)?.reason, 'path-prefix');
  assert.equal(classifyRead('~/.env', CWD_OUTSIDE_HOME, c)?.reason, 'basename');
});

// ──────────────────────────────────────────────────────────────────────
// classifyWrite
// ──────────────────────────────────────────────────────────────────────

test('classifyWrite: gates everything read-sensitive PLUS write-only categories', () => {
  const c = defaults();
  // Read-sensitive
  assert.equal(classifyWrite('src/.env', CWD_OUTSIDE_HOME, c)?.reason, 'basename');
  assert.equal(classifyWrite('src/.envrc', CWD_OUTSIDE_HOME, c)?.reason, 'basename');
  assert.equal(classifyWrite('~/.ssh/config', CWD_OUTSIDE_HOME, c)?.reason, 'path-prefix');
  // Write-only
  assert.equal(classifyWrite('src/node_modules/pkg/x.js', CWD_OUTSIDE_HOME, c)?.reason, 'segment');
  assert.equal(classifyWrite('.git/config', CWD_OUTSIDE_HOME, c)?.reason, 'segment');
});

test('classifyWrite: gates outside-workspace', () => {
  const c = defaults();
  assert.equal(classifyWrite('/etc/hosts', CWD_OUTSIDE_HOME, c)?.reason, 'outside-workspace');
  assert.equal(classifyWrite('~/notes.txt', CWD_OUTSIDE_HOME, c)?.reason, 'outside-workspace');
});

test('classifyWrite: clean paths inside workspace pass', () => {
  const c = defaults();
  assert.equal(classifyWrite('./foo.ts', CWD_OUTSIDE_HOME, c), null);
  assert.equal(classifyWrite('src/index.ts', CWD_OUTSIDE_HOME, c), null);
});

test('classifyWrite: ~-expanded paths inside workspace (home-rooted cwd)', () => {
  const c = defaults();
  assert.equal(classifyWrite('~/some-project/src/x.ts', CWD_INSIDE_HOME, c), null);
  assert.equal(classifyWrite('~/some-project/.env', CWD_INSIDE_HOME, c)?.reason, 'basename');
  assert.equal(classifyWrite('~/some-project/node_modules/foo', CWD_INSIDE_HOME, c)?.reason, 'segment');
  assert.equal(classifyWrite('~/other/x.ts', CWD_INSIDE_HOME, c)?.reason, 'outside-workspace');
});

test('classifyWrite: ~user/ falls through as relative path', () => {
  const c = defaults();
  // Documented conservative fallback.
  assert.equal(classifyWrite('~alice/secret', CWD_OUTSIDE_HOME, c), null);
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
  assert.equal(classifyRead('config/secrets.yml', CWD_OUTSIDE_HOME, c)?.reason, 'basename');
  // Read category DIDN'T pick up .terraform (write-only)
  assert.equal(classifyRead('infra/.terraform/state', CWD_OUTSIDE_HOME, c), null);
  // Write category sees both (via read ∪ write)
  assert.equal(classifyWrite('config/secrets.yml', CWD_OUTSIDE_HOME, c)?.reason, 'basename');
  assert.equal(classifyWrite('infra/.terraform/state', CWD_OUTSIDE_HOME, c)?.reason, 'segment');
});

test('custom config: empty config gates only outside-workspace on writes', () => {
  const c = emptyConfig();
  assert.equal(classifyRead('src/.env', CWD_OUTSIDE_HOME, c), null);
  assert.equal(classifyWrite('src/.env', CWD_OUTSIDE_HOME, c), null);
  assert.equal(classifyWrite('/etc/hosts', CWD_OUTSIDE_HOME, c)?.reason, 'outside-workspace');
});
