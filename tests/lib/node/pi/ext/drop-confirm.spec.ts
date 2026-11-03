/**
 * Tests for lib/node/pi/ext/drop-confirm.ts.
 *
 * Drives the real bounded approval presenter with a synthetic terminal and
 * scripted keys, then checks decisions and session flags. The native select
 * is forbidden so a return to the unbounded initial menu fails these tests.
 * Feedback input and the subsequent multi-select result are stubbed here;
 * the tmux integration exercises the complete flow.
 */

import type { ExtensionContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, type TUI } from '@earendil-works/pi-tui';
import { expect, test } from 'vitest';

import {
  confirmDrop,
  type ConfirmDropArgs,
  type DropSessionFlags,
  emptyDropFlags,
} from '../../../../../lib/node/pi/ext/drop-confirm.ts';
import { buildDropEntries, type DropTitleItem } from '../../../../../lib/node/pi/context-edit/agent-drop.ts';
import type { ModalFactory } from '../../../../../lib/node/pi/ext/show-modal.ts';

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
  let mounts = 0;
  const bindings: Partial<Record<string, Parameters<typeof matchesKey>[1]>> = {
    'tui.select.up': 'up',
    'tui.select.down': 'down',
    'tui.select.confirm': 'enter',
    'tui.select.cancel': 'escape',
  };
  const kb = {
    matches: (data: string, action: string): boolean => {
      const key = bindings[action];
      return key !== undefined && matchesKey(data, key);
    },
  } as unknown as KeybindingsManager;
  const theme = {
    fg: (_token: string, text: string): string => text,
    bold: (text: string): string => text,
  } as unknown as Theme;
  const tui = {
    terminal: { rows: 24, columns: 100 },
    requestRender: (): void => {
      /* no-op */
    },
  } as unknown as TUI;
  return {
    hasUI,
    ui: {
      select: () => Promise.reject(new Error('Drop approval must not use the unbounded native select')),
      input: async () => ui.inputValue,
      custom: async <T>(factory: ModalFactory<T>): Promise<T> => {
        if (mounts++ > 0) return ui.customResult as T;
        let result: T | undefined;
        const component = await factory(tui, theme, kb, (value) => {
          result = value;
        });
        component.render(100);
        const options = buildDropEntries('drop_image').map((entry) => entry.label);
        const choice = ui.selectLabel?.(options);
        const index = options.indexOf(choice ?? '');
        for (let i = 0; i < index; i++) component.handleInput?.('\u001b[B');
        component.handleInput?.(index < 0 ? '\u001b' : '\r');
        return result as T;
      },
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
