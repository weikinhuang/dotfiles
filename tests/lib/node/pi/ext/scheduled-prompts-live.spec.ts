import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import { Container, Text, type Component } from '@earendil-works/pi-tui';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import scheduledPrompts from '../../../../../config/pi/extensions/scheduled-prompts.ts';
import type { LiveCardRenderContext as ToolRenderContext } from '../../../../../lib/node/pi/ext/live-tool-cards.ts';

interface Result {
  content: { type: 'text'; text: string }[];
  details: { action: string };
  isError?: boolean;
}

interface Tool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    ctx: unknown,
  ) => Promise<Result>;
  renderCall: (args: Record<string, unknown>, theme: Theme, context: ToolRenderContext) => Component;
  renderResult: (result: Result, options: { expanded: boolean }, theme: Theme, context: ToolRenderContext) => Component;
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

interface Runtime {
  emit: (event: string, data?: object) => unknown;
  sendMessage: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  command: (name: string, args: string) => Promise<void>;
  shutdown: (reason?: string) => unknown;
  card: (
    params: Record<string, unknown>,
    capture?: boolean,
  ) => Promise<{
    result: Result;
    invalidate: ReturnType<typeof vi.fn>;
    render: (freshState?: boolean, expanded?: boolean, width?: number) => string;
    component: (expanded?: boolean) => Component;
  }>;
}

function load(cwd: string, mode = 'tui'): Runtime {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  let tool: Tool;
  const sendMessage = vi.fn();
  const appendEntry = vi.fn();
  const notify = vi.fn();
  const ctx = { cwd, mode, hasUI: mode === 'tui' || mode === 'rpc', isIdle: () => true, ui: { notify } };
  scheduledPrompts({
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
    registerTool: (definition: Tool) => {
      tool = definition;
    },
    registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, definition.handler),
    sendMessage,
    appendEntry,
  } as unknown as ExtensionAPI);
  const emit = (event: string, data = {}): unknown => handlers.get(event)?.(data, ctx);
  emit('session_start');
  let n = 0;
  return {
    emit,
    sendMessage,
    appendEntry,
    notify,
    command: (name: string, args: string) => commands.get(name)!(args, ctx),
    shutdown: (reason = 'quit') => emit('session_shutdown', { reason }),
    async card(params: Record<string, unknown>, capture = true) {
      const invalidate = vi.fn();
      const context = {
        toolCallId: `schedule-call-${n++}`,
        state: {},
        args: params,
        executionStarted: false,
        isPartial: false,
        invalidate,
      } as unknown as ToolRenderContext;
      if (capture) tool.renderCall(params, theme, context);
      context.executionStarted = true;
      const result = await tool.execute(context.toolCallId, params, undefined, undefined, ctx);
      return {
        result,
        invalidate,
        component(expanded = false): Component {
          return tool.renderResult(result, { expanded }, theme, context);
        },
        render(freshState = false, expanded = false, width = 4000): string {
          const row = freshState ? { ...context, state: {} } : context;
          tool.renderCall(params, theme, row);
          return tool
            .renderResult(result, { expanded }, theme, row)
            .render(width)
            .map((line) => line.trimEnd())
            .join('\n');
        },
      };
    },
  };
}

const idOf = (result: Result): string => result.content[0].text.split(' ')[1];
const current = (text: string): string => text.split('\n').at(-1)!;
const NOW = new Date('2026-01-01T08:00:00Z').getTime();

let dir: string;
let rt: Runtime;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'schedule-live-'));
  vi.stubEnv('PI_SCHEDULED_PROMPTS_DISABLED', '0');
  vi.stubEnv('PI_SCHEDULED_PROMPTS_DEBUG', '0');
  vi.stubEnv('PI_SCHEDULED_PROMPTS_DIR', dir);
  rt = load(dir);
});

afterEach(() => {
  rt.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('scheduled-prompts original live cards', () => {
  test('expanded details toggle without changing the exact collapsed snapshot as countdown updates', async () => {
    const prompt = 'Check the entire workspace\nKeep ${t} and ${d} literal until firing.';
    const card = await rt.card({ action: 'create', prompt, every: '10s', name: 'review', maxRuns: 3 });
    const id = idOf(card.result);
    const receipt = card.result.content[0].text;
    const bytes = JSON.stringify(card.result);
    const snapshot = `${receipt}\nCurrent ${id} (review) [session] every 10s | status: enabled | next: in 10s (${new Date(NOW + 10_000).toLocaleString()}) | runs: 0/3`;
    expect(card.render()).toBe(snapshot);
    expect(card.render(false, true)).toBe(
      `${snapshot}\nid: ${id}\nname: review\ntrigger: every 10s\nscope: session | status: enabled\nruns: 0 | maxRuns: 3 | unansweredRuns: 0\nlast fire: none\nnext fire: ${new Date(NOW + 10_000).toLocaleString()}\njitter: 0s | chance: 1\nresetOnActivity: false | whenIdle: false\nPrompt:\n${prompt}`,
    );
    expect(card.render()).toBe(snapshot);
    vi.advanceTimersByTime(1500);
    const updatedSnapshot = snapshot.replace('next: in 10s', 'next: in 8s');
    expect(card.render(false, true)).toContain(updatedSnapshot);
    expect(card.render()).toBe(updatedSnapshot);
    expect(card.render(true, true)).toBe(receipt);
    expect(JSON.stringify(card.result)).toBe(bytes);
    expect(rt.sendMessage).not.toHaveBeenCalled();
    expect(rt.appendEntry).not.toHaveBeenCalled();
    expect(rt.notify).not.toHaveBeenCalled();
  });

  test('prompt is bounded by eight actual wrapped rows and details have no controls or input handlers', async () => {
    const prompt = 'x'.repeat(200);
    const card = await rt.card({ action: 'create', prompt, every: '10s' });
    const component = card.component(true);
    expect(component).toBeInstanceOf(Container);
    const children = (component as Container).children;
    expect(children).toHaveLength(4);
    expect(children.every((child) => child instanceof Text)).toBe(true);
    expect(children.map((child) => 'handleInput' in child)).toEqual([false, false, false, false]);
    expect(children.map((child) => 'handleMouse' in child)).toEqual([false, false, false, false]);
    const promptRows = card.render(false, true, 20).split('Prompt:\n')[1].split('\n');
    expect(promptRows).toHaveLength(9);
    expect(promptRows.slice(0, 8)).toEqual(Array.from({ length: 8 }, () => 'x'.repeat(20)));
    expect(promptRows[8]).toBe('… (2 more lines)');
    expect(rt.sendMessage).not.toHaveBeenCalled();
    expect(rt.appendEntry).not.toHaveBeenCalled();
  });

  test('original create/update details follow pool changes and freeze through pause, resume, deletion', async () => {
    const create = await rt.card({ action: 'create', prompt: 'first', after: '10s-10s' });
    const id = idOf(create.result);
    create.render(false, true);
    const update = await rt.card({
      action: 'update',
      id,
      prompts: ['new ${t}', 'alternate ${d}'],
      roundRobin: true,
      name: 'pool',
    });
    const bytes = [create, update].map((card) => JSON.stringify(card.result));
    expect(create.render(false, true)).toContain('prompt pool: 2 | pick: roundRobin | cursor: 0');
    expect(update.render(false, true)).toContain('Prompt:\n1. new ${t}\n2. alternate ${d}');
    expect(create.render(false, true)).toContain('resetOnActivity: true | whenIdle: true');
    await rt.command('schedules', `off ${id}`);
    expect(create.render(false, true)).toContain('scope: session | status: paused');
    expect(update.render(false, true)).toContain('next fire: none');
    const paused = create.render(false, true);
    vi.advanceTimersByTime(1000);
    expect(create.render(false, true)).toBe(paused);
    await rt.command('schedules', `on ${id}`);
    expect(update.render(false, true)).toContain('scope: session | status: enabled');
    expect(create.render(false, true)).toContain(`next fire: ${new Date(NOW + 11_000).toLocaleString()}`);
    await rt.card({ action: 'delete', id });
    expect(create.render(false, true)).toContain('scope: session | status: deleted');
    expect(update.render(false, true)).toContain('Prompt:\n1. new ${t}\n2. alternate ${d}');
    const deleted = create.render(false, true);
    vi.advanceTimersByTime(60_000);
    expect(create.render(false, true)).toBe(deleted);
    expect([create, update].map((card) => JSON.stringify(card.result))).toEqual(bytes);
    expect(rt.sendMessage).not.toHaveBeenCalled();
    expect(rt.appendEntry).not.toHaveBeenCalled();
  });

  test('create countdown is UI-only, owns only the executing row, and keeps exact tool bytes', async () => {
    const card = await rt.card({ action: 'create', prompt: 'ping', every: '10s' });
    const id = idOf(card.result);
    expect(card.result).toEqual({
      content: [
        {
          type: 'text',
          text: `Created ${id} [session] every 10s - next in 10s (${new Date(NOW + 10_000).toLocaleString()})`,
        },
      ],
      details: { action: 'create' },
      isError: undefined,
    });
    const bytes = JSON.stringify(card.result);
    expect(vi.getTimerCount()).toBe(1); // The real scheduler, not a UI interval yet.
    expect(current(card.render())).toContain(`Current ${id}`);
    expect(current(card.render())).toContain('status: enabled | next: in 10s');
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(1500);
    expect(card.invalidate).toHaveBeenCalledTimes(3);
    expect(current(card.render())).toContain('next: in 8s');
    expect(current(card.render())).toContain('runs: 0');
    expect(card.render(true)).toBe(card.result.content[0].text); // HTML export/history has a fresh row state.
    expect(JSON.stringify(card.result)).toBe(bytes);
    expect(rt.sendMessage).not.toHaveBeenCalled();
    expect(rt.appendEntry).not.toHaveBeenCalled();
    expect(rt.notify).not.toHaveBeenCalled();
  });

  test('create/update bind actual schedule identity and all original rows follow later updates', async () => {
    const first = await rt.card({ action: 'create', prompt: 'first', every: '10s' });
    const second = await rt.card({ action: 'create', prompt: 'second', every: '30s' });
    const firstId = idOf(first.result);
    const secondId = idOf(second.result);
    first.render();
    second.render();
    const update = await rt.card({ action: 'update', id: firstId, every: '20s', name: 'renamed' });
    const bytes = [first, second, update].map((c) => JSON.stringify(c.result));
    expect(update.result.details).toEqual({ action: 'update' });
    expect(current(first.render())).toContain(`Current ${firstId} (renamed) [session] every 20s`);
    expect(current(update.render())).toContain(`Current ${firstId} (renamed)`);
    expect(current(second.render())).toContain(`Current ${secondId} [session] every 30s`);
    expect(vi.getTimerCount()).toBe(2); // One shared UI timer for all three rows.
    vi.advanceTimersByTime(20_000);
    expect(current(first.render())).toContain('runs: 1');
    expect(current(update.render())).toContain('runs: 1');
    expect(current(second.render())).toContain('runs: 0');
    expect(rt.sendMessage).toHaveBeenCalledExactlyOnceWith(
      { customType: 'scheduled-prompt', content: 'first', display: true },
      { triggerTurn: true },
    );
    expect([first, second, update].map((c) => JSON.stringify(c.result))).toEqual(bytes);
    expect(rt.appendEntry).not.toHaveBeenCalled();
  });

  test('pause disarms the UI timer but explicit command/tool changes resume original cards', async () => {
    const create = await rt.card({ action: 'create', prompt: 'ping', every: '10s' });
    const id = idOf(create.result);
    create.render();
    await rt.command('schedules', `off ${id}`);
    expect(create.invalidate).toHaveBeenCalled();
    expect(current(create.render())).toContain('status: paused | next: none | runs: 0');
    expect(vi.getTimerCount()).toBe(0);
    const invalidations = create.invalidate.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(create.invalidate).toHaveBeenCalledTimes(invalidations);
    const pausedUpdate = await rt.card({ action: 'update', id, name: 'paused update' });
    expect(current(pausedUpdate.render())).toContain('status: paused');
    expect(current(create.render())).toContain('(paused update)');
    expect(vi.getTimerCount()).toBe(0);
    await rt.command('schedules', `on ${id}`);
    expect(current(create.render())).toContain('status: enabled | next: in 10s');
    expect(current(pausedUpdate.render())).toContain('status: enabled');
    expect(vi.getTimerCount()).toBe(2);
    const resumed = await rt.card({ action: 'update', id, enabled: false });
    expect(current(resumed.render())).toContain('status: paused');
    await rt.card({ action: 'update', id, enabled: true });
    expect(current(resumed.render())).toContain('status: enabled');
    expect(rt.sendMessage).not.toHaveBeenCalled();
    expect(rt.appendEntry).not.toHaveBeenCalled();
  });

  test.each([{ in: '10s' }, { every: '10s', maxRuns: 1 }])(
    'retirement freezes final run count before removal: %j',
    async (trigger) => {
      const card = await rt.card({ action: 'create', prompt: 'once', ...trigger });
      const bytes = JSON.stringify(card.result);
      card.render();
      vi.advanceTimersByTime(10_000);
      expect(current(card.render())).toContain('status: exhausted | next: none | runs: 1');
      expect(card.render(false, true)).toContain('scope: session | status: exhausted');
      expect(card.render(false, true)).toContain(`last fire: ${new Date(NOW + 10_000).toLocaleString()}`);
      expect(card.render(false, true)).toContain('next fire: none');
      expect(card.render(false, true)).toContain('Prompt:\nonce');
      expect(vi.getTimerCount()).toBe(0);
      const invalidations = card.invalidate.mock.calls.length;
      const final = card.render();
      const finalDetails = card.render(false, true);
      vi.advanceTimersByTime(100_000);
      expect(card.render()).toBe(final);
      expect(card.render(false, true)).toBe(finalDetails);
      expect(card.invalidate).toHaveBeenCalledTimes(invalidations);
      expect(rt.sendMessage).toHaveBeenCalledTimes(1);
      expect(rt.notify).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(card.result)).toBe(bytes);
      expect(rt.appendEntry).not.toHaveBeenCalled();
    },
  );

  test('chance-skipped one-shot retires without inventing a run or delivery', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const card = await rt.card({ action: 'create', prompt: 'skip', in: '10s', chance: 0.1 });
    card.render();
    vi.advanceTimersByTime(10_000);
    expect(current(card.render())).toContain('status: exhausted | next: none | runs: 0');
    expect(vi.getTimerCount()).toBe(0);
    expect(rt.sendMessage).not.toHaveBeenCalled();
  });

  test('delete/clear snapshot current rows while list and delete receipts stay static', async () => {
    const card = await rt.card({ action: 'create', prompt: 'ping', every: '10s' });
    const id = idOf(card.result);
    card.render();
    const list = await rt.card({ action: 'list' });
    const listText = list.render();
    const deletion = await rt.card({ action: 'delete', id });
    expect(deletion.render()).toBe(`Deleted ${id}.`);
    expect(current(card.render())).toContain('status: deleted | next: none | runs: 0');
    expect(list.render()).toBe(listText);
    expect(vi.getTimerCount()).toBe(0);
    const other = await rt.card({ action: 'create', prompt: 'other', every: '10s' });
    other.render();
    await rt.command('schedules', `off ${idOf(other.result)}`);
    await rt.command('schedules', 'clear session');
    expect(current(other.render())).toContain('status: deleted');
    expect(vi.getTimerCount()).toBe(0);
    expect(list.render()).toBe(listText);
    expect(deletion.render()).toBe(`Deleted ${id}.`);
    expect(rt.sendMessage).not.toHaveBeenCalled();
  });

  test('activity re-anchors countdown without UI ticks changing persistence or delivering prompts', async () => {
    const card = await rt.card({ action: 'create', prompt: 'idle', after: '10s-10s', scope: 'project' });
    const file = join(dir, 'project.scheduled-prompts.json');
    const bytes = readFileSync(file, 'utf8');
    card.render();
    vi.advanceTimersByTime(2000);
    expect(current(card.render())).toContain('next: in 8s');
    expect(card.render(false, true)).toContain('Prompt:\nidle');
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    rt.emit('input', { source: 'extension' });
    expect(current(card.render())).toContain('next: in 8s');
    rt.emit('input', { source: 'interactive' });
    expect(current(card.render())).toContain('next: in 10s');
    vi.advanceTimersByTime(1000);
    rt.emit('turn_end');
    expect(current(card.render())).toContain('next: in 10s');
    expect(rt.sendMessage).not.toHaveBeenCalled();
    expect(rt.appendEntry).not.toHaveBeenCalled();
  });

  test.each(['rpc', 'print', 'json'])('%s execution keeps snapshot rendering without a UI interval', async (mode) => {
    rt.shutdown();
    rt = load(dir, mode);
    const card = await rt.card({ action: 'create', prompt: 'ping', every: '10s' });
    expect(card.render()).toBe(card.result.content[0].text);
    expect(card.render(false, true)).toBe(card.result.content[0].text);
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(1);
    expect(card.invalidate).not.toHaveBeenCalled();
    expect(rt.sendMessage).not.toHaveBeenCalled();
  });

  test('uncaptured calls/errors stay snapshots; tree navigation detaches existing cards', async () => {
    const uncaptured = await rt.card({ action: 'create', prompt: 'ping', every: '10s' }, false);
    expect(uncaptured.render()).toBe(uncaptured.result.content[0].text);
    const error = await rt.card({ action: 'update', id: 'missing', enabled: false });
    expect(error.result.isError).toBe(true);
    expect(error.render()).toBe(error.result.content[0].text);
    const card = await rt.card({ action: 'update', id: idOf(uncaptured.result), name: 'live' });
    expect(card.render()).toContain('Current ');
    rt.emit('session_tree');
    expect(card.render()).toBe(card.result.content[0].text);
    expect(card.render(false, true)).toBe(card.result.content[0].text);
    expect(vi.getTimerCount()).toBe(1);
    const next = await rt.card({ action: 'update', id: idOf(uncaptured.result), name: 'new row' });
    expect(current(next.render())).toContain('(new row)');
  });

  test('shutdown stops all ticks; reload preserves schedules but never revives old rows; new drops session schedules', async () => {
    const card = await rt.card({ action: 'create', prompt: 'ping', every: '10s' });
    card.render();
    rt.shutdown('reload');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100_000);
    expect(card.invalidate).not.toHaveBeenCalled();
    expect(rt.sendMessage).not.toHaveBeenCalled();
    rt.emit('session_start', { reason: 'reload' });
    expect(card.render()).toBe(card.result.content[0].text);
    const listing = await rt.card({ action: 'list' });
    expect(listing.render()).toContain(idOf(card.result));
    const fresh = await rt.card({ action: 'update', id: idOf(card.result), name: 'after reload' });
    expect(fresh.render()).toContain('Current ');
    rt.shutdown('new');
    expect(vi.getTimerCount()).toBe(0);
    rt.emit('session_start', { reason: 'new' });
    expect((await rt.card({ action: 'list' })).render()).not.toContain(idOf(card.result));
    expect(rt.appendEntry).not.toHaveBeenCalled();
  });
});
