import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, visibleWidth, type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { expect, test, vi } from 'vitest';

import { ApprovalSelectOverlay, promptApprovalSelect } from '../../../../../lib/node/pi/ext/approval-select.ts';
import type { ModalFactory, ModalOptions } from '../../../../../lib/node/pi/ext/show-modal.ts';

const theme = {
  fg: (_token: string, text: string): string => text,
  bold: (text: string): string => text,
} as unknown as Theme;
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
const options = [
  'Allow once',
  'Allow collapse_output for this session',
  'Edit selection…',
  'Deny',
  'Deny with feedback…',
  'Never allow this session',
];
const title = Array.from(
  { length: 300 },
  (_, i) => `TARGET_${String(i).padStart(3, '0')} synthetic output ${'description '.repeat(5)}`,
).join('\n');

interface Harness {
  overlay: ApprovalSelectOverlay;
  terminal: { rows: number; columns: number };
  done: ReturnType<typeof vi.fn>;
}

function makeOverlay(rows = 24, labels = options): Harness {
  const terminal = { rows, columns: 100 };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const done = vi.fn();
  return { overlay: new ApprovalSelectOverlay(title, labels, theme, tui, kb, done), terminal, done };
}

function assertBounded(overlay: ApprovalSelectOverlay, rows: number, width: number): string[] {
  const lines = overlay.render(width);
  expect(lines.length).toBeLessThanOrEqual(Math.max(1, rows - 2));
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  return lines;
}

test('approval: a 300-line title cannot hide the six decision options', () => {
  const { overlay } = makeOverlay();
  const lines = assertBounded(overlay, 24, 100);
  for (const option of options) expect(lines.some((line) => line.includes(option))).toBe(true);
  expect(lines.some((line) => line.includes('TARGET_000'))).toBe(true);
  expect(lines.some((line) => line.includes('TARGET_299'))).toBe(false);
});

test('approval: detail paging, Home, End and mouse wheel leave the decision unchanged', () => {
  const { overlay, done } = makeOverlay();
  overlay.render(100);
  for (let i = 0; i < 3; i++) overlay.handleInput('\u001b[B');
  const initial = overlay.render(100);
  overlay.handleInput('\u001b[6~');
  expect(overlay.render(100)).not.toEqual(initial);
  expect(overlay.render(100).some((line) => line === '❯ Deny')).toBe(true);
  overlay.handleInput('\u001b[F');
  expect(overlay.render(100).some((line) => line.includes('TARGET_299'))).toBe(true);
  overlay.handleInput('\u001b[H');
  expect(overlay.render(100)).toEqual(initial);
  overlay.handleMouse({ type: 'wheel', wheelDelta: 5 } as TuiMouseEvent);
  expect(overlay.render(100)).not.toEqual(initial);
  overlay.handleInput('\r');
  expect(done).toHaveBeenCalledWith('Deny');
});

test('approval: selected choices stay reachable through short-terminal and width changes', () => {
  const { overlay, terminal, done } = makeOverlay();
  overlay.render(100);
  for (let i = 0; i < 5; i++) overlay.handleInput('\u001b[B');
  for (const [width, rows] of [
    [40, 10],
    [80, 12],
    [120, 30],
    [20, 6],
  ]) {
    terminal.rows = rows;
    const lines = assertBounded(overlay, rows, width);
    expect(lines.some((line) => line.includes('❯ Never'))).toBe(true);
  }
  overlay.handleInput('\r');
  expect(done).toHaveBeenCalledWith('Never allow this session');
});

test.each([1, 2, 3, 4, 5, 6, 8, 10, 12, 20])(
  'approval: hard-bounds a %i-row terminal and allows cancellation',
  (rows) => {
    const { overlay, done } = makeOverlay(rows);
    for (const width of [1, 12, 40, 100]) assertBounded(overlay, rows, width);
    overlay.handleInput('\u001b');
    expect(done).toHaveBeenCalledWith(undefined);
  },
);

test('approval: empty options confirm as undefined rather than granting permission', () => {
  const { overlay, done } = makeOverlay(20, []);
  assertBounded(overlay, 20, 80);
  overlay.handleInput('\r');
  expect(done).toHaveBeenCalledWith(undefined);
});

test('approval: presenter mounts a real overlay and returns the original option string', async () => {
  let received: ModalOptions | undefined;
  const ui = {
    custom: async <T>(factory: ModalFactory<T>, options?: ModalOptions): Promise<T> => {
      received = options;
      let result: T | undefined;
      const { terminal } = makeOverlay();
      const component = await factory({ terminal, requestRender: vi.fn() } as unknown as TUI, theme, kb, (value) => {
        result = value;
      });
      component.render(100);
      component.handleInput?.('\u001b[B');
      component.handleInput?.('\r');
      return result as T;
    },
  };
  await expect(promptApprovalSelect(ui, title, options)).resolves.toBe(options[1]);
  expect(received?.overlay).toBe(true);
});
