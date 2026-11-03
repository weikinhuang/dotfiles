import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type KeybindingsManager,
  SessionManager,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  KeybindingsManager as TuiKeybindingsManager,
  stripTerminalSequences,
  TUI_KEYBINDINGS,
  type TUI,
} from '@earendil-works/pi-tui';
import { afterEach, describe, expect, test, vi, type Mock } from 'vitest';

import messageEditExtension from '../../../../../config/pi/extensions/message-edit.ts';
import type { LooseMessage } from '../../../../../lib/node/pi/context-edit/target.ts';
import type { ModalFactory } from '../../../../../lib/node/pi/ext/show-modal.ts';

const theme = {
  fg: (_token: string, text: string): string => text,
  bold: (text: string): string => text,
} as unknown as Theme;
type Screen = Component & { focused?: boolean; handleInput(data: string): void };
const render = (component: Screen): string => stripTerminalSequences(component.render(120).join('\n'));

function appendReply(manager: SessionManager, text: string, timestamp = 2): string {
  return manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'synthetic',
    stopReason: 'stop',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
}

function session(): SessionManager {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: 'user', content: 'Opening question', timestamp: 1 });
  appendReply(manager, 'Original answer');
  return manager;
}

type RegisteredCommand = Parameters<ExtensionAPI['registerCommand']>[1];
interface CommandHarness {
  manager: SessionManager;
  ctx: ExtensionCommandContext;
  append: Mock<(customType: string, data: unknown) => void>;
  notify: Mock;
  custom: Mock;
  emit(name: string, event?: unknown): unknown;
  run(args?: string): Promise<void>;
  project(): LooseMessage[];
  complete(query: string): ReturnType<NonNullable<RegisteredCommand['getArgumentCompletions']>>;
  action(next: (component: Screen) => void): void;
  fail(value: boolean): void;
}

function harness(manager = session(), mode: ExtensionContext['mode'] = 'tui'): CommandHarness {
  vi.stubEnv('PI_MESSAGE_EDIT_DISABLED', '0');
  type Command = Parameters<ExtensionAPI['registerCommand']>[1];
  const commands = new Map<string, Command>();
  const hooks = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  let failAppend = false;
  let uiError: unknown;
  let action: (component: Screen) => void = (component) => component.handleInput('\x1b');
  const append = vi.fn((customType: string, data: unknown) => {
    if (failAppend) throw new Error('synthetic append failure');
    manager.appendCustomEntry(customType, data);
  });
  const notify = vi.fn();
  const custom = vi.fn(async <T>(factory: ModalFactory<T>): Promise<T> => {
    try {
      return await new Promise<T>((resolve, reject) => {
        const tui = {
          terminal: { rows: 32, columns: 120 },
          requestRender: vi.fn(),
        } as unknown as TUI;
        const kb = new TuiKeybindingsManager({
          ...TUI_KEYBINDINGS,
          'app.editor.external': { defaultKeys: 'ctrl+g' },
        }) as unknown as KeybindingsManager;
        Promise.resolve()
          .then(() => factory(tui, theme, kb, resolve))
          .then((component) => {
            const screen = component as Screen;
            screen.focused = true;
            action(screen);
          })
          .catch(reject);
      });
    } catch (error) {
      uiError = error;
      throw error;
    }
  });
  const ctx = {
    mode,
    sessionManager: manager,
    isIdle: () => true,
    ui: { notify, custom },
  } as unknown as ExtensionCommandContext;
  messageEditExtension({
    on: (name: string, callback: (event: never, ctx: ExtensionContext) => unknown) => {
      hooks.set(name, callback);
    },
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    appendEntry: append,
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}): unknown => hooks.get(name)?.(event as never, ctx);
  const command = commands.get('context-edit')!;
  const run = async (args = ''): Promise<void> => {
    uiError = undefined;
    await command.handler(args, ctx);
    // The command catches UI exceptions. Do not let that swallow test assertions.
    if (uiError !== undefined)
      throw uiError instanceof Error ? uiError : new Error('Custom UI callback failed', { cause: uiError });
  };
  const project = (): LooseMessage[] => {
    const messages = buildSessionContext(manager.getEntries(), manager.getLeafId()).messages;
    const result = emit('context', { type: 'context', messages }) as { messages: LooseMessage[] } | undefined;
    return result?.messages ?? (messages as unknown as LooseMessage[]);
  };
  emit('session_start');
  return {
    manager,
    ctx,
    append,
    notify,
    custom,
    emit,
    run,
    project,
    complete: (query: string) => command.getArgumentCompletions!(query),
    action: (next: (component: Screen) => void): void => {
      action = next;
    },
    fail: (value: boolean): void => {
      failAppend = value;
    },
  };
}

async function save(h: ReturnType<typeof harness>, suffix = ' edited'): Promise<void> {
  h.action((component) => {
    expect(render(component)).toContain('Edit msg2');
    component.handleInput(suffix);
    component.handleInput('\x13');
    expect(render(component)).toContain('Saved msg2');
    component.handleInput('\x1b');
  });
  await h.run('msg2');
}

const text = (messages: LooseMessage[]): string => JSON.stringify(messages.map((message) => message.content));
afterEach(() => vi.unstubAllEnvs());

describe('message-edit command integration', () => {
  test('completes newest replies immediately, including after a stale pre-reply context hook', async () => {
    const h = harness();
    expect(await h.complete('Original')).toEqual(expect.arrayContaining([expect.objectContaining({ value: 'msg2' })]));
    // Prime the cache, then append a reply without emitting context.
    appendReply(h.manager, 'Newest response fresh completion', 3);
    expect(await h.complete('Newest response')).toEqual([expect.objectContaining({ value: 'msg3' })]);
    h.project();
    appendReply(h.manager, 'Later reply not in context snapshot', 4);
    expect(await h.complete('Later reply')).toEqual([expect.objectContaining({ value: 'msg4' })]);
  });

  test('full-body multiword completion and submission open a filtered browser, not a truncated handle lookup', async () => {
    const h = harness();
    appendReply(h.manager, `${'padding '.repeat(60)}hidden nebula\nprecise orchard`, 3);
    const query = 'hidden nebula precise orchard';
    expect(await h.complete(query)).toEqual([expect.objectContaining({ value: 'msg3' })]);
    h.action((component) => {
      expect(render(component)).toContain(`Search: > ${query}`);
      expect(render(component)).toContain('1 matches');
      expect(render(component)).toContain('Preview: msg3');
      component.handleInput('\r');
      expect(render(component)).toContain('Edit msg3');
      component.handleInput('\x1b');
      component.handleInput('\x1b');
    });
    await h.run(query);
    expect(h.append).not.toHaveBeenCalled();
  });

  test('Enter inserts a newline in the actual custom UI; only Ctrl+S persists and projects future context', async () => {
    const h = harness();
    const original = JSON.stringify(h.manager.getEntries());
    h.action((component) => {
      component.handleInput('\r');
      component.handleInput('second line');
      expect(render(component)).toContain('unsaved');
      expect(h.append).not.toHaveBeenCalled();
      expect(text(h.project())).toContain('Original answer');
      expect(text(h.project())).not.toContain('second line');
      component.handleInput('\x13');
      expect(render(component)).toContain('Saved msg2');
      expect(render(component)).toContain('not disk-backed');
      component.handleInput('\x1b');
    });
    await h.run('msg2');
    expect(h.append).toHaveBeenCalledOnce();
    expect(h.append.mock.calls[0][0]).toBe('message-edit-state');
    expect(text(h.project())).toContain('Original answer\\nsecond line');
    expect(JSON.stringify(h.manager.getEntries().filter((entry) => entry.type === 'message'))).toBe(original);
  });

  test('reload recovers persisted edits and tree transitions recover branch-local state without a context hook', async () => {
    const h = harness();
    const originalLeaf = h.manager.getLeafId()!;
    await save(h);
    const editedLeaf = h.manager.getLeafId()!;
    const reloaded = harness(h.manager);
    expect(await reloaded.complete('restore ')).toEqual([expect.objectContaining({ value: 'restore 1' })]);
    expect(text(reloaded.project())).toContain('Original answer edited');
    h.manager.branch(originalLeaf);
    reloaded.emit('session_tree');
    expect(await reloaded.complete('restore ')).toBeNull();
    expect(text(reloaded.project())).not.toContain('answer edited');
    appendReply(h.manager, 'Alternate branch reply', 4);
    expect(await reloaded.complete('Alternate branch')).toEqual([expect.objectContaining({ value: 'msg3' })]);
    h.manager.branch(editedLeaf);
    reloaded.emit('session_tree');
    expect(await reloaded.complete('Alternate branch')).toBeNull();
    expect(text(reloaded.project())).toContain('Original answer edited');
    reloaded.emit('session_shutdown');
    expect(await reloaded.complete('Original')).toBeNull();
    reloaded.emit('session_start');
    expect(await reloaded.complete('Original')).not.toBeNull();
  });

  test('restore rejects suffix garbage and accepts #id without losing later turns', async () => {
    const h = harness();
    await save(h);
    appendReply(h.manager, 'Later turn remains', 3);
    await h.run('restore 1junk');
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining('positive integer'), 'warning');
    expect(h.append).toHaveBeenCalledTimes(1);
    expect(text(h.project())).toContain('answer edited');
    await h.run('restore #1');
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining('Restored #1'), 'info');
    expect(text(h.project())).not.toContain('answer edited');
    expect(text(h.project())).toContain('Later turn remains');
  });

  test('failed persistence preserves prior overlay and keeps the UI draft alive for retry', async () => {
    const h = harness();
    await save(h, ' first');
    h.fail(true);
    h.action((component) => {
      component.handleInput(' retry draft');
      component.handleInput('\x13');
      expect(render(component)).toContain('Not saved: synthetic append failure');
      expect(render(component)).toContain('Edit msg2');
      expect(render(component)).toContain('retry draft');
      expect(text(h.project())).toContain('Original answer first');
      expect(text(h.project())).not.toContain('retry draft');
      h.fail(false);
      component.handleInput('\x13');
      expect(render(component)).toContain('Saved msg2');
      component.handleInput('\x1b');
    });
    await h.run('msg2');
    expect(text(h.project())).toContain('Original answer first retry draft');
    expect(h.manager.getEntries().filter((entry) => entry.type === 'custom')).toHaveLength(2);
  });

  test('clear and restore append failures report errors and do not claim success or alter context', async () => {
    const h = harness();
    await save(h);
    h.fail(true);
    await h.run('clear');
    expect(h.notify).toHaveBeenLastCalledWith('Not saved: synthetic append failure', 'error');
    expect(text(h.project())).toContain('answer edited');
    await h.run('restore #1');
    expect(h.notify).toHaveBeenLastCalledWith('Not saved: synthetic append failure', 'error');
    expect(text(h.project())).toContain('answer edited');
    h.action((component) => {
      component.handleInput('\x12');
      expect(render(component)).toContain('Not saved: synthetic append failure');
      expect(render(component)).toContain('[edited #1]');
      component.handleInput('\x1b');
    });
    await h.run('list');
    await h.run('restore #99');
    expect(h.notify).toHaveBeenLastCalledWith('Edit #99 not found.', 'error');
    h.fail(false);
    await h.run('clear');
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining('Original text applies'), 'info');
    expect(text(h.project())).not.toContain('answer edited');
  });

  test('a branch transition invalidates an already-open draft instead of saving it to the new branch', async () => {
    const h = harness();
    h.action((component) => {
      component.handleInput(' old branch draft');
      h.manager.branch(h.manager.getEntries().find((entry) => entry.type === 'message')!.id);
      h.emit('session_tree');
      component.handleInput('\x13');
      expect(render(component)).toContain('Session or branch changed');
      expect(h.append).not.toHaveBeenCalled();
      component.handleInput('\x1b');
      component.handleInput('\x04');
      component.handleInput('\x1b');
    });
    await h.run('msg2');
  });

  test('non-TUI mode provides informational listings and warning fallback without mounting custom UI', async () => {
    const h = harness(session(), 'rpc');
    await h.run();
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining('msg2 assistant: Original answer'), 'info');
    await h.run('list');
    expect(h.notify).toHaveBeenLastCalledWith('No matching messages or active edits.', 'info');
    await h.run('Original answer');
    expect(h.notify).toHaveBeenLastCalledWith('Editing needs an interactive terminal UI.', 'warning');
    await h.run('--help');
    expect(h.notify.mock.lastCall?.[1]).toBe('info');
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
});
