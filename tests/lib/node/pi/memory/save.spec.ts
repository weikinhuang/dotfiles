/**
 * Tests for lib/node/pi/memory/save.ts.
 *
 * Pure module - no pi runtime needed. Asserts the exact validation
 * chain + error strings the `memory save` action relies on.
 */

import { expect, test } from 'vitest';

import { validateSaveParams } from '../../../../../lib/node/pi/memory/save.ts';

test('rejects missing type with the save-specific message', () => {
  const out = validateSaveParams({ name: 'X', description: 'd', body: 'b' }, 'sid');
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.content).toBe('Error: `type` is required for `save`');
  expect(out.error).toBe('`type` is required');
});

test('scope:session defaults type to note', () => {
  const out = validateSaveParams({ scope: 'session', name: 'X', description: 'd', body: 'b' }, 'sid');
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.type).toBe('note');
  expect(out.scope).toBe('session');
});

test('rejects blank name / description / body with distinct content vs error strings', () => {
  const noName = validateSaveParams({ type: 'user', name: '   ', description: 'd', body: 'b' }, 'sid');
  expect(noName).toMatchObject({
    ok: false,
    content: 'Error: `name` is required for `save`',
    error: '`name` is required',
  });

  const noDesc = validateSaveParams({ type: 'user', name: 'X', description: '  ', body: 'b' }, 'sid');
  expect(noDesc).toMatchObject({
    ok: false,
    content: 'Error: `description` is required for `save` (used as the one-line hook in MEMORY.md)',
    error: '`description` is required',
  });

  const noBody = validateSaveParams({ type: 'user', name: 'X', description: 'd', body: '' }, 'sid');
  expect(noBody).toMatchObject({
    ok: false,
    content: 'Error: `body` is required for `save`',
    error: '`body` is required',
  });
});

test('rejects a type not allowed in the resolved scope', () => {
  const out = validateSaveParams({ type: 'note', scope: 'global', name: 'X', description: 'd', body: 'b' }, 'sid');
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.error).toBe('type "note" cannot be saved in scope "global"');
  expect(out.content).toBe('Error: type "note" cannot be saved in scope "global"');
});

test('rejects session scope when there is no active session id', () => {
  const out = validateSaveParams({ type: 'note', scope: 'session', name: 'X', description: 'd', body: 'b' }, null);
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.error).toContain('session memory is disabled');
  expect(out.content).toBe(`Error: ${out.error}`);
});

test('defaults scope from type and trims all string fields on success', () => {
  const out = validateSaveParams({ type: 'user', name: '  Alice  ', description: '  role  ', body: '  hi  ' }, 'sid');
  expect(out).toEqual({ ok: true, type: 'user', scope: 'global', name: 'Alice', description: 'role', body: 'hi' });

  const project = validateSaveParams({ type: 'project', name: 'p', description: 'd', body: 'b' }, 'sid');
  expect(project.ok && project.scope).toBe('project');
});
