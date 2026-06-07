/**
 * Tests for lib/node/pi/ext/drop-confirm.ts.
 *
 * The module imports `@earendil-works/pi-coding-agent` (type-only,
 * `ExtensionContext`) and drives the shared approval engine. We fake
 * `ctx.ui.select` / `input` / `custom` so the test can pick each dialog
 * option and assert the resulting outcome + session-flag mutation,
 * without a real TUI.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, test } from 'vitest';

import {
  confirmDrop,
  type ConfirmDropArgs,
  type DropSessionFlags,
  emptyDropFlags,
} from '../../../../../lib/node/pi/ext/drop-confirm.ts';
import { type DropTitleItem } from '../../../../../lib/node/pi/context-edit/agent-drop.ts';

const titleItems: DropTitleItem[] = [
  { ordinal: 2, label: 'image (24KB): cat' },
  { ordinal: 3, label: 'image (20KB): dog' },
];
const rows = [{ label: 'image (24KB): cat' }, { label: 'image (20KB): dog' }];

interface FakeUI {
  selectLabel?: (options: string[]) => string | undefined;
  inputValue?: string;
  customResult?: number[] | undefined;
}

function fakeCtx(hasUI: boolean, ui: FakeUI = {}): ExtensionContext {
  return {
    hasUI,
    ui: {
      select: async (_title: string, options: string[]) => ui.selectLabel?.(options),
      input: async () => ui.inputValue,
      custom: async <T>() => ui.customResult as T,
    },
  } as unknown as ExtensionContext;
}

function args(flags: DropSessionFlags, nonInteractiveDefault: 'allow' | 'deny' = 'deny'): ConfirmDropArgs {
  return {
    toolName: 'drop_image',
    verb: 'drop',
    noun: 'image(s)',
    titleItems,
    rows,
    flags,
    nonInteractiveDefault,
  };
}

test('neverAllow flag denies without touching the UI', async () => {
  const flags = { autoAllow: false, neverAllow: true };
  const out = await confirmDrop(fakeCtx(true), args(flags));
  expect(out.allow).toBe(false);
});

test('autoAllow flag allows the whole selection without a prompt', async () => {
  const flags = { autoAllow: true, neverAllow: false };
  const out = await confirmDrop(fakeCtx(true), args(flags));
  expect(out).toEqual({ allow: true, indices: [0, 1] });
});

test('no UI: PI_..._DEFAULT=allow opts in, deny is conservative', async () => {
  await expect(confirmDrop(fakeCtx(false), args(emptyDropFlags(), 'allow'))).resolves.toEqual({
    allow: true,
    indices: [0, 1],
  });
  await expect(confirmDrop(fakeCtx(false), args(emptyDropFlags(), 'deny'))).resolves.toMatchObject({ allow: false });
});

test('Allow once allows all without setting a session flag', async () => {
  const flags = emptyDropFlags();
  const ctx = fakeCtx(true, { selectLabel: (o) => o.find((l) => l === 'Allow once') });
  const out = await confirmDrop(ctx, args(flags));
  expect(out).toEqual({ allow: true, indices: [0, 1] });
  expect(flags.autoAllow).toBe(false);
});

test('Allow <tool> for this session sets autoAllow', async () => {
  const flags = emptyDropFlags();
  const ctx = fakeCtx(true, {
    selectLabel: (o) => o.find((l) => l.includes('for this session') && !l.startsWith('Never')),
  });
  const out = await confirmDrop(ctx, args(flags));
  expect(out.allow).toBe(true);
  expect(flags.autoAllow).toBe(true);
});

test('Never allow this session sets neverAllow and denies', async () => {
  const flags = emptyDropFlags();
  const ctx = fakeCtx(true, { selectLabel: (o) => o.find((l) => l.startsWith('Never')) });
  const out = await confirmDrop(ctx, args(flags));
  expect(out.allow).toBe(false);
  expect(flags.neverAllow).toBe(true);
});

test('Deny with feedback returns the feedback to the model', async () => {
  const ctx = fakeCtx(true, {
    selectLabel: (o) => o.find((l) => l.startsWith('Deny with feedback')),
    inputValue: 'keep the latest render',
  });
  const out = await confirmDrop(ctx, args(emptyDropFlags()));
  expect(out).toEqual({ allow: false, feedback: 'keep the latest render' });
});

test('Edit selection returns only the rows left checked', async () => {
  const ctx = fakeCtx(true, {
    selectLabel: (o) => o.find((l) => l.startsWith('Edit selection')),
    customResult: [1],
  });
  const out = await confirmDrop(ctx, args(emptyDropFlags()));
  expect(out).toEqual({ allow: true, indices: [1] });
});

test('Edit selection cancelled (undefined) denies', async () => {
  const ctx = fakeCtx(true, {
    selectLabel: (o) => o.find((l) => l.startsWith('Edit selection')),
    customResult: undefined,
  });
  const out = await confirmDrop(ctx, args(emptyDropFlags()));
  expect(out.allow).toBe(false);
});

test('empty selection denies up front', async () => {
  const out = await confirmDrop(fakeCtx(true), {
    toolName: 'drop_image',
    verb: 'drop',
    noun: 'image(s)',
    titleItems: [],
    rows: [],
    flags: emptyDropFlags(),
    nonInteractiveDefault: 'allow',
  });
  expect(out.allow).toBe(false);
});
