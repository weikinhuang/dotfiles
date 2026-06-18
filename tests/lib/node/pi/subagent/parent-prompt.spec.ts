/**
 * Tests for `lib/node/pi/subagent/parent-prompt.ts` - the
 * globalThis-anchored bridge that routes a subagent child's gate
 * approval to the parent UI, serialized + labelled.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  clearChildPromptIdentities,
  formatRequesterLabel,
  hasParentPromptUI,
  registerChildPromptIdentity,
  resetParentPromptForTest,
  resolveParentPrompt,
  runSerialPrompt,
  setParentPromptUI,
  unregisterChildPromptIdentity,
  type ParentPromptUI,
} from '../../../../../lib/node/pi/subagent/parent-prompt.ts';

function makeUI(): ParentPromptUI {
  return {
    select: vi.fn(() => Promise.resolve(undefined)),
    input: vi.fn(() => Promise.resolve(undefined)),
    notify: vi.fn(() => undefined),
  };
}

afterEach(() => {
  resetParentPromptForTest();
});

describe('parent-prompt UI publication', () => {
  test('starts with no UI published', () => {
    expect(hasParentPromptUI()).toBe(false);
  });

  test('setParentPromptUI publishes + clears', () => {
    const ui = makeUI();
    setParentPromptUI(ui);
    expect(hasParentPromptUI()).toBe(true);
    setParentPromptUI(undefined);
    expect(hasParentPromptUI()).toBe(false);
  });
});

describe('formatRequesterLabel', () => {
  test('includes agent, handle, and source', () => {
    expect(formatRequesterLabel({ agent: 'explore', handle: 'sub_explore_1', source: 'global' })).toBe(
      'subagent explore (sub_explore_1, global)',
    );
  });

  test('omits source when absent', () => {
    expect(formatRequesterLabel({ agent: 'plan', handle: 'sub_plan_2' })).toBe('subagent plan (sub_plan_2)');
  });
});

describe('resolveParentPrompt', () => {
  test('returns undefined when no UI is published, even for a known child', () => {
    registerChildPromptIdentity('sess-1', { agent: 'explore', handle: 'sub_explore_1' });
    expect(resolveParentPrompt('sess-1')).toBeUndefined();
  });

  test('returns undefined for an unknown / unregistered session', () => {
    setParentPromptUI(makeUI());
    expect(resolveParentPrompt('nope')).toBeUndefined();
    expect(resolveParentPrompt(undefined)).toBeUndefined();
  });

  test('returns the UI + requester label for a registered child', () => {
    const ui = makeUI();
    setParentPromptUI(ui);
    registerChildPromptIdentity('sess-1', { agent: 'explore', handle: 'sub_explore_1', source: 'project' });

    const got = resolveParentPrompt('sess-1');
    expect(got?.ui).toBe(ui);
    expect(got?.requester).toBe('subagent explore (sub_explore_1, project)');
  });

  test('unregister drops routing; clear drops all', () => {
    setParentPromptUI(makeUI());
    registerChildPromptIdentity('a', { agent: 'x', handle: 'h1' });
    registerChildPromptIdentity('b', { agent: 'y', handle: 'h2' });

    unregisterChildPromptIdentity('a');
    expect(resolveParentPrompt('a')).toBeUndefined();
    expect(resolveParentPrompt('b')).toBeDefined();

    clearChildPromptIdentities();
    expect(resolveParentPrompt('b')).toBeUndefined();
  });

  test('empty session id is ignored on register', () => {
    setParentPromptUI(makeUI());
    registerChildPromptIdentity('', { agent: 'x', handle: 'h' });
    expect(resolveParentPrompt('')).toBeUndefined();
  });
});

describe('runSerialPrompt', () => {
  test('serializes overlapping prompts - no two run concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    const make = (id: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      order.push(id);
      active -= 1;
      return id;
    };

    const results = await Promise.all([runSerialPrompt(make(1)), runSerialPrompt(make(2)), runSerialPrompt(make(3))]);

    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
  });

  test('a rejected prompt does not break the chain', async () => {
    const failing = runSerialPrompt(() => Promise.reject(new Error('boom')));
    await expect(failing).rejects.toThrow('boom');

    const next = await runSerialPrompt(() => Promise.resolve('ok'));
    expect(next).toBe('ok');
  });
});
