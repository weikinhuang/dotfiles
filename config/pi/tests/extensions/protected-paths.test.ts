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
  containsNodeModules,
  expandTilde,
  globToRegex,
  isInsideWorkspace,
} from '../../extensions/lib/paths.ts';

const HOME = homedir();
const CWD_INSIDE_HOME = `${HOME}/some-project`;
const CWD_OUTSIDE_HOME = '/tmp/some-project';

// ──────────────────────────────────────────────────────────────────────
// expandTilde
// ──────────────────────────────────────────────────────────────────────

test('expandTilde: bare ~ and ~/foo', () => {
  assert.equal(expandTilde('~'), HOME);
  assert.equal(expandTilde('~/foo'), `${HOME}/foo`);
  assert.equal(expandTilde('~/.env'), `${HOME}/.env`);
});

test('expandTilde: non-tilde paths pass through unchanged', () => {
  assert.equal(expandTilde('./foo'), './foo');
  assert.equal(expandTilde('/absolute/path'), '/absolute/path');
  assert.equal(expandTilde('$HOME/foo'), '$HOME/foo'); // env vars NOT expanded
  assert.equal(expandTilde(''), '');
});

test('expandTilde: ~user/ syntax is NOT supported (falls through)', () => {
  assert.equal(expandTilde('~alice/secret'), '~alice/secret');
});

// ──────────────────────────────────────────────────────────────────────
// globToRegex
// ──────────────────────────────────────────────────────────────────────

test('globToRegex: supports * and ? and escapes metacharacters', () => {
  assert.equal(globToRegex('.env').test('.env'), true);
  assert.equal(globToRegex('.env').test('.environment'), false);
  assert.equal(globToRegex('.env.*').test('.env.local'), true);
  assert.equal(globToRegex('.env.*').test('.env.production'), true);
  assert.equal(globToRegex('.env.*').test('.env'), false); // star requires ≥1 char
  assert.equal(globToRegex('.env.*').test('.environment'), false);
  assert.equal(globToRegex('*.key').test('server.key'), true);
  assert.equal(globToRegex('*.key').test('server.pem'), false);
  assert.equal(globToRegex('?').test('a'), true);
  assert.equal(globToRegex('?').test('ab'), false);
});

// ──────────────────────────────────────────────────────────────────────
// basenameOf / isInsideWorkspace / containsNodeModules
// ──────────────────────────────────────────────────────────────────────

test('basenameOf: trailing segment after last sep', () => {
  assert.equal(basenameOf('/a/b/c.txt'), 'c.txt');
  assert.equal(basenameOf('c.txt'), 'c.txt');
  assert.equal(basenameOf('/only-slash/'), '');
});

test('isInsideWorkspace', () => {
  assert.equal(isInsideWorkspace('/tmp/some-project/src/x.ts', CWD_OUTSIDE_HOME), true);
  assert.equal(isInsideWorkspace('/tmp/elsewhere/x.ts', CWD_OUTSIDE_HOME), false);
  assert.equal(isInsideWorkspace('/etc/hosts', CWD_OUTSIDE_HOME), false);
  // cwd itself is not "inside" — keeps the classifier from allowing writes
  // to the bare cwd directory path.
  assert.equal(isInsideWorkspace(CWD_OUTSIDE_HOME, CWD_OUTSIDE_HOME), false);
});

test('containsNodeModules: only a full path segment triggers, inside workspace only', () => {
  assert.equal(containsNodeModules('/tmp/some-project/node_modules/foo', CWD_OUTSIDE_HOME), true);
  assert.equal(containsNodeModules('/tmp/some-project/src/node_modules/foo.ts', CWD_OUTSIDE_HOME), true);
  assert.equal(containsNodeModules('/tmp/some-project/src/node_modules_lookalike/foo.ts', CWD_OUTSIDE_HOME), false);
  assert.equal(containsNodeModules('/tmp/some-project/src/foo.ts', CWD_OUTSIDE_HOME), false);
  // outside-workspace → not flagged as node-modules (outside-workspace is the right reason)
  assert.equal(containsNodeModules('/etc/node_modules/foo', CWD_OUTSIDE_HOME), false);
});

// ──────────────────────────────────────────────────────────────────────
// classify — the main gate logic
// ──────────────────────────────────────────────────────────────────────

test('classify: ~-expanded paths outside workspace are caught', () => {
  // When home is outside cwd, ~/.env escapes the workspace → outside-workspace
  // wins over env-file (stricter check first).
  assert.equal(classify('~/.env', CWD_OUTSIDE_HOME, [])?.reason, 'outside-workspace');
  assert.equal(classify('~/.env.local', CWD_OUTSIDE_HOME, [])?.reason, 'outside-workspace');
  assert.equal(classify('~/config/foo.txt', CWD_OUTSIDE_HOME, [])?.reason, 'outside-workspace');
  assert.equal(classify('~', CWD_OUTSIDE_HOME, [])?.reason, 'outside-workspace');
  // The key regression guard: "~/sensitive.txt" must NOT resolve to
  // "<cwd>/~/sensitive.txt" and be treated as inside the workspace.
  assert.equal(classify('~/sensitive.txt', CWD_OUTSIDE_HOME, [])?.reason, 'outside-workspace');
});

test('classify: ~-expanded paths inside workspace (home-rooted cwd)', () => {
  assert.equal(classify('~/some-project/src/x.ts', CWD_INSIDE_HOME, []), null);
  assert.equal(classify('~/some-project/.env', CWD_INSIDE_HOME, [])?.reason, 'env-file');
  assert.equal(classify('~/some-project/node_modules/foo', CWD_INSIDE_HOME, [])?.reason, 'node-modules');
  assert.equal(classify('~/other/x.ts', CWD_INSIDE_HOME, [])?.reason, 'outside-workspace');
});

test('classify: relative and absolute paths', () => {
  assert.equal(classify('./foo.ts', CWD_OUTSIDE_HOME, []), null);
  assert.equal(classify('/etc/hosts', CWD_OUTSIDE_HOME, [])?.reason, 'outside-workspace');
  assert.equal(classify('src/.env', CWD_OUTSIDE_HOME, [])?.reason, 'env-file');
  assert.equal(classify('src/node_modules/x', CWD_OUTSIDE_HOME, [])?.reason, 'node-modules');
});

test('classify: ~user/ falls through and is treated as a relative path', () => {
  // Documented conservative fallback; LLMs almost never emit this form.
  assert.equal(classify('~alice/secret', CWD_OUTSIDE_HOME, []), null);
});

test('classify: extra globs only match when path is inside workspace', () => {
  const extras = [globToRegex('secrets.yml')];
  assert.equal(classify('~/some-project/secrets.yml', CWD_INSIDE_HOME, extras)?.reason, 'extra-glob');
  // Outside-workspace wins over extra-glob.
  assert.equal(classify('~/secrets.yml', CWD_OUTSIDE_HOME, extras)?.reason, 'outside-workspace');
});
