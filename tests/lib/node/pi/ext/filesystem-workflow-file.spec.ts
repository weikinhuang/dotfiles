/** Drive the real filesystem hook, not a copy of its dispatch logic. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { filesystemFactoryHookOnly } from '../../../../../config/pi/extensions/filesystem.ts';
import { clearActivePersona } from '../../../../../lib/node/pi/persona/active.ts';

type Handler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<{ block: true; reason: string } | undefined>;
let dir: string;
let handler: Handler;
let ctx: ExtensionContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comfy-fs-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'));
  vi.stubEnv('PI_FILESYSTEM_DISABLED', '');
  vi.stubEnv('PI_FILESYSTEM_DEFAULT', 'deny');
  clearActivePersona();
  ctx = {
    cwd: dir,
    hasUI: false,
    sessionManager: { getSessionId: () => 'comfy-fs-test' },
  } as unknown as ExtensionContext;
  filesystemFactoryHookOnly({
    on: (event: string, fn: Handler) => {
      if (event === 'tool_call') handler = fn;
    },
  } as unknown as ExtensionAPI);
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearActivePersona();
  rmSync(dir, { recursive: true, force: true });
});

function call(input: Record<string, unknown>, toolName = 'generate_image'): ReturnType<Handler> {
  return handler({ type: 'tool_call', toolCallId: 't1', toolName, input }, ctx);
}

test.each(['./.env', '~/.ssh/graph.api.json', '.env.local'])('applies the same read gate to %s', async (path) => {
  expect(await call({ workflowFile: path })).toMatchObject({ block: true });
  expect(await call({ path }, 'read')).toMatchObject({ block: true });
});

test('allows an ordinary workflow file', async () => {
  expect(await call({ workflowFile: './graph.api.json' })).toBeUndefined();
});

test('honors project read deny/allow policy without treating named workflows as local paths', async () => {
  mkdirSync(join(dir, '.pi'));
  writeFileSync(
    join(dir, '.pi', 'filesystem.json'),
    JSON.stringify({
      read: {
        deny: { paths: [join(dir, 'private')] },
        allow: { paths: [join(dir, 'private', 'allowed.api.json')] },
      },
    }),
  );
  expect(await call({ workflowFile: 'private/blocked.api.json' })).toMatchObject({ block: true });
  expect(await call({ workflowFile: 'private/allowed.api.json' })).toBeUndefined();
  expect(await call({ workflow: 'private/blocked.api.json', prompt: 'cat' })).toBeUndefined();
  expect(await call({ workflowFile: null })).toBeUndefined();
});
