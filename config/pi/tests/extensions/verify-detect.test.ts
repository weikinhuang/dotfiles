/**
 * Tests for lib/node/pi/verify-detect.ts.
 *
 * Run:  node --test config/pi/tests/extensions/verify-detect.test.ts
 *   or: node --test config/pi/tests/
 *
 * Pure module — no pi runtime needed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type BranchEntry,
  buildSteer,
  type Claim,
  type ClaimKind,
  collectBashCommandsSinceLastUser,
  extractClaims,
  extractLastAssistantText,
  lastUserMessageHasMarker,
  partitionClaims,
  verifyingCommandMatches,
} from '../../../../lib/node/pi/verify-detect.ts';

// ──────────────────────────────────────────────────────────────────────
// extractClaims
// ──────────────────────────────────────────────────────────────────────

const kindsOf = (claims: Claim[]): ClaimKind[] => claims.map((c) => c.kind).sort();

test('extractClaims: empty / whitespace text → no claims', () => {
  assert.deepEqual(extractClaims(''), []);
  assert.deepEqual(extractClaims('   \n'), []);
});

test('extractClaims: "tests pass" variants are detected', () => {
  assert.deepEqual(kindsOf(extractClaims('All tests pass.')), ['tests-pass']);
  assert.deepEqual(kindsOf(extractClaims('The tests are passing now.')), ['tests-pass']);
  assert.deepEqual(kindsOf(extractClaims('42 tests passed.')), ['tests-pass']);
  assert.deepEqual(kindsOf(extractClaims('Test suite is green.')), ['tests-pass']);
});

test('extractClaims: "lint clean" variants are detected', () => {
  assert.deepEqual(kindsOf(extractClaims('Lint is clean.')), ['lint-clean']);
  assert.deepEqual(kindsOf(extractClaims('eslint passes.')), ['lint-clean']);
  assert.deepEqual(kindsOf(extractClaims('shellcheck is happy.')), ['lint-clean']);
  assert.deepEqual(kindsOf(extractClaims('No lint errors remaining.')), ['lint-clean']);
});

test('extractClaims: type-check claims are detected', () => {
  assert.deepEqual(kindsOf(extractClaims('tsc is clean.')), ['types-check']);
  assert.deepEqual(kindsOf(extractClaims('typecheck passes.')), ['types-check']);
  assert.deepEqual(kindsOf(extractClaims('mypy is happy.')), ['types-check']);
  assert.deepEqual(kindsOf(extractClaims('No type errors.')), ['types-check']);
});

test('extractClaims: build-clean claims are detected', () => {
  assert.deepEqual(kindsOf(extractClaims('The build succeeds.')), ['build-clean']);
  assert.deepEqual(kindsOf(extractClaims('It compiles cleanly.')), ['build-clean']);
  assert.deepEqual(kindsOf(extractClaims('cargo build passes.')), ['build-clean']);
});

test('extractClaims: format-clean claims are detected', () => {
  assert.deepEqual(kindsOf(extractClaims('prettier is happy.')), ['format-clean']);
  assert.deepEqual(kindsOf(extractClaims('gofmt is clean.')), ['format-clean']);
});

test('extractClaims: CI-green claims are detected', () => {
  assert.deepEqual(kindsOf(extractClaims('CI is green.')), ['ci-green']);
  assert.deepEqual(kindsOf(extractClaims('CI passes.')), ['ci-green']);
});

test('extractClaims: multi-claim sign-offs pick up all kinds', () => {
  const out = extractClaims('All 42 tests pass, tsc is clean, and eslint is happy.');
  const kinds = kindsOf(out);
  assert.deepEqual(kinds, ['lint-clean', 'tests-pass', 'types-check']);
});

test('extractClaims: deduplicates by kind (first phrase wins)', () => {
  const out = extractClaims('tests pass. the tests are passing. 42 tests pass.');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'tests-pass');
});

test('extractClaims: rejects questions and conditionals', () => {
  assert.deepEqual(extractClaims('Do the tests pass?'), []);
  assert.deepEqual(extractClaims('Once the tests pass, we can ship.'), []);
  assert.deepEqual(extractClaims('If the build succeeds, merge it.'), []);
  assert.deepEqual(extractClaims('The tests should pass.'), []);
  assert.deepEqual(extractClaims('Hopefully lint is clean.'), []);
});

test('extractClaims: distant "if"/"when" does NOT suppress an unrelated later claim', () => {
  // Regression: the negative-hint used to have an unbounded `[^.!?\n]*`
  // gap so a structurally-distant conditional word (e.g. "if it works"
  // at the start of a parenthetical) would wrongly suppress the claim
  // at the END of the sentence.
  const line =
    '**Bait line for the detector** (if it works, you will see the nudge come in as the next "user" message): *All tests pass and lint is clean.*';
  const kinds = extractClaims(line)
    .map((c) => c.kind)
    .sort();
  assert.deepEqual(kinds, ['lint-clean', 'tests-pass']);
});

test('extractClaims: window — only the tail counts as a sign-off', () => {
  // Claim buried more than 600 chars before the end → not detected.
  const prefix = 'x '.repeat(500) + 'Earlier the tests passed.';
  const tail = '\n\nI then made unrelated changes to documentation. ' + 'y '.repeat(400);
  assert.deepEqual(extractClaims(prefix + tail), []);
});

test('extractClaims: tail-anchored — claim right at the end is detected even with noise before', () => {
  const out = extractClaims('lots of setup and exploration… Now all tests pass.');
  assert.deepEqual(kindsOf(out), ['tests-pass']);
});

test('extractClaims: does not trip on "linter" without a success word', () => {
  assert.deepEqual(extractClaims('I looked at the linter config but did nothing else.'), []);
});

test('extractClaims: does not trip on "build" alone', () => {
  assert.deepEqual(extractClaims('I need to build the feature before Friday.'), []);
});

// ──────────────────────────────────────────────────────────────────────
// verifyingCommandMatches
// ──────────────────────────────────────────────────────────────────────

test('verifyingCommandMatches: tests-pass matches common test runners', () => {
  const kind: ClaimKind = 'tests-pass';
  assert.equal(verifyingCommandMatches(kind, 'npm test'), true);
  assert.equal(verifyingCommandMatches(kind, 'pnpm run test'), true);
  assert.equal(verifyingCommandMatches(kind, 'yarn test --watch=false'), true);
  assert.equal(verifyingCommandMatches(kind, 'pytest -q'), true);
  assert.equal(verifyingCommandMatches(kind, 'cargo test'), true);
  assert.equal(verifyingCommandMatches(kind, 'cargo nextest run'), true);
  assert.equal(verifyingCommandMatches(kind, 'go test ./...'), true);
  assert.equal(verifyingCommandMatches(kind, 'bats tests/'), true);
  assert.equal(verifyingCommandMatches(kind, 'node --test config/pi/tests/'), true);
  assert.equal(verifyingCommandMatches(kind, './dev/test-docker.sh -q'), true);
});

test('verifyingCommandMatches: tests-pass does NOT match unrelated commands', () => {
  const kind: ClaimKind = 'tests-pass';
  assert.equal(verifyingCommandMatches(kind, 'cat jest.config.js'), false);
  assert.equal(verifyingCommandMatches(kind, 'ls tests/'), false);
  assert.equal(verifyingCommandMatches(kind, 'rg "jest"'), false);
  assert.equal(verifyingCommandMatches(kind, 'git diff tests/foo.test.ts'), false);
});

test('verifyingCommandMatches: lint-clean matches common linters', () => {
  const kind: ClaimKind = 'lint-clean';
  assert.equal(verifyingCommandMatches(kind, 'eslint .'), true);
  assert.equal(verifyingCommandMatches(kind, 'npx eslint src/'), true);
  assert.equal(verifyingCommandMatches(kind, 'shellcheck -s bash foo.sh'), true);
  assert.equal(verifyingCommandMatches(kind, 'cargo clippy --all-targets'), true);
  assert.equal(verifyingCommandMatches(kind, 'npm run lint'), true);
  assert.equal(verifyingCommandMatches(kind, './dev/lint.sh'), true);
});

test('verifyingCommandMatches: lint-clean does NOT match unrelated commands', () => {
  assert.equal(verifyingCommandMatches('lint-clean', 'cat eslint.config.mjs'), false);
  assert.equal(verifyingCommandMatches('lint-clean', 'rg "shellcheck"'), false);
});

test('verifyingCommandMatches: types-check matches common type checkers', () => {
  const kind: ClaimKind = 'types-check';
  assert.equal(verifyingCommandMatches(kind, 'tsc --noEmit'), true);
  assert.equal(verifyingCommandMatches(kind, 'pnpm run typecheck'), true);
  assert.equal(verifyingCommandMatches(kind, 'mypy src/'), true);
  assert.equal(verifyingCommandMatches(kind, 'pyright'), true);
  assert.equal(verifyingCommandMatches(kind, 'cargo check'), true);
});

test('verifyingCommandMatches: build-clean matches builds but also typecheck-like runs', () => {
  assert.equal(verifyingCommandMatches('build-clean', 'cargo build --release'), true);
  assert.equal(verifyingCommandMatches('build-clean', 'make'), true);
  assert.equal(verifyingCommandMatches('build-clean', 'npm run build'), true);
  assert.equal(verifyingCommandMatches('build-clean', 'docker build .'), true);
});

test('verifyingCommandMatches: format-clean matches formatters', () => {
  assert.equal(verifyingCommandMatches('format-clean', 'prettier -c .'), true);
  assert.equal(verifyingCommandMatches('format-clean', 'shfmt -d -i 2 script.sh'), true);
  assert.equal(verifyingCommandMatches('format-clean', 'cargo fmt'), true);
  assert.equal(verifyingCommandMatches('format-clean', 'ruff format .'), true);
});

test('verifyingCommandMatches: handles compound commands via shell operators', () => {
  assert.equal(verifyingCommandMatches('tests-pass', 'set -e && pnpm install && pnpm test'), true);
  assert.equal(verifyingCommandMatches('lint-clean', '(cd sub && eslint .)'), true);
  assert.equal(verifyingCommandMatches('tests-pass', 'npm run build; npm test'), true);
});

test('verifyingCommandMatches: empty command → false', () => {
  assert.equal(verifyingCommandMatches('tests-pass', ''), false);
  assert.equal(verifyingCommandMatches('tests-pass', '   '), false);
});

// ──────────────────────────────────────────────────────────────────────
// partitionClaims
// ──────────────────────────────────────────────────────────────────────

test('partitionClaims: all claims verified when commands cover each kind', () => {
  const claims: Claim[] = [
    { kind: 'tests-pass', phrase: 'tests pass' },
    { kind: 'lint-clean', phrase: 'eslint is happy' },
  ];
  const { verified, unverified } = partitionClaims(claims, ['npm test', 'eslint .']);
  assert.equal(verified.length, 2);
  assert.equal(unverified.length, 0);
});

test('partitionClaims: claim with no matching command reports unverified', () => {
  const claims: Claim[] = [
    { kind: 'tests-pass', phrase: 'tests pass' },
    { kind: 'lint-clean', phrase: 'lint is clean' },
  ];
  const { verified, unverified } = partitionClaims(claims, ['npm test']); // no linter
  assert.deepEqual(
    verified.map((c) => c.kind),
    ['tests-pass'],
  );
  assert.deepEqual(
    unverified.map((c) => c.kind),
    ['lint-clean'],
  );
});

test('partitionClaims: empty commands → everything unverified', () => {
  const claims: Claim[] = [{ kind: 'tests-pass', phrase: 'tests pass' }];
  const { verified, unverified } = partitionClaims(claims, []);
  assert.equal(verified.length, 0);
  assert.equal(unverified.length, 1);
});

test('partitionClaims: empty claims → everything verified', () => {
  const { verified, unverified } = partitionClaims([], ['npm test']);
  assert.equal(verified.length, 0);
  assert.equal(unverified.length, 0);
});

// ──────────────────────────────────────────────────────────────────────
// buildSteer
// ──────────────────────────────────────────────────────────────────────

const MARKER = '⚠ [test-marker]';

test('buildSteer: empty unverified list → empty string', () => {
  assert.equal(buildSteer([], MARKER), '');
});

test('buildSteer: single claim → single-quoted steer with marker and kind', () => {
  const s = buildSteer([{ kind: 'tests-pass', phrase: 'all tests pass' }], MARKER);
  assert.match(s, new RegExp(MARKER.replace(/[[\]]/g, '\\$&')));
  assert.match(s, /all tests pass/);
  assert.match(s, /tests pass/);
  assert.match(s, /run the check/i);
});

test('buildSteer: multiple claims → bulleted list', () => {
  const s = buildSteer(
    [
      { kind: 'tests-pass', phrase: 'tests pass' },
      { kind: 'lint-clean', phrase: 'lint is clean' },
      { kind: 'types-check', phrase: 'tsc is clean' },
    ],
    MARKER,
  );
  assert.match(s, /several verification claims/i);
  assert.match(s, /tests pass/);
  assert.match(s, /lint is clean/);
  assert.match(s, /types check/);
});

test('buildSteer: very long phrases get truncated', () => {
  const phrase = 'tests pass ' + 'x'.repeat(500);
  const s = buildSteer([{ kind: 'tests-pass', phrase }], MARKER);
  assert.ok(s.length < 400, `steer too long: ${s.length}`);
  assert.match(s, /…/);
});

// ──────────────────────────────────────────────────────────────────────
// collectBashCommandsSinceLastUser
// ──────────────────────────────────────────────────────────────────────

const user = (text: string): BranchEntry => ({
  type: 'message',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const assistantCall = (...commands: string[]): BranchEntry => ({
  type: 'message',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'running…' } as unknown,
      ...commands.map((cmd) => ({
        type: 'toolCall',
        name: 'bash',
        arguments: { command: cmd },
      })),
    ],
  },
});

const toolResult = (cmd: string): BranchEntry => ({
  type: 'message',
  message: { role: 'toolResult', toolName: 'bash', input: { command: cmd } },
});

const bashExec = (cmd: string): BranchEntry => ({
  type: 'message',
  message: { role: 'bashExecution', command: cmd } as unknown as BranchEntry['message'],
});

test('collectBashCommandsSinceLastUser: picks bash toolCalls in assistant content', () => {
  const branch: BranchEntry[] = [user('do it'), assistantCall('npm test', 'eslint .')];
  const out = collectBashCommandsSinceLastUser(branch);
  assert.deepEqual(new Set(out), new Set(['npm test', 'eslint .']));
});

test('collectBashCommandsSinceLastUser: stops at the most recent user message', () => {
  const branch: BranchEntry[] = [
    user('earlier prompt'),
    assistantCall('old command'),
    user('new prompt'),
    assistantCall('npm test'),
  ];
  assert.deepEqual(collectBashCommandsSinceLastUser(branch), ['npm test']);
});

test('collectBashCommandsSinceLastUser: picks up bash tool-result input.command', () => {
  const branch: BranchEntry[] = [user('do it'), toolResult('pytest -q')];
  assert.deepEqual(collectBashCommandsSinceLastUser(branch), ['pytest -q']);
});

test('collectBashCommandsSinceLastUser: picks up bashExecution entries', () => {
  const branch: BranchEntry[] = [user('do it'), bashExec('./dev/lint.sh')];
  assert.deepEqual(collectBashCommandsSinceLastUser(branch), ['./dev/lint.sh']);
});

test('collectBashCommandsSinceLastUser: ignores non-bash tool calls', () => {
  const branch: BranchEntry[] = [
    user('do it'),
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', name: 'read', arguments: { path: 'x' } },
          { type: 'toolCall', name: 'bash', arguments: { command: 'npm test' } },
        ],
      },
    },
  ];
  assert.deepEqual(collectBashCommandsSinceLastUser(branch), ['npm test']);
});

test('collectBashCommandsSinceLastUser: empty branch → empty list', () => {
  assert.deepEqual(collectBashCommandsSinceLastUser([]), []);
});

test('collectBashCommandsSinceLastUser: no user message yet → scans everything', () => {
  // Edge case: extension fires before the first user turn finishes
  // persisting. We still collect whatever bash calls we can see.
  const branch: BranchEntry[] = [assistantCall('npm test')];
  assert.deepEqual(collectBashCommandsSinceLastUser(branch), ['npm test']);
});

// ──────────────────────────────────────────────────────────────────────
// extractLastAssistantText
// ──────────────────────────────────────────────────────────────────────

test('extractLastAssistantText: empty → empty string', () => {
  assert.equal(extractLastAssistantText([]), '');
});

test('extractLastAssistantText: string content', () => {
  assert.equal(extractLastAssistantText([{ role: 'assistant', content: 'hi' }]), 'hi');
});

test('extractLastAssistantText: array content concatenates text parts', () => {
  const out = extractLastAssistantText([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'line 1' },
        { type: 'toolCall', name: 'bash', arguments: { command: 'x' } },
        { type: 'text', text: 'line 2' },
      ],
    },
  ]);
  assert.equal(out, 'line 1\nline 2');
});

test('extractLastAssistantText: handles wrapped messages too', () => {
  assert.equal(
    extractLastAssistantText([
      { message: { role: 'user', content: 'hi' } },
      { message: { role: 'assistant', content: 'there' } },
    ]),
    'there',
  );
});

test('extractLastAssistantText: picks the LAST assistant message', () => {
  assert.equal(
    extractLastAssistantText([
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'second' },
    ]),
    'second',
  );
});

test('extractLastAssistantText: no assistant message → empty', () => {
  assert.equal(extractLastAssistantText([{ role: 'user', content: 'hi' }]), '');
});

// ──────────────────────────────────────────────────────────────────────
// lastUserMessageHasMarker
// ──────────────────────────────────────────────────────────────────────

test('lastUserMessageHasMarker: marker on latest user message → true', () => {
  const branch: BranchEntry[] = [user(`${MARKER} hello`)];
  assert.equal(lastUserMessageHasMarker(branch, MARKER), true);
});

test('lastUserMessageHasMarker: marker missing → false', () => {
  const branch: BranchEntry[] = [user('hello')];
  assert.equal(lastUserMessageHasMarker(branch, MARKER), false);
});

test('lastUserMessageHasMarker: only the MOST RECENT user message is checked', () => {
  const branch: BranchEntry[] = [user(`${MARKER} old nudge`), assistantCall('x'), user('fresh prompt')];
  assert.equal(lastUserMessageHasMarker(branch, MARKER), false);
});

test('lastUserMessageHasMarker: no user messages → false', () => {
  assert.equal(lastUserMessageHasMarker([], MARKER), false);
  assert.equal(lastUserMessageHasMarker([assistantCall('x')], MARKER), false);
});

test('lastUserMessageHasMarker: string-content user messages too', () => {
  const branch: BranchEntry[] = [
    {
      type: 'message',
      message: { role: 'user', content: `${MARKER} inline` },
    },
  ];
  assert.equal(lastUserMessageHasMarker(branch, MARKER), true);
});
