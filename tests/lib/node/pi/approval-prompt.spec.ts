/**
 * Tests for lib/node/pi/approval-prompt.ts.
 *
 * Pure module — no pi runtime needed. Stub the structural
 * `ApprovalPromptContext` directly.
 */

import { describe, expect, test, vi } from 'vitest';

import {
  type ApprovalPromptArgs,
  type ApprovalPromptContext,
  askForPermission,
} from '../../../../lib/node/pi/approval-prompt.ts';

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

interface FakeUiOptions {
  selectReturn?: string | undefined;
  inputReturn?: string | undefined;
}

function fakeContext(opts: FakeUiOptions = {}): {
  ctx: ApprovalPromptContext;
  select: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
} {
  const select = vi.fn(() => Promise.resolve(opts.selectReturn));
  const input = vi.fn(() => Promise.resolve(opts.inputReturn));
  return {
    ctx: { ui: { select, input } },
    select,
    input,
  };
}

const baseArgs: ApprovalPromptArgs = {
  tool: 'write',
  path: '/repo/secret.txt',
  detail: 'inside ~/.ssh',
};

// ──────────────────────────────────────────────────────────────────────
// askForPermission
// ──────────────────────────────────────────────────────────────────────

describe('askForPermission', () => {
  test('returns allow-once when user picks "Allow once"', async () => {
    const { ctx, select, input } = fakeContext({ selectReturn: 'Allow once' });

    const decision = await askForPermission(ctx, baseArgs);

    expect(decision).toEqual({ kind: 'allow-once' });
    expect(select).toHaveBeenCalledTimes(1);
    expect(input).not.toHaveBeenCalled();
  });

  test('returns allow-session when user picks the per-session label', async () => {
    const sessionLabel = `Allow "${baseArgs.path}" for this session`;
    const { ctx, select, input } = fakeContext({ selectReturn: sessionLabel });

    const decision = await askForPermission(ctx, baseArgs);

    expect(decision).toEqual({ kind: 'allow-session' });

    // Session label is path-templated — confirm the prompt offered it.
    const offered = select.mock.calls[0]?.[1] as string[];

    expect(offered).toContain(sessionLabel);
    expect(input).not.toHaveBeenCalled();
  });

  test('returns deny without feedback when user picks "Deny"', async () => {
    const { ctx, input } = fakeContext({ selectReturn: 'Deny' });

    const decision = await askForPermission(ctx, baseArgs);

    expect(decision).toEqual({ kind: 'deny' });
    expect(input).not.toHaveBeenCalled();
  });

  test('returns deny with feedback when user picks "Deny with feedback…"', async () => {
    const { ctx, input } = fakeContext({
      selectReturn: 'Deny with feedback…',
      inputReturn: 'read docs/foo.md instead',
    });

    const decision = await askForPermission(ctx, baseArgs);

    expect(decision).toEqual({ kind: 'deny', feedback: 'read docs/foo.md instead' });
    expect(input).toHaveBeenCalledTimes(1);
  });

  test('normalises whitespace-only feedback to undefined', async () => {
    const { ctx } = fakeContext({
      selectReturn: 'Deny with feedback…',
      inputReturn: '   \n\t  ',
    });

    const decision = await askForPermission(ctx, baseArgs);

    expect(decision).toEqual({ kind: 'deny', feedback: undefined });
  });

  test('trims surrounding whitespace from feedback', async () => {
    const { ctx } = fakeContext({
      selectReturn: 'Deny with feedback…',
      inputReturn: '  prefer plans/foo.md  ',
    });

    const decision = await askForPermission(ctx, baseArgs);

    expect(decision).toEqual({ kind: 'deny', feedback: 'prefer plans/foo.md' });
  });

  test('treats undefined feedback as undefined (input dismissed)', async () => {
    const { ctx } = fakeContext({
      selectReturn: 'Deny with feedback…',
      inputReturn: undefined,
    });

    const decision = await askForPermission(ctx, baseArgs);

    expect(decision).toEqual({ kind: 'deny', feedback: undefined });
  });

  test('fails closed (deny) when select returns undefined (dialog dismissed)', async () => {
    const { ctx, input } = fakeContext({ selectReturn: undefined });

    const decision = await askForPermission(ctx, baseArgs);

    expect(decision).toEqual({ kind: 'deny' });
    expect(input).not.toHaveBeenCalled();
  });

  test('fails closed (deny) on any unrecognised label', async () => {
    const { ctx } = fakeContext({ selectReturn: 'Some New Option' });

    const decision = await askForPermission(ctx, baseArgs);

    expect(decision).toEqual({ kind: 'deny' });
  });

  test('renders tool, path, and detail into the prompt body', async () => {
    const { ctx, select } = fakeContext({ selectReturn: 'Deny' });

    await askForPermission(ctx, {
      tool: 'edit',
      path: '/work/sensitive.json',
      detail: 'matches secrets glob',
    });

    const prompt = select.mock.calls[0]?.[0] as string;

    expect(prompt).toContain('edit');
    expect(prompt).toContain('/work/sensitive.json');
    expect(prompt).toContain('matches secrets glob');
  });
});
