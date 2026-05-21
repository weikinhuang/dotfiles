/**
 * Specs for the reactive filesystem-permission ask dialog.
 *
 * Unlike `network-ask`, this dialog fires AFTER a sandboxed bash has
 * already failed. The dialog is pure logic - the extension shell wires
 * up persistence callbacks and the reconfigure trigger - so the spec
 * exercises it directly with a scripted UI bridge and faked deps.
 *
 * Coverage:
 *
 *   - `clampCommonParent` returns the parent unchanged inside cwd or
 *     one segment under $HOME, and undefined when it climbs above
 *     either safe scope.
 *   - No interactive UI → `{ kind: 'no-ui' }`, no side-effects.
 *   - Each of the five dialog options produces the right outcome +
 *     side-effects (deps callbacks, ui.notify).
 *   - "Always allow" options are hidden when the proposed common
 *     parent fails the clamp.
 *   - A save-callback throw is caught, surfaced via ui.notify, and
 *     reported as a deny (the file is left untouched).
 */

import { homedir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearActiveUI, publishActiveUI, type UIBridge } from '../../../../../lib/node/pi/active-ui.ts';
import {
  buildFilesystemAskDialog,
  clampCommonParent,
  type FsAskDeps,
} from '../../../../../lib/node/pi/sandbox/filesystem-ask.ts';

function makeDeps(overrides: Partial<FsAskDeps> = {}): FsAskDeps {
  return {
    sessionWriteAllow: new Set(),
    triggerReconfigure: vi.fn(() => Promise.resolve()),
    saveProjectWriteAllow: vi.fn((_p: string) => '/workspace/.pi/filesystem.json'),
    saveUserWriteAllow: vi.fn((_p: string) => '/home/u/.pi/filesystem.json'),
    cwd: '/workspace',
    ...overrides,
  };
}

interface ScriptedUI extends UIBridge {
  notifyCalls: { msg: string; level?: 'info' | 'warning' | 'error' | 'success' }[];
  selectCalls: { title: string; options: string[] }[];
  inputCalls: { title: string; placeholder?: string }[];
}

function scriptedUi(scripted: {
  onSelect?: (options: string[]) => string | undefined;
  inputReply?: string;
}): ScriptedUI {
  const notifyCalls: ScriptedUI['notifyCalls'] = [];
  const selectCalls: ScriptedUI['selectCalls'] = [];
  const inputCalls: ScriptedUI['inputCalls'] = [];
  return {
    hasUI: true,
    notifyCalls,
    selectCalls,
    inputCalls,
    notify(message, level) {
      notifyCalls.push({ msg: message, level });
    },
    select(title, options) {
      selectCalls.push({ title, options });
      return Promise.resolve(scripted.onSelect ? scripted.onSelect(options) : undefined);
    },
    input(title, placeholder) {
      inputCalls.push({ title, placeholder });
      return Promise.resolve(scripted.inputReply);
    },
  };
}

describe('clampCommonParent', () => {
  const HOME = homedir();

  test('returns the parent when it equals cwd', () => {
    expect(clampCommonParent('/workspace', '/workspace', HOME)).toBe('/workspace');
  });

  test('returns the parent when it is strictly inside cwd', () => {
    expect(clampCommonParent('/workspace/node_modules', '/workspace', HOME)).toBe('/workspace/node_modules');
  });

  test('returns undefined when the parent climbs above cwd', () => {
    expect(clampCommonParent('/etc', '/workspace', HOME)).toBeUndefined();
    expect(clampCommonParent('/', '/workspace', HOME)).toBeUndefined();
  });

  test('returns undefined when the parent is the parent of cwd', () => {
    expect(clampCommonParent('/', '/workspace', HOME)).toBeUndefined();
  });

  test('allows a one-segment dir under $HOME (e.g. ~/.npm)', () => {
    expect(clampCommonParent(`${HOME}/.npm`, '/workspace', HOME)).toBe(`${HOME}/.npm`);
    expect(clampCommonParent(`${HOME}/.cache`, '/workspace', HOME)).toBe(`${HOME}/.cache`);
  });

  test('disallows bare $HOME (too broad)', () => {
    expect(clampCommonParent(HOME, '/workspace', HOME)).toBeUndefined();
  });

  test('disallows two-segment-deep paths under $HOME (would widen too far via project file)', () => {
    expect(clampCommonParent(`${HOME}/projects/foo`, '/workspace', HOME)).toBeUndefined();
  });

  test('returns undefined for non-absolute parents', () => {
    expect(clampCommonParent('node_modules', '/workspace', HOME)).toBeUndefined();
    expect(clampCommonParent('', '/workspace', HOME)).toBeUndefined();
  });
});

describe('buildFilesystemAskDialog', () => {
  beforeEach(() => clearActiveUI());
  afterEach(() => clearActiveUI());

  test('returns no-ui when no interactive UI has been published', async () => {
    const deps = makeDeps();
    const ask = buildFilesystemAskDialog(deps);
    const out = await ask({ paths: ['/workspace/node_modules/foo'], command: 'npm install' });
    expect(out).toEqual({ kind: 'no-ui' });
    expect(deps.saveProjectWriteAllow).not.toHaveBeenCalled();
    expect(deps.triggerReconfigure).not.toHaveBeenCalled();
  });

  test('returns deny when paths list is empty (defensive)', async () => {
    publishActiveUI(scriptedUi({ onSelect: () => 'Allow once (this session)' }));
    const deps = makeDeps();
    const ask = buildFilesystemAskDialog(deps);
    const out = await ask({ paths: [], command: 'npm install' });
    expect(out).toEqual({ kind: 'deny' });
  });

  test('Allow once: mutates session set, triggers reconfigure, no persistence', async () => {
    const ui = scriptedUi({ onSelect: () => 'Allow once (this session)' });
    publishActiveUI(ui);
    const deps = makeDeps();
    const ask = buildFilesystemAskDialog(deps);
    const out = await ask({
      paths: ['/workspace/node_modules/foo'],
      command: 'npm install',
    });
    expect(out).toMatchObject({ kind: 'allow', scope: 'session' });
    expect([...deps.sessionWriteAllow]).toEqual(['/workspace/node_modules/foo']);
    expect(deps.triggerReconfigure).toHaveBeenCalledTimes(1);
    expect(deps.saveProjectWriteAllow).not.toHaveBeenCalled();
    expect(deps.saveUserWriteAllow).not.toHaveBeenCalled();
  });

  test('Always allow (project): collapses sibling paths to common parent, persists, reconfigures', async () => {
    const ui = scriptedUi({
      onSelect: (options) => options.find((o) => o.startsWith('Always allow /workspace/node_modules (project)')),
    });
    publishActiveUI(ui);
    const deps = makeDeps();
    const ask = buildFilesystemAskDialog(deps);
    const out = await ask({
      paths: ['/workspace/node_modules/foo', '/workspace/node_modules/bar'],
      command: 'npm install',
    });
    expect(out).toMatchObject({
      kind: 'allow',
      scope: 'project',
      allowedPath: '/workspace/node_modules',
      savedPath: '/workspace/.pi/filesystem.json',
    });
    expect(deps.saveProjectWriteAllow).toHaveBeenCalledWith('/workspace/node_modules');
    expect(deps.triggerReconfigure).toHaveBeenCalledTimes(1);
    expect(ui.notifyCalls.some((n) => n.msg.includes('Added write.allow.paths'))).toBe(true);
  });

  test('Always allow (user): persists to user scope', async () => {
    const ui = scriptedUi({
      onSelect: (options) => options.find((o) => o.startsWith('Always allow /workspace/node_modules (user)')),
    });
    publishActiveUI(ui);
    const deps = makeDeps();
    const ask = buildFilesystemAskDialog(deps);
    const out = await ask({
      paths: ['/workspace/node_modules/foo', '/workspace/node_modules/bar'],
      command: 'npm install',
    });
    expect(out).toMatchObject({ kind: 'allow', scope: 'user' });
    expect(deps.saveUserWriteAllow).toHaveBeenCalledWith('/workspace/node_modules');
  });

  test('Always allow options are hidden when the common parent fails the clamp', async () => {
    let optionsSeen: string[] = [];
    const ui = scriptedUi({
      onSelect: (options) => {
        optionsSeen = options;
        return 'Deny';
      },
    });
    publishActiveUI(ui);
    const deps = makeDeps({ cwd: '/workspace' });
    const ask = buildFilesystemAskDialog(deps);
    // /etc/foo is well outside cwd and $HOME-one-segment, so the
    // dialog must omit both Always-allow options.
    await ask({ paths: ['/etc/foo'], command: 'bash -c "echo bad > /etc/foo"' });
    expect(optionsSeen.some((o) => o.startsWith('Always allow'))).toBe(false);
    expect(optionsSeen).toContain('Allow once (this session)');
    expect(optionsSeen).toContain('Deny');
  });

  test('Deny: returns deny, never prompts for feedback, no side-effects', async () => {
    const ui = scriptedUi({ onSelect: () => 'Deny' });
    publishActiveUI(ui);
    const deps = makeDeps();
    const ask = buildFilesystemAskDialog(deps);
    const out = await ask({
      paths: ['/workspace/node_modules/foo'],
      command: 'npm install',
    });
    expect(out).toEqual({ kind: 'deny' });
    expect(ui.inputCalls).toHaveLength(0);
    expect(deps.triggerReconfigure).not.toHaveBeenCalled();
  });

  test('Deny with feedback: captures feedback string and surfaces a notify', async () => {
    const ui = scriptedUi({
      onSelect: (options) => options.find((o) => o.startsWith('Deny with feedback')),
      inputReply: 'write to /tmp instead',
    });
    publishActiveUI(ui);
    const deps = makeDeps();
    const ask = buildFilesystemAskDialog(deps);
    const out = await ask({
      paths: ['/workspace/node_modules/foo'],
      command: 'npm install',
    });
    expect(out).toEqual({ kind: 'deny', feedback: 'write to /tmp instead' });
    expect(ui.notifyCalls.some((n) => n.msg.includes('write to /tmp instead'))).toBe(true);
  });

  test('a save-callback throw is caught, surfaced, and reported as deny', async () => {
    const ui = scriptedUi({
      onSelect: (options) => options.find((o) => o.startsWith('Always allow') && o.endsWith('(project)')),
    });
    publishActiveUI(ui);
    const deps = makeDeps({
      saveProjectWriteAllow: vi.fn((_p: string) => {
        throw new Error('Failed to parse /workspace/.pi/filesystem.json: unexpected token');
      }),
    });
    const ask = buildFilesystemAskDialog(deps);
    const out = await ask({
      paths: ['/workspace/node_modules/foo'],
      command: 'npm install',
    });
    expect(out).toEqual({ kind: 'deny' });
    expect(ui.notifyCalls.some((n) => n.msg.includes('Failed to parse'))).toBe(true);
    expect(deps.triggerReconfigure).not.toHaveBeenCalled();
  });

  test('select-cancelled (undefined) is treated as deny', async () => {
    const ui = scriptedUi({ onSelect: () => undefined });
    publishActiveUI(ui);
    const deps = makeDeps();
    const ask = buildFilesystemAskDialog(deps);
    const out = await ask({
      paths: ['/workspace/node_modules/foo'],
      command: 'npm install',
    });
    expect(out).toEqual({ kind: 'deny' });
  });
});
