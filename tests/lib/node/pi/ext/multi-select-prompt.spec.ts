/**
 * Tests for lib/node/pi/ext/multi-select-prompt.ts.
 *
 * The module imports `@earendil-works/pi-coding-agent` (a type-only
 * import for `ExtensionContext`) and `@earendil-works/pi-tui`
 * (`Key` / `matchesKey` / `truncateToWidth`), both of which load under
 * vitest. We fake `ctx.ui.custom` so the test can capture the mounted
 * component, drive its `handleInput`, and assert what `done(...)` resolves
 * to - exercising the uncheck-the-keeper key handling without a real TUI.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, test } from 'vitest';

import { promptMultiSelect } from '../../../../../lib/node/pi/ext/multi-select-prompt.ts';

interface Driver {
  handleInput?(data: string): void;
  render(width: number): string[];
}

// Fake ctx whose ui.custom synchronously invokes the factory and stashes
// the component + its `done` resolver for the test to drive.
function fakeCtx(hasUI: boolean): { ctx: ExtensionContext; driver: () => Driver } {
  let component: Driver | undefined;
  const theme = { fg: (_c: string, t: string) => t };
  const tui = { requestRender: () => undefined };
  const ctx = {
    hasUI,
    ui: {
      custom: <T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => Driver): Promise<T> =>
        new Promise<T>((resolve) => {
          component = factory(tui, theme, {}, resolve);
        }),
    },
  } as unknown as ExtensionContext;
  return { ctx, driver: () => component! };
}

test('non-interactive (no UI) resolves undefined without mounting a dialog', async () => {
  const { ctx } = fakeCtx(false);
  await expect(promptMultiSelect(ctx, { title: 't', items: [{ label: 'A' }] })).resolves.toBeUndefined();
});

test('all rows start checked; Space unchecks the keeper, Enter resolves the drop set', async () => {
  const { ctx, driver } = fakeCtx(true);
  const p = promptMultiSelect(ctx, { title: 'pick', items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] });
  const comp = driver();
  // Cursor starts at row 0; Space unchecks it (the keeper).
  comp.handleInput?.(' ');
  comp.handleInput?.('\r');
  await expect(p).resolves.toEqual([1, 2]);
});

test('Esc cancels and resolves undefined', async () => {
  const { ctx, driver } = fakeCtx(true);
  const p = promptMultiSelect(ctx, { title: 'pick', items: [{ label: 'A' }, { label: 'B' }] });
  driver().handleInput?.('\u001b');
  await expect(p).resolves.toBeUndefined();
});

test('renders the title, every checkbox row, and the help line', async () => {
  const { ctx, driver } = fakeCtx(true);
  void promptMultiSelect(ctx, { title: 'Drop these?', items: [{ label: 'Alpha' }, { label: 'Beta' }] });
  const lines = driver().render(80).join('\n');
  expect(lines).toContain('Drop these?');
  expect(lines).toContain('[x] Alpha');
  expect(lines).toContain('[x] Beta');
  expect(lines).toContain('Space toggle');
});
