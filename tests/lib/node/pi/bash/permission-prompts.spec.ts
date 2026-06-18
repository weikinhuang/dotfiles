/**
 * Tests for lib/node/pi/bash/permission-prompts.ts.
 *
 * Pure module - structural BashGateContext is stubbed with vi.fn ui
 * surfaces. Same trick approval-prompt.spec.ts uses.
 */

import { describe, expect, test, vi } from 'vitest';

import type { BashGateContext } from '../../../../../lib/node/pi/bash/gate.ts';
import {
  askForPermission,
  askForPermissionBatch,
  buildBashBatchPermissionPrompt,
  buildBashPermissionPrompt,
  type BashBatchDecision,
  type BashPermissionDecision,
  compactForDialog,
} from '../../../../../lib/node/pi/bash/permission-prompts.ts';

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

interface FakeOpts {
  selectReturn?: string | undefined;
  inputReturn?: string | undefined;
}

function fakeContext(opts: FakeOpts = {}): {
  ctx: BashGateContext;
  select: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
} {
  const select = vi.fn(() => Promise.resolve(opts.selectReturn));
  const input = vi.fn(() => Promise.resolve(opts.inputReturn));
  return {
    ctx: {
      cwd: '/tmp',
      hasUI: true,
      ui: {
        select,
        input,
        notify: vi.fn(),
      },
    },
    select,
    input,
  };
}

// ──────────────────────────────────────────────────────────────────────
// compactForDialog
// ──────────────────────────────────────────────────────────────────────

describe('compactForDialog', () => {
  test('collapses runs of whitespace to a single space', () => {
    expect(compactForDialog('foo   bar\nbaz')).toBe('foo bar baz');
  });

  test('trims surrounding whitespace', () => {
    expect(compactForDialog('  foo bar  ')).toBe('foo bar');
  });

  test('truncates with ellipsis when over maxLen', () => {
    const out = compactForDialog('a'.repeat(200), 50);
    expect(out).toHaveLength(50);
    expect(out.endsWith('…')).toBe(true);
  });

  test('returns short input unchanged', () => {
    expect(compactForDialog('echo hi')).toBe('echo hi');
  });
});

// ──────────────────────────────────────────────────────────────────────
// askForPermission
// ──────────────────────────────────────────────────────────────────────

describe('askForPermission', () => {
  test('buildBashPermissionPrompt produces copy and decisions without UI', () => {
    const prompt = buildBashPermissionPrompt('docker build .', { auto: true, alwaysPromptReason: 'docker' });

    expect(prompt.title).toContain('auto mode cannot skip this (docker)');
    expect(prompt.entries.map((e) => e.label).some((label) => label.includes('docker build'))).toBe(true);
    expect(prompt.feedback.placeholder).toContain('test script');
  });

  test('prepends a [requester] header when a requester is supplied', () => {
    const single = buildBashPermissionPrompt('ls -la', { requester: 'subagent explore (sub_explore_1)' });
    expect(single.title).toContain('[subagent explore (sub_explore_1)] Bash tool request:');
  });

  test('returns allow-once when "Allow once" picked', async () => {
    const { ctx } = fakeContext({ selectReturn: 'Allow once' });

    const out: BashPermissionDecision = await askForPermission(ctx, 'ls -la');

    expect(out).toEqual({ kind: 'allow-once' });
  });

  test('routes through promptSelectWithFeedback: deny on dismissal', async () => {
    const { ctx, input } = fakeContext({ selectReturn: undefined });

    const out = await askForPermission(ctx, 'rm -rf /tmp/x');

    expect(out).toEqual({ kind: 'deny', feedback: undefined });
    expect(input).not.toHaveBeenCalled();
  });

  test('returns deny+feedback when user opts to explain', async () => {
    const { ctx } = fakeContext({
      selectReturn: 'Deny with feedback…',
      inputReturn: '  prefer cleanup script  ',
    });

    const out = await askForPermission(ctx, 'rm -rf /tmp/x');

    expect(out).toEqual({ kind: 'deny', feedback: 'prefer cleanup script' });
  });

  test('offers a project two-token rule when the command has ≥2 tokens', async () => {
    const { ctx, select } = fakeContext({ selectReturn: undefined });

    await askForPermission(ctx, 'docker build .');

    const labels = select.mock.calls[0]?.[1] as string[];
    expect(labels.some((l) => l.includes('docker build')) || labels.some((l) => l.includes('(project)'))).toBe(true);
  });

  test('offers a user-prefix rule based on first token', async () => {
    const { ctx, select } = fakeContext({ selectReturn: undefined });

    await askForPermission(ctx, 'curl https://example.com');

    const labels = select.mock.calls[0]?.[1] as string[];
    expect(labels.some((l) => l.includes('curl*'))).toBe(true);
  });

  test('renders an ⚡ note when auto + alwaysPromptReason are set', async () => {
    const { ctx, select } = fakeContext({ selectReturn: 'Allow once' });

    await askForPermission(ctx, 'sudo apt update', { auto: true, alwaysPromptReason: 'sudo' });

    const title = select.mock.calls[0]?.[0] as string;
    expect(title).toMatch(/auto mode cannot skip/);
    expect(title).toContain('sudo');
  });

  test('compacts multi-line command in title (no raw newlines in rendered line)', async () => {
    const { ctx, select } = fakeContext({ selectReturn: 'Allow once' });

    await askForPermission(ctx, 'foo\n  bar\n  baz');

    const title = select.mock.calls[0]?.[0] as string;
    // Title is multi-line by design (header + body + footer), but the
    // RENDERED command line itself must be one whitespace-collapsed
    // segment.
    const commandLine = title.split('\n').find((l) => l.trim().startsWith('foo'));
    expect(commandLine).toBeDefined();
    expect(commandLine).toMatch(/foo bar baz/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// askForPermissionBatch
// ──────────────────────────────────────────────────────────────────────

describe('askForPermissionBatch', () => {
  test('buildBashBatchPermissionPrompt caps visible sub-commands without UI', () => {
    const unknown = Array.from({ length: 10 }, (_, i) => `cmd${i}`);
    const prompt = buildBashBatchPermissionPrompt('compound', unknown);

    expect(prompt.title).toContain('… and 4 more');
    expect(prompt.entries.map((e) => e.label)).toContain('Allow all 10 once');
  });

  test('prepends a [requester] header when a requester is supplied', () => {
    const prompt = buildBashBatchPermissionPrompt('compound', ['a', 'b'], { requester: 'subagent plan (sub_plan_2)' });
    expect(prompt.title).toContain('[subagent plan (sub_plan_2)] Bash tool request with 2 unknown sub-commands:');
  });

  test('returns allow-all-once on the corresponding label', async () => {
    const { ctx } = fakeContext({ selectReturn: 'Allow all 3 once' });

    const out: BashBatchDecision = await askForPermissionBatch(ctx, 'a && b && c', ['a', 'b', 'c']);

    expect(out).toEqual({ kind: 'allow-all-once' });
  });

  test('returns allow-all-session on the session label', async () => {
    const { ctx } = fakeContext({ selectReturn: 'Allow all 2 for this session' });

    const out = await askForPermissionBatch(ctx, 'a && b', ['a', 'b']);

    expect(out).toEqual({ kind: 'allow-all-session' });
  });

  test('renders "… and N more" when sub-command list overflows', async () => {
    const { ctx, select } = fakeContext({ selectReturn: 'Deny' });

    const unknown = Array.from({ length: 10 }, (_, i) => `cmd${i}`);

    await askForPermissionBatch(ctx, 'compound', unknown);

    const title = select.mock.calls[0]?.[0] as string;
    expect(title).toMatch(/… and 4 more/);
  });

  test('includes ⚡-marker rows when sub-commands carry an alwaysPromptReason', async () => {
    const { ctx, select } = fakeContext({ selectReturn: 'Deny' });

    const reasons = new Map([['sudo apt update', 'sudo']]);

    await askForPermissionBatch(ctx, 'sudo apt update && ls', ['sudo apt update', 'ls'], {
      auto: true,
      alwaysPromptReasons: reasons,
    });

    const title = select.mock.calls[0]?.[0] as string;
    expect(title).toMatch(/⚡/);
    expect(title).toMatch(/auto mode cannot skip the ⚡-marked sub-commands/);
  });

  test('passes deny+feedback through buildDeny', async () => {
    const { ctx } = fakeContext({
      selectReturn: 'Deny with feedback…',
      inputReturn: '  prefer separate calls  ',
    });

    const out = await askForPermissionBatch(ctx, 'a && b', ['a', 'b']);

    expect(out).toEqual({ kind: 'deny', feedback: 'prefer separate calls' });
  });

  test('fails closed when select is dismissed', async () => {
    const { ctx } = fakeContext({ selectReturn: undefined });

    const out = await askForPermissionBatch(ctx, 'a && b', ['a', 'b']);

    expect(out).toEqual({ kind: 'deny', feedback: undefined });
  });
});
