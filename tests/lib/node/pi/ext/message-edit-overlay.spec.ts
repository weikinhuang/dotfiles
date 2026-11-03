import { describe, expect, test, vi, type Mock } from 'vitest';

import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import {
  CURSOR_MARKER,
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
  type TUI,
} from '@earendil-works/pi-tui';

import { type MessageEditItem } from '../../../../../lib/node/pi/context-edit/messages.ts';
import { MessageEditOverlay, type MessageEditResult } from '../../../../../lib/node/pi/ext/message-edit-overlay.ts';

const theme = {
  fg: (_token: string, text: string): string => text,
  bold: (text: string): string => text,
} as unknown as Theme;

interface OverlayHarness {
  overlay: MessageEditOverlay;
  save: Mock<(item: MessageEditItem, text: string) => MessageEditResult>;
  restore: Mock<(id: number) => MessageEditResult>;
  close: Mock;
  tui: TUI & { terminal: { rows: number; columns: number } };
  setItems: (next: MessageEditItem[]) => void;
  getItems: () => MessageEditItem[];
}

function setup(
  count = 35,
  options: { query?: string; editedOnly?: boolean; editKey?: string; reverse?: boolean } = {},
): OverlayHarness {
  let items: MessageEditItem[] = Array.from({ length: count }, (_, i) => ({
    id: `msg${i + 1}`,
    key: `key${i + 1}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    target: { by: 'message', role: i % 2 === 0 ? 'user' : 'assistant', timestamp: i + 1 },
    original: `Message ${i + 1} original 界 🌻`,
    text: `Message ${i + 1} original 界 🌻`,
    stale: false,
    nonTextParts: 0,
  }));
  if (options.reverse) items.reverse();
  const save = vi.fn((item: MessageEditItem, text: string) => {
    items = items.map((candidate) => (candidate.key === item.key ? { ...candidate, text, editId: 7 } : candidate));
    return { ok: true, message: `Saved ${item.id}. Undo: /context-edit restore 7` };
  });
  const restore = vi.fn((id: number) => {
    items = items.map((item) => (item.editId === id ? { ...item, text: item.original, editId: undefined } : item));
    return { ok: true, message: `Restored #${id}.` };
  });
  const close = vi.fn();
  const tui = {
    terminal: { rows: 24, columns: 100 },
    requestRender: vi.fn(),
  } as unknown as TUI & { terminal: { rows: number; columns: number } };
  const kb = new TuiKeybindingsManager({
    ...TUI_KEYBINDINGS,
    'app.editor.external': { defaultKeys: 'ctrl+g' },
  }) as unknown as KeybindingsManager;
  const overlay = new MessageEditOverlay({ getItems: () => items, save, restore }, theme, tui, kb, close, options);
  overlay.focused = true;
  return {
    overlay,
    save,
    restore,
    close,
    tui,
    setItems: (next: MessageEditItem[]): void => {
      items = next;
    },
    getItems: (): MessageEditItem[] => items,
  };
}

const screen = (overlay: MessageEditOverlay, width = 100): string => overlay.render(width).join('\n');

describe('MessageEditOverlay browser', () => {
  test('starts at latest assistant, windows the list and shows search and pinned controls', () => {
    const { overlay } = setup();
    const text = screen(overlay);
    expect(text).toContain('> msg34 assistant');
    expect(text).toContain('Preview: msg34 · CURRENT');
    expect(text).toContain('Search:');
    expect(text).toContain('Enter edit');
    expect(overlay.render(100).length).toBeLessThanOrEqual(22);
  });

  test('initial latest-assistant focus does not depend on size/list order', () => {
    const { overlay } = setup(35, { reverse: true });
    expect(screen(overlay)).toContain('> msg34 assistant');
  });

  test('search supports spaces and typed action letters; editing preserves query and selection', () => {
    const { overlay, save } = setup(4);
    overlay.handleInput('Message 2 original');
    expect(screen(overlay)).toContain('> msg2 assistant');
    expect(screen(overlay)).not.toContain('> msg4');
    overlay.handleInput('\r');
    expect(screen(overlay)).toContain('Edit msg2 · assistant');
    overlay.handleInput(' changed');
    overlay.handleInput('\x13');
    expect(save).toHaveBeenCalledOnce();
    expect(screen(overlay)).toContain('Search: > Message 2 original');
    expect(screen(overlay)).toContain('> msg2 assistant [edited #7]');
  });

  test('role and edited filters are independent and empty results remain usable', () => {
    const { overlay, setItems, getItems } = setup(4);
    setItems(getItems().map((item, index) => (index === 1 ? Object.assign({}, item, { editId: 2 }) : item)));
    overlay.handleInput('\x05'); // Ctrl+E edited only
    expect(screen(overlay)).toContain('1 matches');
    overlay.handleInput('\x14'); // Ctrl+T user
    expect(screen(overlay)).toContain('Role: user');
    expect(screen(overlay)).toContain('No matching messages');
    overlay.handleInput('\x14'); // assistant
    expect(screen(overlay)).toContain('> msg2 assistant [edited #2]');
  });

  test('preview scroll is independent of selection, with original/current comparison', () => {
    const { overlay, getItems, setItems } = setup(2);
    setItems(
      getItems().map((item) =>
        item.id === 'msg2'
          ? Object.assign({}, item, {
              editId: 3,
              text: Array.from({ length: 100 }, (_, i) => `Edited line ${i}`).join('\n'),
            })
          : item,
      ),
    );
    overlay.render(100);
    overlay.handleInput('\t');
    overlay.handleInput('\x1b[F');
    expect(screen(overlay)).toContain('Edited line 99');
    expect(screen(overlay)).toContain('> msg2 assistant');
    overlay.handleInput('\x0f'); // Ctrl+O
    expect(screen(overlay)).toContain('Preview: msg2 · ORIGINAL');
    expect(screen(overlay)).toContain('Message 2 original');
    expect(screen(overlay)).not.toContain('Edited line 99');
  });

  test('restore works from edited-only view and keeps the browser open', () => {
    const { overlay, getItems, setItems, restore, close } = setup(2, { editedOnly: true });
    setItems(getItems().map((item) => (item.id === 'msg2' ? Object.assign({}, item, { editId: 3 }) : item)));
    overlay.handleInput('\x12');
    expect(restore).toHaveBeenCalledWith(3);
    expect(screen(overlay)).toContain('Restored #3');
    expect(screen(overlay)).toContain('No matching messages');
    expect(close).not.toHaveBeenCalled();
  });

  test('stale edits can be restored but cannot be edited', () => {
    const { overlay, getItems, setItems, restore } = setup(1);
    setItems(getItems().map((item) => Object.assign({}, item, { stale: true, editId: 3 })));
    overlay.handleInput('\r');
    expect(screen(overlay)).toContain('outside the current context');
    expect(screen(overlay)).not.toContain('Ctrl+S');
    overlay.handleInput('\x12');
    expect(restore).toHaveBeenCalledWith(3);
  });

  test('browser closes on Escape, and empty histories render safely', () => {
    const { overlay, close } = setup(0);
    expect(screen(overlay)).toContain('No matching messages');
    overlay.handleInput('\x1b');
    expect(close).toHaveBeenCalledOnce();
  });

  test('list, preview, and editor stay width/height bounded during resize, including tiny terminals', () => {
    const { overlay, tui } = setup(100);
    for (const [width, rows] of [
      [100, 40],
      [45, 16],
      [20, 10],
      [10, 5],
      [1, 3],
    ]) {
      tui.terminal.rows = rows;
      const lines = overlay.render(width);
      expect(lines.length).toBeLessThanOrEqual(Math.max(1, rows - 2));
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });
});

describe('MessageEditOverlay explicit-save editor', () => {
  test('Enter adds a newline without saving; Ctrl+S explicitly saves', () => {
    const { overlay, save } = setup(2, { editKey: 'key2' });
    overlay.handleInput('\r');
    overlay.handleInput('second line');
    expect(save).not.toHaveBeenCalled();
    expect(screen(overlay)).toContain('unsaved');
    expect(screen(overlay)).toContain('Ctrl+S / Cmd+S save');
    expect(screen(overlay)).toContain('Enter newline');
    overlay.handleInput('\x13');
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][1]).toContain('\nsecond line');
    expect(screen(overlay)).toContain('Context edit');
  });

  test('Super+S saves when the terminal forwards the Kitty modifier', () => {
    const { overlay, save } = setup(2, { editKey: 'key2' });
    overlay.handleInput(' changed');
    overlay.handleInput('\x1b[115;9u');
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][1]).not.toContain('[115;9u');
  });

  test('save expands bracketed-paste markers and preserves leading/trailing whitespace', () => {
    const { overlay, save } = setup(2, { editKey: 'key2' });
    const pasted = `  start\n${'body\n'.repeat(30)}end  \n`;
    overlay.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    overlay.handleInput('\x13');
    expect(save.mock.calls[0][1]).toContain(pasted);
    expect(save.mock.calls[0][1]).not.toMatch(/\[paste/i);
  });

  test('unchanged save is a no-op; cancelling a dirty draft requires explicit discard', () => {
    const { overlay, save } = setup(2, { editKey: 'key2' });
    overlay.handleInput('\x13');
    expect(save).not.toHaveBeenCalled();
    expect(screen(overlay)).toContain('No change.');
    overlay.handleInput('\r');
    overlay.handleInput(' draft');
    overlay.handleInput('\x1b');
    expect(screen(overlay)).toContain('Discard unsaved changes?');
    overlay.handleInput('\x1b');
    expect(screen(overlay)).toContain('Edit msg2');
    overlay.handleInput('\x1b');
    overlay.handleInput('\x04');
    expect(screen(overlay)).toContain('Edit cancelled. No changes saved.');
    expect(save).not.toHaveBeenCalled();
  });

  test('persistence errors leave the draft editable and allow retry', () => {
    const { overlay, save } = setup(2, { editKey: 'key2' });
    save.mockReturnValueOnce({ ok: false, message: 'Not saved: disk full' });
    overlay.handleInput(' draft');
    overlay.handleInput('\x13');
    expect(screen(overlay)).toContain('Not saved: disk full');
    expect(screen(overlay)).toContain('Edit msg2 · assistant · unsaved');
    overlay.handleInput('\x13');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][1]).toBe(save.mock.calls[1][1]);
  });

  test('editor forwards focus for the cursor and keeps save hint visible after resizing long content', () => {
    const { overlay, tui } = setup(2, { editKey: 'key2' });
    overlay.handleInput(`\x1b[200~${'界 🌻 long line\n'.repeat(120)}\x1b[201~`);
    for (const [width, rows] of [
      [100, 40],
      [45, 16],
      [20, 10],
    ]) {
      tui.terminal.rows = rows;
      const lines = overlay.render(width);
      expect(lines.length).toBeLessThanOrEqual(rows - 2);
      expect(lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
      expect(lines.some((line) => line.includes('Ctrl+S'))).toBe(true);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });
});
