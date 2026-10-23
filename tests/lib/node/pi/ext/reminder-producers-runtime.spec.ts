import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import memory from '../../../../../config/pi/extensions/memory.ts';
import todo from '../../../../../config/pi/extensions/todo.ts';
import scratchpad from '../../../../../config/pi/extensions/scratchpad.ts';
import bgBash from '../../../../../config/pi/extensions/bg-bash.ts';
import { ComfyuiRuntime } from '../../../../../lib/node/pi/ext/comfyui/runtime.ts';
import { addJob, emptyRegistry } from '../../../../../lib/node/pi/comfyui/jobs.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

test.each(['', '1'])('ComfyUI job reminders follow the same global delivery switch (%s)', (disabled) => {
  vi.stubEnv('PI_CACHE_REMINDERS_DISABLED', disabled);
  const runtime = new ComfyuiRuntime({
    pi: {} as ExtensionAPI,
    loadConfig: (): never => {
      throw new Error('not used');
    },
  });
  runtime.registry = addJob(emptyRegistry(), {
    promptId: 'fixture',
    workflow: 'fixture',
    prompt: 'fixture',
    saveDir: '/unused',
    sendToModel: false,
    startedAt: 1,
  }).registry;
  const result = runtime.applyContextHook([{ role: 'user', content: 'prompt', timestamp: 1 }]);
  expect(Boolean(result)).toBe(!disabled);
  expect(JSON.stringify(result) ?? '').toContain(disabled ? '' : 'comfyui-jobs');
});

test.each([todo, scratchpad, bgBash, memory])(
  'global disable suppresses framed producers without removing state tools',
  (extension) => {
    vi.stubEnv('PI_CACHE_REMINDERS_DISABLED', '1');
    for (const name of ['TODO', 'SCRATCHPAD', 'BG_BASH', 'MEMORY']) {
      vi.stubEnv(`PI_${name}_DISABLED`, '');
      vi.stubEnv(`PI_${name}_DISABLE_AUTOINJECT`, '');
    }
    vi.stubEnv('PI_MEMORY_CAPTURE_TURN', '');
    const hooks: string[] = [];
    const registerTool = vi.fn();
    const pi = {
      on: (name: string) => {
        hooks.push(name);
      },
      registerTool,
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      events: {
        on: () => (): void => {
          /* No resources in this factory-only test. */
        },
      },
    } as unknown as ExtensionAPI;
    extension(pi);
    expect(registerTool).toHaveBeenCalled();
    // Memory's index hook may remain registered but its body is gated; other producers skip the hook entirely.
    expect(hooks.includes('context')).toBe(extension === memory);
  },
);

test.each(['', '1'])(
  'a populated memory index never returns a system addendum and honors global disable (%s)',
  async (disabled) => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-delivery-'));
    try {
      vi.stubEnv('PI_MEMORY_ROOT', dir);
      vi.stubEnv('PI_MEMORY_DISABLED', '');
      vi.stubEnv('PI_MEMORY_READONLY', '');
      vi.stubEnv('PI_MEMORY_DISABLE_AUTOINJECT', '');
      vi.stubEnv('PI_MEMORY_DISABLE_CAPTURE', '1');
      vi.stubEnv('PI_CACHE_REMINDERS_DISABLED', disabled);
      vi.stubEnv('PI_CACHE_REMINDERS_ENABLED', '0');
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const listeners = new Map<string, (data: unknown) => void>();
      const appendEntry = vi.fn();
      let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
      const pi = {
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          handlers.set(name, handler);
        },
        events: {
          on: (name: string, listener: (data: unknown) => void) => {
            listeners.set(name, listener);
            return () => listeners.delete(name);
          },
          emit: vi.fn(),
        },
        registerTool: (definition: { execute: (...args: unknown[]) => Promise<unknown> }) => {
          execute = definition.execute;
        },
        registerCommand: vi.fn(),
        appendEntry,
      } as unknown as ExtensionAPI;
      memory(pi);
      const ctx = {
        cwd: dir,
        hasUI: false,
        ui: { notify: vi.fn() },
        sessionManager: { getSessionId: () => 'fixture', getBranch: () => [] },
      };
      handlers.get('session_start')!({}, ctx);
      await execute!(
        'call',
        {
          action: 'save',
          scope: 'global',
          type: 'user',
          name: 'fixture',
          description: 'INDEX_MARKER',
          body: 'fixture only',
        },
        undefined,
        undefined,
        ctx,
      );
      expect(handlers.get('before_agent_start')!({ systemPrompt: 'STATIC' }, ctx)).toBeUndefined();
      const projected = handlers.get('context')!({ messages: [{ role: 'user', content: 'prompt' }] }, ctx);
      expect(projected === undefined).toBe(Boolean(disabled));
      expect(JSON.stringify(projected) ?? '').toContain(disabled ? '' : 'memory-index');
      expect(JSON.stringify(projected) ?? '').toContain(disabled ? '' : 'INDEX_MARKER');
      if (disabled) return;
      // Once the coordinator confirms the capture, an unchanged index emits nothing
      // on later runs instead of stacking another identical copy.
      const projectedMessages = (projected as { messages: { content: { text: string }[] }[] }).messages;
      const body = /<system-reminder id="memory-index">\n([\s\S]*)\n<\/system-reminder>/.exec(
        projectedMessages.at(-1)!.content.at(-1)!.text,
      )![1];
      listeners.get('cache-reminders:captured')!({ specs: [{ id: 'memory-index', body: body.trim() }] });
      expect(handlers.get('context')!({ messages: [{ role: 'user', content: 'next' }] }, ctx)).toBeUndefined();
      expect(appendEntry).toHaveBeenCalledWith('memory-delivery', expect.anything());
      // While the projected request still carries the full index, the baseline holds.
      listeners.get('cache-reminders:projected')!({ messages: projectedMessages });
      expect(handlers.get('context')!({ messages: [{ role: 'user', content: 'kept' }] }, ctx)).toBeUndefined();
      // A projected request that lost the full index (e.g. a rolling window cut
      // its turn) drops the baseline; the next run resends the full index.
      listeners.get('cache-reminders:projected')!({ messages: [{ role: 'user', content: 'later' }] });
      const resent = handlers.get('context')!({ messages: [{ role: 'user', content: 'again' }] }, ctx);
      expect(JSON.stringify(resent)).toContain('## Memory\\n');
      expect(JSON.stringify(resent)).toContain('INDEX_MARKER');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
