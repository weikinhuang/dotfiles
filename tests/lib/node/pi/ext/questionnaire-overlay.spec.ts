import type { ExtensionAPI, KeybindingsManager, Theme, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, visibleWidth, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui';
import { afterEach, expect, test, vi } from 'vitest';

import questionnaire from '../../../../../config/pi/extensions/questionnaire.ts';
import type { ModalFactory, ModalOptions } from '../../../../../lib/node/pi/ext/show-modal.ts';

afterEach(() => vi.unstubAllEnvs());

const theme = {
  fg: (_token: string, text: string): string => text,
  bg: (_token: string, text: string): string => text,
  bold: (text: string): string => text,
} as unknown as Theme;

type Screen = Component & Partial<Focusable>;
type TestTui = TUI & { terminal: { rows: number; columns: number } };

async function withQuestionnaire(
  questions: Record<string, unknown>[],
  exercise: (screen: Screen, tui: TestTui) => void,
): Promise<void> {
  vi.stubEnv('PI_QUESTIONNAIRE_DISABLED', '0');
  let tool: ToolDefinition | undefined;
  questionnaire({
    registerTool: (definition: ToolDefinition) => {
      tool = definition;
    },
  } as unknown as ExtensionAPI);
  expect(tool).toBeDefined();
  const tui = {
    terminal: { rows: 20, columns: 120 },
    requestRender: vi.fn(),
  } as unknown as TestTui;
  const kb = { getKeys: () => ['ctrl+g'], matches: () => false } as unknown as KeybindingsManager;
  const ctx = {
    hasUI: true,
    ui: {
      custom: async <T>(factory: ModalFactory<T>, options?: ModalOptions): Promise<T> => {
        expect(options?.overlay).toBe(true);
        let result: T | undefined;
        const screen: Screen = await factory(tui, theme, kb, (value) => {
          result = value;
        });
        screen.focused = true;
        exercise(screen, tui);
        screen.handleInput?.('\u001b');
        screen.handleInput?.('\u001b');
        expect(result).toBeDefined();
        return result as T;
      },
    },
  };
  await tool!.execute('test', { questions, allowChat: true }, undefined, undefined, ctx as never);
}

function assertBounded(screen: Screen, tui: TUI, width: number): string[] {
  const lines = screen.render(width);
  expect(lines.length).toBeLessThanOrEqual(tui.terminal.rows - 2);
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  return lines;
}

const options = Array.from({ length: 60 }, (_, i) => ({
  value: String(i),
  label: `Option ${i}`,
  description: 'A description that can wrap on narrow terminals.',
  preview: Array.from({ length: 80 }, (_, j) => `Preview ${i} row ${j}`).join('\n'),
}));

test('questionnaire: split and stacked previews stay bounded and follow the selected option on resize', async () => {
  await withQuestionnaire([{ id: 'q', prompt: 'Choose an option', options, allowOther: false }], (screen, tui) => {
    assertBounded(screen, tui, 120);
    for (let i = 0; i < 59; i++) screen.handleInput?.('\u001b[B');
    const selected = assertBounded(screen, tui, 120);
    expect(selected.some((line) => line.includes('Option 59'))).toBe(true);
    expect(selected.some((line) => line.includes('Preview 59 row 0'))).toBe(true);
    tui.terminal.rows = 12;
    expect(assertBounded(screen, tui, 35).some((line) => line.includes('Option 59'))).toBe(true);
    tui.terminal.rows = 28;
    assertBounded(screen, tui, 100);
  });
});

test('questionnaire: a split preview stays reachable after selecting the last of many options', async () => {
  await withQuestionnaire([{ id: 'q', prompt: 'Choose', options, allowOther: false }], (screen, tui) => {
    assertBounded(screen, tui, 120);
    for (let i = 0; i < 59; i++) screen.handleInput?.('\u001b[B');
    assertBounded(screen, tui, 120);
    for (let i = 0; i < 80; i++) {
      screen.handleInput?.('\u001b[6~');
      assertBounded(screen, tui, 120);
    }
    expect(assertBounded(screen, tui, 120).some((line) => line.includes('Preview 59 row 79'))).toBe(true);
  });
});

test('questionnaire: long prompts remain reachable with page scrolling', async () => {
  const prompt = Array.from({ length: 80 }, (_, i) => `Prompt row ${i}`).join('\n');
  await withQuestionnaire([{ id: 'q', prompt, options: options.slice(0, 2), allowOther: false }], (screen, tui) => {
    const selected = assertBounded(screen, tui, 70);
    expect(selected.some((line) => line.includes('Option 0'))).toBe(true);
    screen.handleInput?.('\u001b[5~');
    const previous = assertBounded(screen, tui, 70);
    expect(previous).not.toEqual(selected);
    expect(previous.some((line) => line.includes('Prompt row'))).toBe(true);
  });
});

test.each([60, 120])('questionnaire: every preview line remains reachable at width %i', async (width) => {
  await withQuestionnaire(
    [{ id: 'q', prompt: 'Choose', options: options.slice(0, 1), allowOther: false }],
    (screen, tui) => {
      assertBounded(screen, tui, width);
      for (let i = 0; i < 80; i++) {
        screen.handleInput?.('\u001b[6~');
        assertBounded(screen, tui, width);
      }
      expect(assertBounded(screen, tui, width).some((line) => line.includes('Preview 0 row 79'))).toBe(true);
    },
  );
});

test.each(['free', 'single'])('questionnaire: long %s answers/notes retain the visible editor cursor', async (kind) => {
  await withQuestionnaire([{ id: 'q', prompt: 'Write something', kind, options }], (screen, tui) => {
    assertBounded(screen, tui, 70);
    screen.handleInput?.(kind === 'free' ? 'x' : 'n');
    screen.handleInput?.(`\u001b[200~${Array.from({ length: 80 }, (_, i) => `Answer ${i}`).join('\n')}\u001b[201~`);
    tui.terminal.rows = 12;
    const lines = assertBounded(screen, tui, 40);
    expect(lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
  });
});

test('questionnaire: long review keeps submit controls visible and answers scrollable', async () => {
  const questions = Array.from({ length: 40 }, (_, i) => ({
    id: `q${i}`,
    label: `Question ${i}`,
    prompt: 'Choose',
    default: 'yes',
    options: [{ value: 'yes', label: `Answer ${i} with a lengthy explanation that wraps over several lines` }],
  }));
  await withQuestionnaire(questions, (screen, tui) => {
    for (let i = 0; i < 40; i++) screen.handleInput?.('\t');
    const review = assertBounded(screen, tui, 55);
    expect(review.some((line) => line.includes('Submit answers'))).toBe(true);
    screen.handleInput?.('\u001b[5~');
    expect(assertBounded(screen, tui, 55).some((line) => line.includes('Answer'))).toBe(true);
  });
});

test('questionnaire: disable switch skips registration', () => {
  vi.stubEnv('PI_QUESTIONNAIRE_DISABLED', '1');
  const registerTool = vi.fn();
  questionnaire({ registerTool } as unknown as ExtensionAPI);
  expect(registerTool).not.toHaveBeenCalled();
});
