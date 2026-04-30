/**
 * Tests for lib/node/pi/verify-detect.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { expect, test } from 'vitest';
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
  expect(extractClaims('')).toEqual([]);
  expect(extractClaims('   \n')).toEqual([]);
});

test('extractClaims: "tests pass" variants are detected', () => {
  expect(kindsOf(extractClaims('All tests pass.'))).toEqual(['tests-pass']);
  expect(kindsOf(extractClaims('The tests are passing now.'))).toEqual(['tests-pass']);
  expect(kindsOf(extractClaims('42 tests passed.'))).toEqual(['tests-pass']);
  expect(kindsOf(extractClaims('Test suite is green.'))).toEqual(['tests-pass']);
});

test('extractClaims: "lint clean" variants are detected', () => {
  expect(kindsOf(extractClaims('Lint is clean.'))).toEqual(['lint-clean']);
  expect(kindsOf(extractClaims('eslint passes.'))).toEqual(['lint-clean']);
  expect(kindsOf(extractClaims('shellcheck is happy.'))).toEqual(['lint-clean']);
  expect(kindsOf(extractClaims('No lint errors remaining.'))).toEqual(['lint-clean']);
});

test('extractClaims: type-check claims are detected', () => {
  expect(kindsOf(extractClaims('tsc is clean.'))).toEqual(['types-check']);
  expect(kindsOf(extractClaims('typecheck passes.'))).toEqual(['types-check']);
  expect(kindsOf(extractClaims('mypy is happy.'))).toEqual(['types-check']);
  expect(kindsOf(extractClaims('No type errors.'))).toEqual(['types-check']);
});

test('extractClaims: build-clean claims are detected', () => {
  expect(kindsOf(extractClaims('The build succeeds.'))).toEqual(['build-clean']);
  expect(kindsOf(extractClaims('It compiles cleanly.'))).toEqual(['build-clean']);
  expect(kindsOf(extractClaims('cargo build passes.'))).toEqual(['build-clean']);
});

test('extractClaims: format-clean claims are detected', () => {
  expect(kindsOf(extractClaims('prettier is happy.'))).toEqual(['format-clean']);
  expect(kindsOf(extractClaims('gofmt is clean.'))).toEqual(['format-clean']);
});

test('extractClaims: CI-green claims are detected', () => {
  expect(kindsOf(extractClaims('CI is green.'))).toEqual(['ci-green']);
  expect(kindsOf(extractClaims('CI passes.'))).toEqual(['ci-green']);
});

test('extractClaims: multi-claim sign-offs pick up all kinds', () => {
  const out = extractClaims('All 42 tests pass, tsc is clean, and eslint is happy.');
  const kinds = kindsOf(out);

  expect(kinds).toEqual(['lint-clean', 'tests-pass', 'types-check']);
});

test('extractClaims: deduplicates by kind (first phrase wins)', () => {
  const out = extractClaims('tests pass. the tests are passing. 42 tests pass.');

  expect(out.length).toBe(1);
  expect(out[0].kind).toBe('tests-pass');
});

test('extractClaims: rejects questions and conditionals', () => {
  expect(extractClaims('Do the tests pass?')).toEqual([]);
  expect(extractClaims('Once the tests pass, we can ship.')).toEqual([]);
  expect(extractClaims('If the build succeeds, merge it.')).toEqual([]);
  expect(extractClaims('The tests should pass.')).toEqual([]);
  expect(extractClaims('Hopefully lint is clean.')).toEqual([]);
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

  expect(kinds).toEqual(['lint-clean', 'tests-pass']);
});

test('extractClaims: window — only the tail counts as a sign-off', () => {
  // Claim buried more than 600 chars before the end → not detected.
  const prefix = 'x '.repeat(500) + 'Earlier the tests passed.';
  const tail = '\n\nI then made unrelated changes to documentation. ' + 'y '.repeat(400);

  expect(extractClaims(prefix + tail)).toEqual([]);
});

test('extractClaims: tail-anchored — claim right at the end is detected even with noise before', () => {
  const out = extractClaims('lots of setup and exploration… Now all tests pass.');

  expect(kindsOf(out)).toEqual(['tests-pass']);
});

test('extractClaims: does not trip on "linter" without a success word', () => {
  expect(extractClaims('I looked at the linter config but did nothing else.')).toEqual([]);
});

test('extractClaims: does not trip on "build" alone', () => {
  expect(extractClaims('I need to build the feature before Friday.')).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// verifyingCommandMatches
// ──────────────────────────────────────────────────────────────────────

test('verifyingCommandMatches: tests-pass matches common test runners', () => {
  const kind: ClaimKind = 'tests-pass';

  expect(verifyingCommandMatches(kind, 'npm test')).toBe(true);
  expect(verifyingCommandMatches(kind, 'pnpm run test')).toBe(true);
  expect(verifyingCommandMatches(kind, 'yarn test --watch=false')).toBe(true);
  expect(verifyingCommandMatches(kind, 'pytest -q')).toBe(true);
  expect(verifyingCommandMatches(kind, 'cargo test')).toBe(true);
  expect(verifyingCommandMatches(kind, 'cargo nextest run')).toBe(true);
  expect(verifyingCommandMatches(kind, 'go test ./...')).toBe(true);
  expect(verifyingCommandMatches(kind, 'bats tests/')).toBe(true);
  expect(verifyingCommandMatches(kind, 'node --test config/pi/tests/')).toBe(true);
  expect(verifyingCommandMatches(kind, './dev/test-docker.sh -q')).toBe(true);
});

test('verifyingCommandMatches: tests-pass does NOT match unrelated commands', () => {
  const kind: ClaimKind = 'tests-pass';

  expect(verifyingCommandMatches(kind, 'cat jest.config.js')).toBe(false);
  expect(verifyingCommandMatches(kind, 'ls tests/')).toBe(false);
  expect(verifyingCommandMatches(kind, 'rg "jest"')).toBe(false);
  expect(verifyingCommandMatches(kind, 'git diff tests/foo.test.ts')).toBe(false);
});

test('verifyingCommandMatches: lint-clean matches common linters', () => {
  const kind: ClaimKind = 'lint-clean';

  expect(verifyingCommandMatches(kind, 'eslint .')).toBe(true);
  expect(verifyingCommandMatches(kind, 'npx eslint src/')).toBe(true);
  expect(verifyingCommandMatches(kind, 'shellcheck -s bash foo.sh')).toBe(true);
  expect(verifyingCommandMatches(kind, 'cargo clippy --all-targets')).toBe(true);
  expect(verifyingCommandMatches(kind, 'npm run lint')).toBe(true);
  expect(verifyingCommandMatches(kind, './dev/lint.sh')).toBe(true);
});

test('verifyingCommandMatches: lint-clean does NOT match unrelated commands', () => {
  expect(verifyingCommandMatches('lint-clean', 'cat eslint.config.mjs')).toBe(false);
  expect(verifyingCommandMatches('lint-clean', 'rg "shellcheck"')).toBe(false);
});

test('verifyingCommandMatches: types-check matches common type checkers', () => {
  const kind: ClaimKind = 'types-check';

  expect(verifyingCommandMatches(kind, 'tsc --noEmit')).toBe(true);
  expect(verifyingCommandMatches(kind, 'pnpm run typecheck')).toBe(true);
  expect(verifyingCommandMatches(kind, 'mypy src/')).toBe(true);
  expect(verifyingCommandMatches(kind, 'pyright')).toBe(true);
  expect(verifyingCommandMatches(kind, 'cargo check')).toBe(true);
});

test('verifyingCommandMatches: build-clean matches builds but also typecheck-like runs', () => {
  expect(verifyingCommandMatches('build-clean', 'cargo build --release')).toBe(true);
  expect(verifyingCommandMatches('build-clean', 'make')).toBe(true);
  expect(verifyingCommandMatches('build-clean', 'npm run build')).toBe(true);
  expect(verifyingCommandMatches('build-clean', 'docker build .')).toBe(true);
});

test('verifyingCommandMatches: format-clean matches formatters', () => {
  expect(verifyingCommandMatches('format-clean', 'prettier -c .')).toBe(true);
  expect(verifyingCommandMatches('format-clean', 'shfmt -d -i 2 script.sh')).toBe(true);
  expect(verifyingCommandMatches('format-clean', 'cargo fmt')).toBe(true);
  expect(verifyingCommandMatches('format-clean', 'ruff format .')).toBe(true);
});

test('verifyingCommandMatches: handles compound commands via shell operators', () => {
  expect(verifyingCommandMatches('tests-pass', 'set -e && pnpm install && pnpm test')).toBe(true);
  expect(verifyingCommandMatches('lint-clean', '(cd sub && eslint .)')).toBe(true);
  expect(verifyingCommandMatches('tests-pass', 'npm run build; npm test')).toBe(true);
});

test('verifyingCommandMatches: empty command → false', () => {
  expect(verifyingCommandMatches('tests-pass', '')).toBe(false);
  expect(verifyingCommandMatches('tests-pass', '   ')).toBe(false);
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

  expect(verified.length).toBe(2);
  expect(unverified.length).toBe(0);
});

test('partitionClaims: claim with no matching command reports unverified', () => {
  const claims: Claim[] = [
    { kind: 'tests-pass', phrase: 'tests pass' },
    { kind: 'lint-clean', phrase: 'lint is clean' },
  ];
  const { verified, unverified } = partitionClaims(claims, ['npm test']); // no linter

  expect(verified.map((c) => c.kind)).toEqual(['tests-pass']);
  expect(unverified.map((c) => c.kind)).toEqual(['lint-clean']);
});

test('partitionClaims: empty commands → everything unverified', () => {
  const claims: Claim[] = [{ kind: 'tests-pass', phrase: 'tests pass' }];
  const { verified, unverified } = partitionClaims(claims, []);

  expect(verified.length).toBe(0);
  expect(unverified.length).toBe(1);
});

test('partitionClaims: empty claims → everything verified', () => {
  const { verified, unverified } = partitionClaims([], ['npm test']);

  expect(verified.length).toBe(0);
  expect(unverified.length).toBe(0);
});

// ──────────────────────────────────────────────────────────────────────
// buildSteer
// ──────────────────────────────────────────────────────────────────────

const MARKER = '⚠ [test-marker]';

test('buildSteer: empty unverified list → empty string', () => {
  expect(buildSteer([], MARKER)).toBe('');
});

test('buildSteer: single claim → single-quoted steer with marker and kind', () => {
  const s = buildSteer([{ kind: 'tests-pass', phrase: 'all tests pass' }], MARKER);

  expect(s).toMatch(new RegExp(MARKER.replace(/[[\]]/g, '\\$&')));
  expect(s).toMatch(/all tests pass/);
  expect(s).toMatch(/tests pass/);
  expect(s).toMatch(/run the check/i);
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

  expect(s).toMatch(/several verification claims/i);
  expect(s).toMatch(/tests pass/);
  expect(s).toMatch(/lint is clean/);
  expect(s).toMatch(/types check/);
});

test('buildSteer: very long phrases get truncated', () => {
  const phrase = 'tests pass ' + 'x'.repeat(500);
  const s = buildSteer([{ kind: 'tests-pass', phrase }], MARKER);

  expect(s.length).toBeLessThan(400);
  expect(s).toMatch(/…/);
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

  expect(new Set(out)).toEqual(new Set(['npm test', 'eslint .']));
});

test('collectBashCommandsSinceLastUser: stops at the most recent user message', () => {
  const branch: BranchEntry[] = [
    user('earlier prompt'),
    assistantCall('old command'),
    user('new prompt'),
    assistantCall('npm test'),
  ];

  expect(collectBashCommandsSinceLastUser(branch)).toEqual(['npm test']);
});

test('collectBashCommandsSinceLastUser: picks up bash tool-result input.command', () => {
  const branch: BranchEntry[] = [user('do it'), toolResult('pytest -q')];

  expect(collectBashCommandsSinceLastUser(branch)).toEqual(['pytest -q']);
});

test('collectBashCommandsSinceLastUser: picks up bashExecution entries', () => {
  const branch: BranchEntry[] = [user('do it'), bashExec('./dev/lint.sh')];

  expect(collectBashCommandsSinceLastUser(branch)).toEqual(['./dev/lint.sh']);
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

  expect(collectBashCommandsSinceLastUser(branch)).toEqual(['npm test']);
});

test('collectBashCommandsSinceLastUser: empty branch → empty list', () => {
  expect(collectBashCommandsSinceLastUser([])).toEqual([]);
});

test('collectBashCommandsSinceLastUser: no user message yet → scans everything', () => {
  // Edge case: extension fires before the first user turn finishes
  // persisting. We still collect whatever bash calls we can see.
  const branch: BranchEntry[] = [assistantCall('npm test')];

  expect(collectBashCommandsSinceLastUser(branch)).toEqual(['npm test']);
});

// ──────────────────────────────────────────────────────────────────────
// extractLastAssistantText
// ──────────────────────────────────────────────────────────────────────

test('extractLastAssistantText: empty → empty string', () => {
  expect(extractLastAssistantText([])).toBe('');
});

test('extractLastAssistantText: string content', () => {
  expect(extractLastAssistantText([{ role: 'assistant', content: 'hi' }])).toBe('hi');
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

  expect(out).toBe('line 1\nline 2');
});

test('extractLastAssistantText: handles wrapped messages too', () => {
  expect(
    extractLastAssistantText([
      { message: { role: 'user', content: 'hi' } },
      { message: { role: 'assistant', content: 'there' } },
    ]),
  ).toBe('there');
});

test('extractLastAssistantText: picks the LAST assistant message', () => {
  expect(
    extractLastAssistantText([
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'second' },
    ]),
  ).toBe('second');
});

test('extractLastAssistantText: no assistant message → empty', () => {
  expect(extractLastAssistantText([{ role: 'user', content: 'hi' }])).toBe('');
});

// ──────────────────────────────────────────────────────────────────────
// lastUserMessageHasMarker
// ──────────────────────────────────────────────────────────────────────

test('lastUserMessageHasMarker: marker on latest user message → true', () => {
  const branch: BranchEntry[] = [user(`${MARKER} hello`)];

  expect(lastUserMessageHasMarker(branch, MARKER)).toBe(true);
});

test('lastUserMessageHasMarker: marker missing → false', () => {
  const branch: BranchEntry[] = [user('hello')];

  expect(lastUserMessageHasMarker(branch, MARKER)).toBe(false);
});

test('lastUserMessageHasMarker: only the MOST RECENT user message is checked', () => {
  const branch: BranchEntry[] = [user(`${MARKER} old nudge`), assistantCall('x'), user('fresh prompt')];

  expect(lastUserMessageHasMarker(branch, MARKER)).toBe(false);
});

test('lastUserMessageHasMarker: no user messages → false', () => {
  expect(lastUserMessageHasMarker([], MARKER)).toBe(false);
  expect(lastUserMessageHasMarker([assistantCall('x')], MARKER)).toBe(false);
});

test('lastUserMessageHasMarker: string-content user messages too', () => {
  const branch: BranchEntry[] = [
    {
      type: 'message',
      message: { role: 'user', content: `${MARKER} inline` },
    },
  ];

  expect(lastUserMessageHasMarker(branch, MARKER)).toBe(true);
});
