/**
 * Pure helpers for the verify-before-claim extension.
 *
 * No pi imports - testable under `vitest`.
 *
 * The extension's job is to detect when the model signs off with a
 * verification claim ("tests pass", "lint is clean", "it builds", …)
 * WITHOUT having actually run the check in this turn. It's a
 * generalization of the todo extension's completion-claim guardrail,
 * scoped to a narrower, much more common failure mode: weaker models
 * (and some stronger ones in a hurry) love to *assert* that things
 * work when they've only *inspected* them.
 *
 * Signal shape:
 *
 *   1. `extractClaims(text)` scans the TAIL of the assistant's final
 *      message for typed claim phrases (each mapped to a
 *      `ClaimKind`). Phrase matching is anchored to the last ~600
 *      chars so we only flag claims in the sign-off, not past-tense
 *      narration ("earlier I saw the tests pass"). Questions and
 *      conditionals are rejected outright.
 *
 *   2. `verifyingCommandMatches(kind, command)` returns true when the
 *      given shell command looks like it would verify a claim of
 *      `kind`. E.g. `tests-pass` → `jest`, `vitest`, `pytest`,
 *      `cargo test`, `go test`, `mocha`, `npm test`, `bats`, `bun
 *      test`, … The matcher is intentionally liberal: false positives
 *      (we think a claim was verified when it wasn't) merely suppress
 *      the nudge, false negatives (we nag when the check *was* run)
 *      are annoying but safe. We err toward liberal.
 *
 *   3. `buildSteer(unverifiedClaims, marker)` renders the follow-up
 *      user message carrying the sentinel. The extension fires it
 *      via `sendUserMessage(..., { deliverAs: 'followUp' })` when
 *      there are unverified claims AND the previous user message
 *      doesn't already carry the marker.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseJsonc } from './jsonc.ts';
import { truncate } from './shared.ts';

/** The categories of claim we recognize. */
export type ClaimKind = 'tests-pass' | 'lint-clean' | 'types-check' | 'build-clean' | 'format-clean' | 'ci-green';

export interface Claim {
  kind: ClaimKind;
  /** The text that matched - surfaced in the steer so the model knows what we're calling out. */
  phrase: string;
}

// ──────────────────────────────────────────────────────────────────────
// Phrase detection (claims)
// ──────────────────────────────────────────────────────────────────────

/**
 * One entry per claim kind. The regex runs against the TAIL of the
 * assistant's final message (see `extractClaims`). Anchoring to the tail
 * keeps false positives low without forcing an explicit `$` anchor on
 * every pattern - the scan window already bounds where the match must
 * appear.
 *
 * Patterns use word-boundaries on both sides of the keyword so e.g.
 * "linter" doesn't trip the `lint-clean` pattern and "build" (as a noun)
 * doesn't trip `build-clean` without a success word attached.
 */
interface PatternEntry {
  kind: ClaimKind;
  re: RegExp;
}

const CLAIM_PATTERNS: readonly PatternEntry[] = [
  // Tests pass / all tests green / tests are passing / X tests pass.
  {
    kind: 'tests-pass',
    re: /\b(?:all\s+)?(?:the\s+)?(?:unit|integration|e2e|bats)?\s*tests?\s+(?:are\s+)?(?:now\s+)?(?:all\s+)?(?:pass(?:ing|ed|es)?|green|succeed(?:ed|ing)?|ok)\b/i,
  },
  { kind: 'tests-pass', re: /\b(?:test\s+suite|test\s+run)\s+(?:passes|passed|is\s+green|succeeded)\b/i },
  { kind: 'tests-pass', re: /\b\d+\s+tests?\s+(?:pass(?:ed|ing)?|green)\b/i },
  // Lint clean / no lint errors / lints? passes.
  {
    kind: 'lint-clean',
    re: /\b(?:lint(?:er|ing)?|eslint|shellcheck|ruff|pylint|rubocop|clippy)\s+(?:is\s+)?(?:now\s+)?(?:all\s+)?(?:clean|green|passes|passed|ok|happy|succeed(?:ed|s)?)\b/i,
  },
  {
    kind: 'lint-clean',
    re: /\bno\s+(?:more\s+)?(?:lint|eslint|shellcheck|ruff|clippy|rubocop)\s+(?:errors?|warnings?|issues?|complaints?)\b/i,
  },
  // Types check / typechecks / no type errors / tsc is clean.
  {
    kind: 'types-check',
    re: /\b(?:type[\s-]?check(?:s|ing|ed)?|typecheck)\s+(?:now\s+)?(?:passes|passed|is\s+clean|is\s+green|succeeded|ok)\b/i,
  },
  {
    kind: 'types-check',
    re: /\b(?:tsc|mypy|pyright|pyre|flow|ts-check)\s+(?:is\s+)?(?:now\s+)?(?:clean|green|passes|passed|ok|happy|succeed(?:ed|s)?)\b/i,
  },
  { kind: 'types-check', re: /\bno\s+(?:more\s+)?(?:type|typescript|tsc|mypy)\s+(?:errors?|issues?)\b/i },
  // Build clean / builds successfully / compiles / make passes.
  {
    kind: 'build-clean',
    re: /\b(?:the\s+)?build\s+(?:now\s+)?(?:succeed(?:ed|s)?|passes|passed|is\s+clean|is\s+green|works?)\b/i,
  },
  {
    kind: 'build-clean',
    re: /\b(?:it\s+|the\s+code\s+|project\s+)?(?:compiles|builds)(?:\s+(?:cleanly|successfully|without\s+errors?|fine))\b/i,
  },
  {
    kind: 'build-clean',
    re: /\b(?:cargo\s+build|go\s+build|make|mvn|gradle|npm\s+run\s+build)\s+(?:now\s+)?(?:succeed(?:ed|s)?|passes|passed|is\s+clean|works?)\b/i,
  },
  // Format clean / prettier happy / gofmt clean.
  {
    kind: 'format-clean',
    re: /\b(?:format(?:ting|ter)?|prettier|oxfmt|gofmt|shfmt|black|rustfmt|biome)\s+(?:is\s+)?(?:now\s+)?(?:clean|passes|passed|ok|happy)\b/i,
  },
  // CI green / CI passes.
  { kind: 'ci-green', re: /\bCI\s+(?:is\s+)?(?:now\s+)?(?:green|passing|passes|passed|clean)\b/i },
];

/** Phrases that negate a claim even if a keyword matches. */
// The conditional word and the verification verb must be within a short
// window of each other. Unbounded `[^.!?\n]*` was too aggressive and
// false-positived on sentences like
//   “if it works, you'll see … next message: *All tests pass*”
// where a far-away “if” has nothing to do with the actual sign-off.
// Real conditionals (“if the build succeeds”, “when the tests pass”,
// “should pass”, “Hopefully lint is clean”) put the two within ~11
// chars; the 40-char cap keeps those rejected while freeing sentences
// where “if” is structurally distant from the claim.
const NEGATIVE_HINT_RE =
  /\?\s*[)"'*_`~\s]*$|\b(?:when|once|after|if|whether|until|should|would|could|might|expect(?:ed)?\s+to|presumably|hopefully|likely)\b[^.!?\n]{0,40}?\b(?:pass(?:es|ed|ing)?|clean|green|succeed(?:ed|s)?|typechecks?|builds?|compiles?|format(?:ted|s)?)\b/i;

// ──────────────────────────────────────────────────────────────────────

/**
 * Heuristic: does the tail of `text` contain one or more verification
 * claims? Returns a deduplicated list of `Claim` (by kind, keeping the
 * first phrase seen).
 *
 * Scans only the last 600 characters of the message - claims live in
 * the sign-off, and bounding the window is what lets us avoid past-tense
 * false positives ("earlier the tests were passing, but then I changed
 * X").
 */
export function extractClaims(text: string): Claim[] {
  if (!text) return [];
  const tail = text.slice(-600);
  if (!tail.trim()) return [];

  // Per-sentence conditional rejection. Testing NEGATIVE_HINT_RE against
  // the whole tail was too coarse - a conditional in one clause would
  // suppress an unconditional claim in a later clause of the same tail
  // ("If tests pass quickly, we ship. Anyway, all tests pass."). Split
  // on sentence terminators, keep each fragment's conditional check
  // local, and harvest claims from the non-conditional fragments.
  const sentences = tail.split(/(?<=[.!?])\s+/);
  const found = new Map<ClaimKind, string>();
  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    if (NEGATIVE_HINT_RE.test(sentence)) continue;
    for (const entry of CLAIM_PATTERNS) {
      if (found.has(entry.kind)) continue;
      const m = entry.re.exec(sentence);
      if (!m) continue;
      found.set(entry.kind, m[0]);
    }
  }
  return Array.from(found.entries()).map(([kind, phrase]) => ({ kind, phrase }));
}

// ──────────────────────────────────────────────────────────────────────
// Command matchers - "did the model run something that would verify
// the claim?"
// ──────────────────────────────────────────────────────────────────────

/**
 * Patterns that indicate the bash command (as a single string, possibly
 * containing `&&`, `||`, `;`, `|`, quoting, flags) ran a verifier for
 * the named kind.
 *
 * Liberal on purpose: see the module header. The patterns are designed
 * to match typical invocations across ecosystems without being so loose
 * that merely referencing a tool name counts (e.g. `cat jest.config.js`
 * must NOT count as running jest).
 *
 * The general shape is: "<tool>(<space or end>)" - we require a word
 * boundary after the tool so `jestlike` / `pytestify` don't match, and
 * we include common sub-commands (`npm test`, `cargo test`, `go test`)
 * as two-token phrases.
 */
// Command start anchor: start of string, or after whitespace / shell
// separator / opening paren. Used before a tool name so `cat foo` or
// `--config=bar` can't masquerade as the tool itself.
const CMD_START = '(?:^|[\\s&|;(])';
// Command end anchor: whitespace, end of string, or shell separator.
// We explicitly exclude `.` so `jest.config.js` does NOT match `jest`
// (which `\b` would, because `.` is a word boundary).
const CMD_END = '(?=\\s|$|[&|;)<>])';

const COMMAND_PATTERNS: Record<ClaimKind, readonly RegExp[]> = {
  'tests-pass': [
    new RegExp(`${CMD_START}(?:npx\\s+|pnpm\\s+|yarn\\s+|bun\\s+|deno\\s+)?jest${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:npx\\s+|pnpm\\s+|yarn\\s+|bun\\s+)?vitest${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:npx\\s+|pnpm\\s+|yarn\\s+|bun\\s+)?mocha${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}pytest${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:python\\s+-m\\s+)?unittest${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}cargo\\s+(?:nextest\\s+(?:run|test)|test|t)${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}go\\s+test${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:ctest|gtest)${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}rspec${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:rake|bundle\\s+exec\\s+rake)\\s+(?:test|spec)${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:npm|pnpm|yarn|bun|deno)\\s+(?:run\\s+)?(?:test|t)${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}bats${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:phpunit|pest)${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}swift\\s+test${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}dotnet\\s+test${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}mix\\s+test${CMD_END}`, 'i'),
    new RegExp(
      `${CMD_START}(?:\\.\\/)?(?:dev\\/test|bin\\/test|script\\/test|run-tests?)(?:[-_a-z0-9]*)?(?:\\.sh|\\.bats)?${CMD_END}`,
      'i',
    ),
    new RegExp(`${CMD_START}(?:\\.\\/)?[\\w./-]*test[-_]?docker\\.sh${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:\\.\\/)?[\\w./-]*(?:^|\\/)test\\.sh${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}node\\s+--test\\b`, 'i'),
  ],
  'lint-clean': [
    new RegExp(`${CMD_START}(?:npx\\s+|pnpm\\s+|yarn\\s+|bun\\s+)?eslint${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}shellcheck${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}shfmt${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}ruff${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}pylint${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}flake8${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}rubocop${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}cargo\\s+clippy${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?lint${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}go\\s+vet${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}golangci-lint${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}biome\\s+(?:lint|check)${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:\\.\\/)?(?:dev\\/lint|bin\\/lint|script\\/lint)(?:\\.sh)?${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:\\.\\/)?[\\w./-]*(?:^|\\/)lint\\.sh${CMD_END}`, 'i'),
  ],
  'types-check': [
    new RegExp(`${CMD_START}(?:npx\\s+|pnpm\\s+|yarn\\s+|bun\\s+)?tsc${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:npx\\s+|pnpm\\s+|yarn\\s+|bun\\s+)?tsgo${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}mypy${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}pyright${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}pyre${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}flow\\s+(?:check|status)${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:typecheck|type-check|check)${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}cargo\\s+check${CMD_END}`, 'i'),
  ],
  'build-clean': [
    new RegExp(`${CMD_START}cargo\\s+build${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}go\\s+build${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}make${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}mvn${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}gradle${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}bazel\\s+build${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:npm|pnpm|yarn|bun|deno)\\s+(?:run\\s+)?build${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}tsc${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}dotnet\\s+build${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}swift\\s+build${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}mix\\s+compile${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}meson\\s+compile${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}ninja${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}cmake\\s+--build${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}docker\\s+build${CMD_END}`, 'i'),
  ],
  'format-clean': [
    new RegExp(`${CMD_START}prettier${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}oxfmt${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}shfmt${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}gofmt${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:rustfmt|cargo\\s+fmt)${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}black${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}ruff\\s+format${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}biome\\s+format${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:format|fmt)${CMD_END}`, 'i'),
    // Meta-scripts that conventionally bundle lint + format (shellcheck + shfmt,
    // eslint + oxfmt, etc.). Running `./dev/lint.sh` or `npm run lint` almost
    // always means formatting is checked too; accepting them for `format-clean`
    // is a deliberate false-negative-suppression call -- the cost of missing a
    // real over-claim is lower than nagging every time the user runs a lint
    // wrapper. Projects that truly keep lint and format separate can opt out
    // via the `commandSatisfies` config layer.
    new RegExp(`${CMD_START}(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?lint${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:\\.\\/)?(?:dev\\/lint|bin\\/lint|script\\/lint)(?:\\.sh)?${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}(?:\\.\\/)?[\\w./-]*(?:^|\\/)lint\\.sh${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}make\\s+(?:lint|check|format|fmt)${CMD_END}`, 'i'),
  ],
  'ci-green': [
    new RegExp(`${CMD_START}gh\\s+(?:run|pr)\\s+(?:view|list|checks)${CMD_END}`, 'i'),
    new RegExp(`${CMD_START}act${CMD_END}`, 'i'), // local-CI runner
  ],
};

/**
 * Does `command` look like it would verify a claim of `kind`? The test
 * is liberal - see the module header.
 *
 * Optional `extras`: user-supplied rules that augment the built-in
 * matchers. Each rule names a command-prefix regex plus the set of
 * claim kinds the command satisfies. Example: `{ pattern: "^./dev/lint\\.sh\\b", kinds: ["lint-clean", "format-clean"] }`
 * tells us a single `./dev/lint.sh` invocation counts as both.
 */
export function verifyingCommandMatches(
  kind: ClaimKind,
  command: string,
  extras: readonly CompiledSatisfyRule[] = [],
): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  const patterns = COMMAND_PATTERNS[kind];
  for (const re of patterns) {
    if (re.test(cmd)) return true;
  }
  for (const rule of extras) {
    if (!rule.kinds.has(kind)) continue;
    if (rule.re.test(cmd)) return true;
  }
  return false;
}

/**
 * Partition `claims` into (verified, unverified) based on whether any
 * of `commands` looks like a verifier for each claim's kind. A claim
 * without any matching command is reported as unverified.
 *
 * `extras` lets callers contribute user-configured rules (see
 * `loadSatisfyRules`).
 */
export function partitionClaims(
  claims: readonly Claim[],
  commands: readonly string[],
  extras: readonly CompiledSatisfyRule[] = [],
): { verified: Claim[]; unverified: Claim[] } {
  const verified: Claim[] = [];
  const unverified: Claim[] = [];
  for (const claim of claims) {
    const ok = commands.some((c) => verifyingCommandMatches(claim.kind, c, extras));
    (ok ? verified : unverified).push(claim);
  }
  return { verified, unverified };
}

// ──────────────────────────────────────────────────────────────────────
// Steer builder
// ──────────────────────────────────────────────────────────────────────

const HUMAN_KIND: Record<ClaimKind, string> = {
  'tests-pass': 'tests pass',
  'lint-clean': 'lint is clean',
  'types-check': 'types check',
  'build-clean': 'the build is clean',
  'format-clean': 'formatting is clean',
  'ci-green': 'CI is green',
};

/**
 * Build the follow-up user message for the extension to inject when
 * claims go unverified. Carries `marker` as a sentinel so the extension
 * can detect its own prior injections and avoid double-firing.
 */
export function buildSteer(unverified: readonly Claim[], marker: string): string {
  if (unverified.length === 0) return '';
  const parts: string[] = [marker];
  if (unverified.length === 1) {
    const c = unverified[0];
    parts.push(
      `You claimed "${truncate(c.phrase, 80, { trim: true })}" (${HUMAN_KIND[c.kind]}), but I don't see a tool call that would have verified it in this turn.`,
    );
  } else {
    parts.push("You made several verification claims I can't cross-check against your tool calls in this turn:");
    for (const c of unverified) {
      parts.push(`  - ${HUMAN_KIND[c.kind]} - "${truncate(c.phrase, 80, { trim: true })}"`);
    }
  }
  parts.push(
    'Either run the check and report the real outcome, or retract the claim and tell the user what you actually did.',
  );
  return parts.join(' ');
}

// ──────────────────────────────────────────────────────────────────────
// Branch / message helpers
//
// Duck-typed so the extension can pass raw session entries and assistant
// messages without us depending on pi's Session types.
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal shape of a session branch entry. We only touch the fields we
 * need (role, content, toolName, input) so tests can fabricate fakes.
 */
export interface BranchEntry {
  readonly type?: string;
  readonly message?: {
    readonly role?: string;
    readonly toolName?: string;
    readonly content?: unknown;
    readonly input?: unknown;
    readonly details?: unknown;
  };
}

/**
 * Tool names whose `arguments.command` / `input.command` carry a
 * shell line we should treat as a verifier candidate. `bash` is the
 * harness's foreground exec tool; `bg_bash` is the
 * `config/pi/extensions/bg-bash.ts` extension's start-a-job action,
 * which puts the literal shell line in the same `command` slot. From
 * the verify-before-claim perspective they're equivalent - both
 * prove the model actually ran the verifier in this turn.
 *
 * `bg_bash`'s other actions (`wait`, `logs`, `signal`, …) don't
 * carry a `command` argument, so they fall through the
 * `typeof === 'string'` guard below and contribute nothing - same
 * way a bare `bash` call with an empty command would.
 */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'bg_bash']);

/**
 * Walk `branch` BACKWARDS from the leaf and collect every bash
 * command executed since the most recent user message. Returns them
 * in reverse order (doesn't matter for the extension's use - we pass
 * the list to `partitionClaims` which scans all of them).
 *
 * We look at three kinds of source:
 *   - Assistant messages with `toolCall` content parts whose name is
 *     in `SHELL_TOOL_NAMES` (`bash` / `bg_bash`) - the command
 *     lives in `arguments.command`.
 *   - Tool-result messages for those same tool names with an
 *     `input.command` on them (some pi versions record the
 *     invocation on the result side).
 *   - `bashExecution` messages (user-invoked `!cmd`) carrying their
 *     shell line in `command`.
 *
 * The scan stops at the previous user message so we only report what
 * THIS turn actually ran. Any earlier bash call doesn't count.
 */
export function collectBashCommandsSinceLastUser(branch: readonly BranchEntry[]): string[] {
  const out: string[] = [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    const msg = entry.message;
    if (!msg) continue;
    if (msg.role === 'user') break;
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const raw of msg.content) {
        if (!raw || typeof raw !== 'object') continue;
        const c = raw as { type?: string; name?: string; arguments?: { command?: unknown } };
        if (c.type !== 'toolCall') continue;
        if (typeof c.name !== 'string' || !SHELL_TOOL_NAMES.has(c.name)) continue;
        const cmd = typeof c.arguments?.command === 'string' ? c.arguments.command : '';
        if (cmd.trim()) out.push(cmd);
      }
    } else if (msg.role === 'toolResult' && typeof msg.toolName === 'string' && SHELL_TOOL_NAMES.has(msg.toolName)) {
      const input = msg.input as { command?: unknown } | undefined;
      const cmd = typeof input?.command === 'string' ? input.command : '';
      if (cmd.trim()) out.push(cmd);
    } else if (entry.type === 'message' && msg.role === 'bashExecution') {
      // Pi also records user-triggered `!cmd` and tool bash via a
      // dedicated `bashExecution` message. Treat those as verifiers
      // too - the user may have run `npm test` inline before the model
      // claimed success.
      const ex = msg as unknown as { command?: unknown };
      const cmd = typeof ex.command === 'string' ? ex.command : '';
      if (cmd.trim()) out.push(cmd);
    }
  }
  return out;
}

/**
 * Extract the concatenated assistant text from an `agent_end` event's
 * `messages` array. Mirrors the extraction logic in `stall-detect.ts`
 * so shape quirks are handled once.
 */
export function extractLastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const wrapped = messages[i] as { message?: unknown };
    const m = (wrapped?.message ?? messages[i]) as
      | { role?: string; content?: unknown; stopReason?: unknown }
      | undefined;
    if (m?.role !== 'assistant') continue;
    // User hit Ctrl+C mid-response: the assistant text is a partial
    // artifact, and scanning it for "tests pass" / "lint is clean"
    // would produce false positives we'd then steer on. Treat aborted
    // turns as if they had no text. Providers carry the signal as
    // `stopReason === 'aborted'` (pi-agent-core ≥ recent).
    if (m.stopReason === 'aborted') return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const c of m.content) {
        if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
          const text = (c as { text?: string }).text;
          if (typeof text === 'string') parts.push(text);
        }
      }
      return parts.join('\n');
    }
    return '';
  }
  return '';
}

/**
 * Does the most recent user message on the branch already carry
 * `marker`? Used as an idempotency guard so the extension doesn't
 * steer twice in a row on the same turn.
 */
export function lastUserMessageHasMarker(branch: readonly BranchEntry[], marker: string): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    const msg = entry.message;
    if (msg?.role !== 'user') continue;
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
          text += (c as { text?: string }).text ?? '';
        }
      }
    }
    return text.includes(marker);
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// User-configurable command→kinds rules (`commandSatisfies`)
//
// Shipped defaults cover the common cases; per-project / per-user
// config extends them for scripts the matcher can't reasonably guess
// at (custom CI wrappers, multi-tool meta-commands, repo-specific
// verifiers).
//
// File layout (JSONC) at `~/.pi/agent/verify-before-claim.json` and
// project `.pi/verify-before-claim.json`:
//
//   {
//     "commandSatisfies": [
//       { "pattern": "^\\./dev/lint\\.sh\\b",
//         "kinds": ["lint-clean", "format-clean"] },
//       { "pattern": "^make\\s+check\\b",
//         "kinds": ["tests-pass", "lint-clean", "types-check"] }
//     ]
//   }
//
// Project rules are appended onto global rules, not replacing them.
// Order within the merged list doesn't matter - `verifyingCommandMatches`
// short-circuits on the first match regardless.
// ──────────────────────────────────────────────────────────────────────

const VALID_KINDS: ReadonlySet<ClaimKind> = new Set<ClaimKind>([
  'tests-pass',
  'lint-clean',
  'types-check',
  'build-clean',
  'format-clean',
  'ci-green',
]);

/** User-facing rule shape - the raw JSONC entry. */
export interface CommandSatisfiesRule {
  pattern: string;
  kinds: ClaimKind[];
}

/** Compiled form passed into `partitionClaims` / `verifyingCommandMatches`. */
export interface CompiledSatisfyRule {
  re: RegExp;
  kinds: Set<ClaimKind>;
  /** The source config file path (for diagnostics). */
  source: string;
}

export interface ConfigWarning {
  path: string;
  error: string;
}

/**
 * Read `verify-before-claim.json` from global + project locations and
 * return compiled `commandSatisfies` rules plus any load / parse
 * warnings. Missing files are silent; malformed JSON, unknown claim
 * kinds, and bad regexes produce structured warnings.
 *
 * The caller (the extension) surfaces warnings via `ctx.ui.notify`.
 */
export function loadSatisfyRules(
  cwd: string,
  home: string = homedir(),
): { rules: CompiledSatisfyRule[]; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const rules: CompiledSatisfyRule[] = [];
  const paths = [join(home, '.pi', 'agent', 'verify-before-claim.json'), join(cwd, '.pi', 'verify-before-claim.json')];

  for (const path of paths) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch (e) {
      warnings.push({ path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!parsed || typeof parsed !== 'object') {
      warnings.push({ path, error: 'config root must be an object' });
      continue;
    }
    const { commandSatisfies } = parsed as { commandSatisfies?: unknown };
    if (commandSatisfies === undefined) continue;
    if (!Array.isArray(commandSatisfies)) {
      warnings.push({ path, error: '`commandSatisfies` must be an array' });
      continue;
    }
    for (const entry of commandSatisfies) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.pattern !== 'string' || e.pattern.length === 0) {
        warnings.push({ path, error: 'rule is missing a non-empty `pattern`' });
        continue;
      }
      if (!Array.isArray(e.kinds) || e.kinds.length === 0) {
        warnings.push({ path, error: `rule "${e.pattern}" is missing a non-empty \`kinds\` array` });
        continue;
      }
      const kinds = new Set<ClaimKind>();
      let ruleOk = true;
      for (const k of e.kinds) {
        if (typeof k !== 'string' || !VALID_KINDS.has(k as ClaimKind)) {
          warnings.push({
            path,
            error: `rule "${e.pattern}" has unknown kind ${JSON.stringify(k)} (allowed: ${Array.from(VALID_KINDS).join(', ')})`,
          });
          ruleOk = false;
          continue;
        }
        kinds.add(k as ClaimKind);
      }
      if (!ruleOk || kinds.size === 0) continue;
      let re: RegExp;
      try {
        re = new RegExp(e.pattern);
      } catch (err) {
        warnings.push({ path, error: `rule "${e.pattern}" has invalid regex: ${String(err)}` });
        continue;
      }
      rules.push({ re, kinds, source: path });
    }
  }
  return { rules, warnings };
}
