/** Synthetic UI drivers exercise the real picker, wrapping, and viewport helpers. */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { expect, test } from 'vitest';

import { promptMultiSelect } from '../../../../../lib/node/pi/ext/multi-select-prompt.ts';
import { isModalUiActive } from '../../../../../lib/node/pi/ui-activity.ts';

interface Driver {
  handleInput?(data: string): void;
  render(width: number): string[];
  invalidate(): void;
}

interface FakeHost {
  ctx: ExtensionContext;
  terminal: { rows: number; columns: number };
  driver: () => Driver;
  render: () => string[];
  mounts: () => number;
}

// Only the host is synthetic: the picker, list, modal, and windowing code are real.
function fakeCtx(hasUI: boolean, rows = 24, columns = 80): FakeHost {
  let component: Driver | undefined;
  let mounts = 0;
  const theme = { fg: (_c: string, t: string) => t };
  const terminal = { rows, columns };
  const tui = { terminal, requestRender: () => undefined };
  const ctx = {
    hasUI,
    ui: {
      custom: <T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => Driver): Promise<T> =>
        new Promise<T>((resolve) => {
          mounts++;
          component = factory(tui, theme, {}, resolve);
        }),
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    terminal,
    driver: () => component!,
    render: () => component!.render(terminal.columns),
    mounts: () => mounts,
  };
}

const down = '\u001b[B';
const up = '\u001b[A';

function expectBounded(lines: string[], rows: number, width: number): void {
  expect(lines.length).toBeLessThanOrEqual(Math.max(1, rows - 2));
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

test('non-interactive (no UI) resolves undefined without mounting a dialog', async () => {
  const host = fakeCtx(false);
  await expect(promptMultiSelect(host.ctx, { title: 't', items: [{ label: 'A' }] })).resolves.toBeUndefined();
  expect(host.mounts()).toBe(0);
});

test('all rows start checked; Space unchecks the keeper, Enter resolves the drop set', async () => {
  const { ctx, driver } = fakeCtx(true);
  const p = promptMultiSelect(ctx, { title: 'pick', items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] });
  expect(isModalUiActive()).toBe(true);
  driver().handleInput?.(' ');
  driver().handleInput?.('\r');
  await expect(p).resolves.toEqual([1, 2]);
  expect(isModalUiActive()).toBe(false);
});

test('Esc cancels even after modifying an explicit initial selection', async () => {
  const { ctx, driver } = fakeCtx(true);
  const p = promptMultiSelect(ctx, { title: 'pick', items: [{ label: 'A' }, { label: 'B' }], initialSelected: [1] });
  driver().handleInput?.(' ');
  driver().handleInput?.('\u001b');
  await expect(p).resolves.toBeUndefined();
  expect(isModalUiActive()).toBe(false);
});

test('explicit initial selection, digit jump, and up/down navigation preserve the drop set', async () => {
  const { ctx, driver } = fakeCtx(true);
  const p = promptMultiSelect(ctx, {
    title: 'pick',
    items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    initialSelected: new Set([1]),
  });
  driver().handleInput?.('3');
  driver().handleInput?.(up);
  driver().handleInput?.(' ');
  driver().handleInput?.(down);
  driver().handleInput?.(' ');
  driver().handleInput?.('9'); // Invalid digit leaves the cursor alone.
  driver().handleInput?.('\r');
  await expect(p).resolves.toEqual([2]);
});

test('renders the pinned title, checkbox rows, and help line', async () => {
  const host = fakeCtx(true);
  const p = promptMultiSelect(host.ctx, { title: 'Drop these?', items: [{ label: 'Alpha' }, { label: 'Beta' }] });
  const lines = host.render().join('\n');
  expect(lines).toContain('Drop these?');
  expect(lines).toContain('[x] Alpha');
  expect(lines).toContain('[x] Beta');
  expect(lines).toContain('Space toggle');
  host.driver().handleInput?.('\r');
  await expect(p).resolves.toEqual([0, 1]);
});

test.each([12, 24])('many items scroll to the bottom within a %i-row terminal', async (rows) => {
  const host = fakeCtx(true, rows);
  const items = Array.from({ length: 60 }, (_, i) => ({ label: `Item ${i + 1}`, description: `Detail ${i + 1}` }));
  const p = promptMultiSelect(host.ctx, { title: 'Drop these?', items });
  expect(host.render().join('\n')).toContain('❯ 1. [x] Item 1');
  for (let i = 1; i < items.length; i++) {
    host.driver().handleInput?.(down);
    const lines = host.render();
    expectBounded(lines, rows, 80);
    expect(lines[0]).toBe('Drop these?');
    expect(lines.at(-1)).toContain('Space toggle');
    expect(lines.join('\n')).toContain(`❯ ${i + 1}. [x] Item ${i + 1}`);
  }
  expect(host.render().join('\n')).toContain('Detail 60');
  expect(host.render().join('\n')).not.toContain('Item 1\n');
  host.driver().handleInput?.(' ');
  expect(host.render().join('\n')).toContain('❯ 60. [ ] Item 60');
  host.driver().handleInput?.('\r');
  await expect(p).resolves.toEqual(Array.from({ length: 59 }, (_, i) => i));
});

test('wrapped descriptions determine scroll ranges and reflow on width and height changes without invalidation', async () => {
  const host = fakeCtx(true, 18, 38);
  const description = 'A long description with enough words to wrap across several terminal rows. END';
  const items = Array.from({ length: 15 }, (_, i) => ({ label: `Item ${i + 1}`, description }));
  const p = promptMultiSelect(host.ctx, { title: 'Collapse outputs?', items });
  host.render();
  for (let i = 1; i < items.length; i++) host.driver().handleInput?.(down);
  const narrow = host.render();
  expectBounded(narrow, 18, 38);
  expect(narrow.join('\n')).toContain('❯ 15. [x] Item 15');
  expect(narrow.join('\n')).toContain('END');
  expect(narrow.some((line) => line.includes('across several terminal rows. END'))).toBe(false);

  host.terminal.columns = 100;
  const wide = host.render();
  expect(wide).not.toEqual(narrow);
  expect(wide.join('\n')).toContain(description);
  expect(wide.join('\n')).toContain('❯ 15. [x] Item 15');
  expectBounded(wide, 18, 100);

  host.terminal.rows = 10;
  const short = host.render();
  expectBounded(short, 10, 100);
  expect(short).not.toEqual(wide);
  expect(short.join('\n')).toContain('❯ 15. [x] Item 15');
  host.terminal.columns = 30;
  expectBounded(host.render(), 10, 30);
  expect(host.render().join('\n')).toContain('❯ 15. [x] Item 15');
  host.driver().handleInput?.('\u001b');
  await expect(p).resolves.toBeUndefined();
});

test.each([1, 2, 3, 5, 7])(
  'tiny %i-row terminals hard-bound even multiline chrome and long descriptions',
  async (rows) => {
    const host = fakeCtx(true, rows, 20);
    const p = promptMultiSelect(host.ctx, {
      title: 'Drop?\nMany title lines\nAnother title line\nOne more',
      items: Array.from({ length: 20 }, (_, i) => ({ label: `Item ${i}`, description: 'very long '.repeat(30) })),
    });
    expectBounded(host.render(), rows, 20);
    for (let i = 0; i < 19; i++) host.driver().handleInput?.(down);
    expectBounded(host.render(), rows, 20);
    host.driver().handleInput?.('\u001b');
    await expect(p).resolves.toBeUndefined();
  },
);

test('empty items can be confirmed without manufacturing a selection', async () => {
  const host = fakeCtx(true);
  const p = promptMultiSelect(host.ctx, { title: 'Nothing to drop', items: [], initialSelected: [] });
  expectBounded(host.render(), 24, 80);
  host.driver().handleInput?.('9');
  host.driver().handleInput?.(down);
  host.driver().handleInput?.('\r');
  await expect(p).resolves.toEqual([]);
});
