/**
 * Specs for the SandboxAskCallback dialog logic.
 *
 * The callback is wired into ASRT by `config/pi/extensions/sandbox.ts`
 * and fires when a sandboxed bash hits a non-allowlisted host. The
 * dialog itself is pure logic (six options, session-allow set,
 * project / user-scope persistence callbacks), so the spec exercises
 * it directly without the extension shell or a real SandboxManager.
 *
 * Coverage:
 *
 *   - `parentDomainGlob` heuristic.
 *   - Session-allow short-circuit on a second call for the same host.
 *   - No-UI fallback honours `envNetworkDefault`.
 *   - Each of the six dialog options produces the right boolean +
 *     side-effects (deps callbacks, ui.notify).
 *   - The fourth option (`Always allow *.<parent> (user)`) is omitted
 *     when no sensible parent exists.
 *   - Subagent-style call: a UI bridge published via `publishActiveUI`
 *     is what the callback uses (mirrors the parent/child wiring).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearActiveUI, publishActiveUI, type UIBridge } from '../../../../../lib/node/pi/active-ui.ts';
import {
  buildNetworkAskCallback,
  type NetworkAskDeps,
  parentDomainGlob,
} from '../../../../../lib/node/pi/sandbox/network-ask.ts';

function makeDeps(overrides: Partial<NetworkAskDeps> = {}): NetworkAskDeps {
  return {
    sessionAllowedDomains: new Set(),
    triggerReconfigure: vi.fn(() => Promise.resolve()),
    saveProjectAllow: vi.fn((_host: string) => '/workspace/.pi/sandbox.json'),
    saveUserAllowParent: vi.fn((_parent: string) => '/home/u/.pi/sandbox.json'),
    envNetworkDefault: vi.fn<() => 'allow' | 'deny'>(() => 'deny'),
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

describe('parentDomainGlob', () => {
  test('returns *.parent for three-segment hosts', () => {
    expect(parentDomainGlob('api.github.com')).toBe('*.github.com');
    expect(parentDomainGlob('foo.bar.baz.example.com')).toBe('*.bar.baz.example.com');
  });
  test('returns undefined for two-segment hosts (avoids *.com footgun)', () => {
    expect(parentDomainGlob('github.com')).toBeUndefined();
    expect(parentDomainGlob('example.org')).toBeUndefined();
  });
  test('returns undefined for single-label hosts', () => {
    expect(parentDomainGlob('localhost')).toBeUndefined();
    expect(parentDomainGlob('')).toBeUndefined();
  });
  test('returns undefined for IPv4 / IPv6 / host:port', () => {
    expect(parentDomainGlob('192.168.1.1')).toBeUndefined();
    expect(parentDomainGlob('::1')).toBeUndefined();
    expect(parentDomainGlob('api.example.com:443')).toBeUndefined();
  });
  test('returns undefined when the host contains a slash (probably a URL)', () => {
    expect(parentDomainGlob('api.example.com/path')).toBeUndefined();
  });
});

describe('buildNetworkAskCallback', () => {
  beforeEach(() => clearActiveUI());
  afterEach(() => clearActiveUI());

  test('non-UI fallback returns true when envNetworkDefault=allow', async () => {
    // No publishActiveUI - the active-ui slot is empty.
    const deps = makeDeps({ envNetworkDefault: () => 'allow' });
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'example.com', port: 443 })).toBe(true);
  });

  test('non-UI fallback returns false when envNetworkDefault=deny', async () => {
    const deps = makeDeps({ envNetworkDefault: () => 'deny' });
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'example.com', port: 443 })).toBe(false);
  });

  test('session-allow set short-circuits without prompting', async () => {
    const ui = scriptedUi({ onSelect: () => 'Deny' });
    publishActiveUI(ui);
    const deps = makeDeps({ sessionAllowedDomains: new Set(['api.example.com']) });
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'api.example.com', port: 443 })).toBe(true);
    expect(ui.selectCalls).toHaveLength(0);
  });

  test('Allow once: returns true; no persistence side-effects', async () => {
    const ui = scriptedUi({ onSelect: (options) => options.find((o) => o === 'Allow once') });
    publishActiveUI(ui);
    const deps = makeDeps();
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'github.com', port: 443 })).toBe(true);
    expect(deps.sessionAllowedDomains.size).toBe(0);
    expect(deps.saveProjectAllow).not.toHaveBeenCalled();
    expect(deps.saveUserAllowParent).not.toHaveBeenCalled();
    expect(deps.triggerReconfigure).not.toHaveBeenCalled();
  });

  test('Allow ... for this session: returns true and populates the set', async () => {
    const ui = scriptedUi({
      onSelect: (options) => options.find((o) => o.startsWith('Allow github.com for this session')),
    });
    publishActiveUI(ui);
    const deps = makeDeps();
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'github.com', port: 443 })).toBe(true);
    expect([...deps.sessionAllowedDomains]).toEqual(['github.com']);
    expect(deps.saveProjectAllow).not.toHaveBeenCalled();
  });

  test('Always allow <host> (project): persists + triggers reconfigure', async () => {
    const ui = scriptedUi({
      onSelect: (options) => options.find((o) => o.startsWith('Always allow github.com (project)')),
    });
    publishActiveUI(ui);
    const deps = makeDeps();
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'github.com', port: 443 })).toBe(true);
    expect(deps.saveProjectAllow).toHaveBeenCalledWith('github.com');
    expect(deps.triggerReconfigure).toHaveBeenCalledTimes(1);
    expect(ui.notifyCalls.some((n) => n.msg.includes('Added network.allow "github.com"'))).toBe(true);
  });

  test('Always allow *.parent (user): persists the glob to user scope', async () => {
    const ui = scriptedUi({
      onSelect: (options) => options.find((o) => o.startsWith('Always allow *.github.com (user)')),
    });
    publishActiveUI(ui);
    const deps = makeDeps();
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'api.github.com', port: 443 })).toBe(true);
    expect(deps.saveUserAllowParent).toHaveBeenCalledWith('*.github.com');
    expect(deps.triggerReconfigure).toHaveBeenCalledTimes(1);
  });

  test('parent-user option is hidden when no sensible parent exists', async () => {
    let optionsSeen: string[] = [];
    const ui = scriptedUi({
      onSelect: (options) => {
        optionsSeen = options;
        return 'Deny';
      },
    });
    publishActiveUI(ui);
    const deps = makeDeps();
    const cb = buildNetworkAskCallback(deps);
    await cb({ host: 'github.com', port: 443 });
    expect(optionsSeen.some((o) => o.includes('(user)'))).toBe(false);
  });

  test('Deny: returns false without further prompting', async () => {
    const ui = scriptedUi({ onSelect: () => 'Deny' });
    publishActiveUI(ui);
    const deps = makeDeps();
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'github.com', port: 443 })).toBe(false);
    expect(ui.inputCalls).toHaveLength(0);
  });

  test('Deny with feedback: surfaces a notify with the feedback text', async () => {
    const ui = scriptedUi({
      onSelect: (options) => options.find((o) => o.startsWith('Deny with feedback')),
      inputReply: 'use the staging mirror',
    });
    publishActiveUI(ui);
    const deps = makeDeps();
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'evil.example.com', port: 443 })).toBe(false);
    expect(ui.inputCalls).toHaveLength(1);
    expect(ui.notifyCalls.some((n) => n.msg.includes('use the staging mirror'))).toBe(true);
  });

  test('Deny with feedback + empty input: no notify, still returns false', async () => {
    const ui = scriptedUi({
      onSelect: (options) => options.find((o) => o.startsWith('Deny with feedback')),
      inputReply: '   ',
    });
    publishActiveUI(ui);
    const deps = makeDeps();
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'evil.example.com', port: 443 })).toBe(false);
    expect(ui.notifyCalls).toHaveLength(0);
  });

  test('undefined select choice (user dismissed dialog) is treated as Deny', async () => {
    const ui = scriptedUi({ onSelect: () => undefined });
    publishActiveUI(ui);
    const deps = makeDeps();
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'github.com', port: 443 })).toBe(false);
  });

  test('subagent-style call: the published parent UI receives the prompt', async () => {
    // Simulates the parent-process publishing its UI on session_start;
    // a subagent's bash hook then routes through the same callback
    // (sandbox.ts wires the manager once at parent init).
    const parentUi = scriptedUi({ onSelect: () => 'Allow once' });
    publishActiveUI(parentUi);
    const deps = makeDeps();
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'subagent.example.com', port: 8080 })).toBe(true);
    expect(parentUi.selectCalls).toHaveLength(1);
    // The dialog title surfaces the host:port label for clarity.
    expect(parentUi.selectCalls[0].title).toContain('subagent.example.com:8080');
  });

  test('saveProjectAllow throwing surfaces an error notify and returns false', async () => {
    const ui = scriptedUi({
      onSelect: (options) => options.find((o) => o.startsWith('Always allow github.com (project)')),
    });
    publishActiveUI(ui);
    const deps = makeDeps({
      saveProjectAllow: vi.fn(() => {
        throw new Error('Failed to parse /home/u/.pi/sandbox.json: Unexpected token } at line 4');
      }),
    });
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'github.com', port: 443 })).toBe(false);
    expect(deps.triggerReconfigure).not.toHaveBeenCalled();
    expect(ui.notifyCalls.some((n) => n.level === 'error' && n.msg.includes('Failed to parse'))).toBe(true);
  });

  test('saveUserAllowParent throwing surfaces an error notify and returns false', async () => {
    const ui = scriptedUi({
      onSelect: (options) => options.find((o) => o.startsWith('Always allow *.github.com (user)')),
    });
    publishActiveUI(ui);
    const deps = makeDeps({
      saveUserAllowParent: vi.fn(() => {
        throw new Error('Failed to parse /home/u/.pi/sandbox.json: malformed');
      }),
    });
    const cb = buildNetworkAskCallback(deps);
    expect(await cb({ host: 'api.github.com', port: 443 })).toBe(false);
    expect(deps.triggerReconfigure).not.toHaveBeenCalled();
    expect(ui.notifyCalls.some((n) => n.level === 'error' && n.msg.includes('Failed to parse'))).toBe(true);
  });

  test('hasUI: false on the published bridge falls through to env default', async () => {
    const noUi: UIBridge = {
      hasUI: false,
      select: () => Promise.resolve('NEVER'),
      input: () => Promise.resolve(''),
      notify: () => {
        /* no-op */
      },
    };
    publishActiveUI(noUi);
    const deps = makeDeps({ envNetworkDefault: () => 'allow' });
    const cb = buildNetworkAskCallback(deps);
    // getInteractiveActiveUI returns undefined for hasUI: false, so
    // the callback hits the env default.
    expect(await cb({ host: 'foo.example.com', port: 443 })).toBe(true);
  });
});
