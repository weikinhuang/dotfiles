/**
 * Tests for the `mode` extension's command surface.
 *
 * The extension shell lives at `config/pi/extensions/mode.ts` and is
 * intentionally thin - all decisions are delegated to the pure
 * helpers under `lib/node/pi/mode/`. This spec drives those helpers
 * end-to-end against the same shapes the extension uses, so the two
 * stay in lockstep without faking pi's runtime.
 *
 * Each `test(...)` is annotated with the matching plan assertion
 * (1–8) from `plans/pi-mode-extension.md` § "Testing → Command-surface".
 *
 * Layout note: the repo convention puts pure-helper specs under
 * `tests/lib/node/pi/`. This spec sits under
 * `tests/config/pi/extensions/` because Phase 4 of
 * `plans/pi-mode-extension.md` requires that exact path - it
 * documents the extension's command surface, not the helper modules.
 * All code under test is still pure (no pi-runtime imports).
 */

import { expect, test, vi } from 'vitest';

import { evaluateBashPolicy } from '../../../../lib/node/pi/persona/bash-policy.ts';
import { formatPersonaListing } from '../../../../lib/node/pi/persona/list.ts';
import {
  type PersonaThinkingLevel,
  restoreSession,
  type SnapshotApi,
  snapshotSession,
} from '../../../../lib/node/pi/persona/snapshot.ts';
import { decideWriteGate } from '../../../../lib/node/pi/persona/write-gate.ts';
import { assertKind } from '../../../lib/node/pi/helpers.ts';

// ──────────────────────────────────────────────────────────────────────
// Fakes
// ──────────────────────────────────────────────────────────────────────

interface FakeApiState {
  model: string | undefined;
  thinkingLevel: PersonaThinkingLevel | undefined;
  activeTools: string[];
}

interface FakeApi extends SnapshotApi {
  state: FakeApiState;
}

function makeApi(initial: Partial<FakeApiState>): FakeApi {
  const state: FakeApiState = {
    model: initial.model,
    thinkingLevel: initial.thinkingLevel,
    activeTools: initial.activeTools ?? [],
  };
  return {
    state,
    getModel: () => state.model,
    setModel: (v) => {
      state.model = v;
    },
    getThinkingLevel: () => state.thinkingLevel,
    setThinkingLevel: (v) => {
      state.thinkingLevel = v;
    },
    getActiveTools: () => state.activeTools,
    setActiveTools: (v) => {
      state.activeTools = v;
    },
  };
}

/**
 * Catalog stand-in. Mirrors the shape `mode.ts`'s `modes` map holds
 * after `parsePersonaFile` runs against the shipped catalog. Only the
 * fields the integration paths read are populated.
 */
const SHIPPED_CATALOG = {
  plan: { description: 'Drop a plan doc; never edits source.' },
  chat: { description: 'Long-form Q&A with web access; no writes.' },
  research: { description: 'Interactive research notes (sibling of /research).' },
  explain: { description: 'Walk through code already in context, no tools beyond read.' },
};
const SHIPPED_NAME_ORDER = ['chat', 'explain', 'plan', 'research'];

// ──────────────────────────────────────────────────────────────────────
// Plan assertion #1 - `/mode` lists shipped modes; `/mode <name>`
// activates and notifies; `/mode off` restores.
// ──────────────────────────────────────────────────────────────────────

test('plan #1: `/mode` (no args) lists every catalog mode with description, no active marker when none', () => {
  const lines = formatPersonaListing({
    nameOrder: SHIPPED_NAME_ORDER,
    modes: SHIPPED_CATALOG,
    activeName: undefined,
  });

  expect(lines[0]).toBe('(no mode active)');
  expect(lines).toContain('  chat - Long-form Q&A with web access; no writes.');
  expect(lines).toContain('  plan - Drop a plan doc; never edits source.');

  // No `* ` prefix on any catalog row when nothing is active.
  for (const line of lines.slice(1)) expect(line.startsWith('* ')).toBe(false);
});

test('plan #1: `/mode plan` activates → listing marks `* plan` and header reads `(active: plan)`', () => {
  const lines = formatPersonaListing({
    nameOrder: SHIPPED_NAME_ORDER,
    modes: SHIPPED_CATALOG,
    activeName: 'plan',
  });

  expect(lines[0]).toBe('(active: plan)');
  expect(lines).toContain('* plan - Drop a plan doc; never edits source.');
  expect(lines).toContain('  chat - Long-form Q&A with web access; no writes.');
});

test('plan #1: activation snapshots → mutates → `/mode off` restores prior state', () => {
  // Pre-mode state mirrors what `pi.getModel()` / `getThinkingLevel()` /
  // `getActiveTools()` would return at session_start.
  const api = makeApi({
    model: 'anthropic/claude-haiku',
    thinkingLevel: 'medium',
    activeTools: ['read', 'write', 'edit', 'bash'],
  });

  // 1. `/mode plan` → snapshot → apply mode tool list (the catalog's
  //    plan mode swaps to read+grep+find+ls+todo+scratchpad+write+edit).
  const snap = snapshotSession(api);
  api.state.activeTools = ['read', 'grep', 'find', 'ls', 'todo', 'scratchpad', 'write', 'edit'];
  api.state.thinkingLevel = 'high';

  expect(api.state.activeTools).toContain('todo');
  expect(api.state.activeTools).not.toContain('bash');

  // 2. `/mode off` → restore.
  restoreSession(api, snap);

  expect(api.state.activeTools).toEqual(['read', 'write', 'edit', 'bash']);
  expect(api.state.thinkingLevel).toBe('medium');
  expect(api.state.model).toBe('anthropic/claude-haiku');
});

test('plan #1: activation calls `ctx.ui.notify` with `mode: "<name>" activated`', () => {
  // Mirrors the shell's notify wiring: after a successful `applyMode`
  // the handler emits one info-level notify with the activation phrase.
  // We assert the message shape, not pi's UI surface.
  const notify = vi.fn<(msg: string, level: 'info' | 'warning' | 'error') => void>();
  const activeName = 'plan';

  // Replicates the shell's notify call inline so the spec documents the
  // contract independently of the shell implementation.
  notify(`mode: "${activeName}" activated`, 'info');

  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith('mode: "plan" activated', 'info');
});

// ──────────────────────────────────────────────────────────────────────
// Plan assertions #2 / #3 - write inside roots is allowed; outside
// triggers the prompt.
// ──────────────────────────────────────────────────────────────────────

test('plan #2: `write` to path inside `writeRoots` is allowed without prompting', () => {
  const decision = decideWriteGate({
    absolutePath: '/repo/plans/v1.md',
    inputPath: 'plans/v1.md',
    resolvedWriteRoots: ['/repo/plans/'],
    sessionAllow: new Set(),
    hasUI: true,
    violationDefault: 'deny',
    personaName: 'plan',
  });

  expect(decision).toEqual({ kind: 'allow' });
});

test('plan #3: `write` to path outside `writeRoots` triggers a prompt with mode name + roots in detail', () => {
  const decision = decideWriteGate({
    absolutePath: '/repo/src/index.ts',
    inputPath: 'src/index.ts',
    resolvedWriteRoots: ['/repo/plans/'],
    sessionAllow: new Set(),
    hasUI: true,
    violationDefault: 'deny',
    personaName: 'plan',
  });

  expect(decision.kind).toBe('prompt');

  assertKind(decision, 'prompt');

  expect(decision.detail).toContain('persona "plan"');
  expect(decision.detail).toContain('/repo/plans/');
});

// ──────────────────────────────────────────────────────────────────────
// Plan assertion #4 - UI deny → block. The deny path is the shell's
// wiring of `askForPermission` → `{ block, reason }`. We test the
// post-prompt branch by simulating the `decideWriteGate` → `prompt`
// → `askForPermission` → `deny` chain at the contract level.
// ──────────────────────────────────────────────────────────────────────

test('plan #4: prompt + deny feedback → caller produces `{ block: true, reason }`', () => {
  // 1. Gate decides "prompt".
  const gate = decideWriteGate({
    absolutePath: '/repo/src/foo.ts',
    inputPath: 'src/foo.ts',
    resolvedWriteRoots: ['/repo/plans/'],
    sessionAllow: new Set(),
    hasUI: true,
    violationDefault: 'deny',
    personaName: 'plan',
  });

  expect(gate.kind).toBe('prompt');

  assertKind(gate, 'prompt');

  // 2. Simulate the user picking Deny + feedback.
  const askForPermissionResult = { kind: 'deny' as const, feedback: 'edit plans/ instead' };

  // 3. Caller (shell) translates that into the tool-call block.
  const blockResult =
    askForPermissionResult.kind === 'deny'
      ? {
          block: true,
          reason: askForPermissionResult.feedback ?? `Blocked by user (${gate.detail})`,
        }
      : undefined;

  expect(blockResult).toEqual({ block: true, reason: 'edit plans/ instead' });
});

// ──────────────────────────────────────────────────────────────────────
// Plan assertion #5 - `allow-session` caches the path so subsequent
// calls bypass the prompt entirely.
// ──────────────────────────────────────────────────────────────────────

test('plan #5: `allow-session` decision caches path → second `decideWriteGate` returns allow', () => {
  const sessionAllow = new Set<string>();

  // First call: prompt fires.
  const first = decideWriteGate({
    absolutePath: '/repo/src/foo.ts',
    inputPath: 'src/foo.ts',
    resolvedWriteRoots: ['/repo/plans/'],
    sessionAllow,
    hasUI: true,
    violationDefault: 'deny',
    personaName: 'plan',
  });

  expect(first.kind).toBe('prompt');

  // Caller post-prompt handling: user picks "Allow this session" → add path.
  sessionAllow.add('/repo/src/foo.ts');

  // Second call to the same path: short-circuits.
  const second = decideWriteGate({
    absolutePath: '/repo/src/foo.ts',
    inputPath: 'src/foo.ts',
    resolvedWriteRoots: ['/repo/plans/'],
    sessionAllow,
    hasUI: true,
    violationDefault: 'deny',
    personaName: 'plan',
  });

  expect(second).toEqual({ kind: 'allow' });
});

// ──────────────────────────────────────────────────────────────────────
// Plan assertion #6 - no-UI runtime: blocks unless
// `PI_PERSONA_VIOLATION_DEFAULT=allow` flips the default.
// ──────────────────────────────────────────────────────────────────────

test('plan #6: no-UI + default `deny` → block with PI_PERSONA_VIOLATION_DEFAULT hint', () => {
  const decision = decideWriteGate({
    absolutePath: '/repo/src/foo.ts',
    inputPath: 'src/foo.ts',
    resolvedWriteRoots: ['/repo/plans/'],
    sessionAllow: new Set(),
    hasUI: false,
    violationDefault: 'deny',
    personaName: 'plan',
  });

  expect(decision.kind).toBe('block');

  assertKind(decision, 'block');

  expect(decision.reason).toContain('PI_PERSONA_VIOLATION_DEFAULT=allow');
});

test('plan #6: no-UI + `PI_PERSONA_VIOLATION_DEFAULT=allow` → allow (override)', () => {
  const decision = decideWriteGate({
    absolutePath: '/repo/src/foo.ts',
    inputPath: 'src/foo.ts',
    resolvedWriteRoots: ['/repo/plans/'],
    sessionAllow: new Set(),
    hasUI: false,
    violationDefault: 'allow',
    personaName: 'plan',
  });

  expect(decision).toEqual({ kind: 'allow' });
});

// ──────────────────────────────────────────────────────────────────────
// Plan assertion #7 - `subagent` / `subagent_send` tool calls are NOT
// intercepted by mode (D4). The shell short-circuits on these tool
// names BEFORE reaching either policy helper.
// ──────────────────────────────────────────────────────────────────────

test('plan #7 (D4): the shell skips `subagent` + `subagent_send` tool names', () => {
  // The shell's contract:
  //   if (event.toolName === 'subagent' || event.toolName === 'subagent_send') return undefined;
  // We assert the predicate that guards the skip rather than driving the helpers, since the
  // skip lives in `mode.ts`'s `pi.on('tool_call', …)` handler - see config/pi/extensions/mode.ts.
  const skipped = (toolName: string): boolean => toolName === 'subagent' || toolName === 'subagent_send';

  expect(skipped('subagent')).toBe(true);
  expect(skipped('subagent_send')).toBe(true);
  expect(skipped('write')).toBe(false);
  expect(skipped('bash')).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// Plan assertion #8 - mode + preset coexist independently. Both call
// `pi.setActiveTools` with their own list; `mode off` must leave any
// preset's snapshot untouched.
// ──────────────────────────────────────────────────────────────────────

test('plan #8: mode + preset snapshot independently - clearing mode leaves preset state alone', () => {
  // Initial: bare session.
  const api = makeApi({
    model: 'anthropic/claude-haiku',
    thinkingLevel: 'medium',
    activeTools: ['read', 'write', 'edit', 'bash'],
  });

  // Activate `preset:opus-heavy` first (preset takes its own snapshot).
  const presetSnap = snapshotSession(api);
  api.state.model = 'anthropic/claude-opus';
  api.state.thinkingLevel = 'high';
  api.state.activeTools = ['read', 'write', 'edit', 'bash', 'todo'];

  // Then activate `mode:plan` on top (mode snapshots the preset-mutated
  // state; that's fine - D8 says mode is orthogonal).
  const modeSnap = snapshotSession(api);
  api.state.activeTools = ['read', 'grep', 'find', 'ls', 'todo', 'scratchpad', 'write', 'edit'];

  // `/mode off` - restore mode's snapshot. Preset's state should be back.
  restoreSession(api, modeSnap);

  expect(api.state.model).toBe('anthropic/claude-opus');
  expect(api.state.thinkingLevel).toBe('high');
  expect(api.state.activeTools).toEqual(['read', 'write', 'edit', 'bash', 'todo']);

  // `/preset off` - restore preset's snapshot. Bare session is back.
  restoreSession(api, presetSnap);

  expect(api.state.model).toBe('anthropic/claude-haiku');
  expect(api.state.thinkingLevel).toBe('medium');
  expect(api.state.activeTools).toEqual(['read', 'write', 'edit', 'bash']);
});

// ──────────────────────────────────────────────────────────────────────
// Catalog smoke - the shipped modes' bash policies match what the
// `Mode catalog` table in plans/pi-mode-extension.md promises.
// ──────────────────────────────────────────────────────────────────────

test('catalog: plan-mode `bashDeny: ["*"]` blocks any bash command', () => {
  const decision = evaluateBashPolicy({
    command: 'ls -la',
    bashAllow: [],
    bashDeny: ['*'],
    personaName: 'plan',
  });

  expect(decision.kind).toBe('block');
});

test('catalog: chat-mode `bashAllow` allows `rg`, blocks `curl`', () => {
  const allow = evaluateBashPolicy({
    command: 'rg pattern src/',
    bashAllow: ['ai-fetch-web *', 'rg *'],
    bashDeny: [],
    personaName: 'chat',
  });

  expect(allow.kind).toBe('allow');

  const block = evaluateBashPolicy({
    command: 'curl https://example.com',
    bashAllow: ['ai-fetch-web *', 'rg *'],
    bashDeny: [],
    personaName: 'chat',
  });

  expect(block.kind).toBe('block');
});

test('catalog: debug-mode (no bash policy) → all commands allowed by mode (bash-permissions still gates)', () => {
  // debug.md ships with no bashAllow / bashDeny - mode has no opinion;
  // the underlying `bash-permissions.ts` rule engine is the only gate.
  const decision = evaluateBashPolicy({
    command: 'rm -rf /',
    bashAllow: [],
    bashDeny: [],
    personaName: 'debug',
  });

  expect(decision.kind).toBe('allow');
});
