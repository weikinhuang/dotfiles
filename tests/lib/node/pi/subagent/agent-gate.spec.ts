/**
 * Tests for `lib/node/pi/subagent/agent-gate.ts` - pure decision matrix
 * for the inline agent-gate extension factory installed inside child
 * subagent sessions.
 */

import { describe, expect, test } from 'vitest';

import {
  type AgentGateConfig,
  type AgentGateExtensionAPI,
  type AgentGateToolCallEvent,
  createAgentGateFactory,
  decideAgentGate,
} from '../../../../../lib/node/pi/subagent/agent-gate.ts';

const baseConfig = (overrides: Partial<AgentGateConfig> = {}): AgentGateConfig => ({
  name: overrides.name ?? 'plan',
  bashAllow: overrides.bashAllow ?? [],
  bashDeny: overrides.bashDeny ?? [],
  resolvedWriteRoots: overrides.resolvedWriteRoots ?? [],
  requestOptions: overrides.requestOptions,
});

const resolveAbsolute = (cwd: string, p: string): string => (p.startsWith('/') ? p : `${cwd}/${p}`);

const ev = (toolName: string, input: Record<string, unknown> = {}): AgentGateToolCallEvent => ({ toolName, input });

// ──────────────────────────────────────────────────────────────────────
// decideAgentGate - bash branch
// ──────────────────────────────────────────────────────────────────────

describe('decideAgentGate: bash', () => {
  test('subagent / subagent_send always pass through', () => {
    const config = baseConfig({ bashDeny: ['*'] });

    expect(
      decideAgentGate({ event: ev('subagent'), config, cwd: '/repo', resolveAbsolute, enforceWriteRoots: true }),
    ).toBeUndefined();
    expect(
      decideAgentGate({ event: ev('subagent_send'), config, cwd: '/repo', resolveAbsolute, enforceWriteRoots: true }),
    ).toBeUndefined();
  });

  test('empty bash policy → no gating', () => {
    const config = baseConfig();

    expect(
      decideAgentGate({
        event: ev('bash', { command: 'rm -rf /etc' }),
        config,
        cwd: '/repo',
        resolveAbsolute,
        enforceWriteRoots: false,
      }),
    ).toBeUndefined();
  });

  test('bashAllow narrows - matching command passes', () => {
    const config = baseConfig({ bashAllow: ['rg *'] });

    expect(
      decideAgentGate({
        event: ev('bash', { command: 'rg pattern' }),
        config,
        cwd: '/repo',
        resolveAbsolute,
        enforceWriteRoots: false,
      }),
    ).toBeUndefined();
  });

  test('bashAllow narrows - non-matching command blocks', () => {
    const config = baseConfig({ bashAllow: ['rg *'] });
    const result = decideAgentGate({
      event: ev('bash', { command: 'curl https://example.com' }),
      config,
      cwd: '/repo',
      resolveAbsolute,
      enforceWriteRoots: false,
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain('agent plan');
  });

  test('bashAllow + bashDeny - allow wins on overlap (matches persona semantics)', () => {
    const config = baseConfig({ bashAllow: ['rg *'], bashDeny: ['*'] });

    expect(
      decideAgentGate({
        event: ev('bash', { command: 'rg pattern' }),
        config,
        cwd: '/repo',
        resolveAbsolute,
        enforceWriteRoots: false,
      }),
    ).toBeUndefined();

    const blocked = decideAgentGate({
      event: ev('bash', { command: 'ls /tmp' }),
      config,
      cwd: '/repo',
      resolveAbsolute,
      enforceWriteRoots: false,
    });

    expect(blocked).toMatchObject({ block: true });
  });

  test('empty command short-circuits', () => {
    const config = baseConfig({ bashDeny: ['*'] });

    expect(
      decideAgentGate({
        event: ev('bash', { command: '   ' }),
        config,
        cwd: '/repo',
        resolveAbsolute,
        enforceWriteRoots: false,
      }),
    ).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// decideAgentGate - write / edit branch
// ──────────────────────────────────────────────────────────────────────

describe('decideAgentGate: write / edit', () => {
  test('enforceWriteRoots=false → never blocks', () => {
    const config = baseConfig({ resolvedWriteRoots: ['/repo/plans/'] });

    expect(
      decideAgentGate({
        event: ev('write', { path: '/etc/passwd' }),
        config,
        cwd: '/repo',
        resolveAbsolute,
        enforceWriteRoots: false,
      }),
    ).toBeUndefined();
  });

  test('enforceWriteRoots=true + empty roots → block every write', () => {
    const config = baseConfig({ resolvedWriteRoots: [] });
    const result = decideAgentGate({
      event: ev('write', { path: 'plans/note.md' }),
      config,
      cwd: '/repo',
      resolveAbsolute,
      enforceWriteRoots: true,
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain('declares no writeRoots');
  });

  test('inside writeRoots → allow', () => {
    const config = baseConfig({ resolvedWriteRoots: ['/repo/plans/'] });

    expect(
      decideAgentGate({
        event: ev('write', { path: '/repo/plans/note.md' }),
        config,
        cwd: '/repo',
        resolveAbsolute,
        enforceWriteRoots: true,
      }),
    ).toBeUndefined();
  });

  test('outside writeRoots → block with diagnostic', () => {
    const config = baseConfig({ resolvedWriteRoots: ['/repo/plans/'] });
    const result = decideAgentGate({
      event: ev('edit', { path: '/repo/src/main.ts' }),
      config,
      cwd: '/repo',
      resolveAbsolute,
      enforceWriteRoots: true,
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain('/repo/plans/');
    expect(result?.reason).toContain('/repo/src/main.ts');
  });

  test('empty path string short-circuits (allow - pi will reject the call itself)', () => {
    const config = baseConfig({ resolvedWriteRoots: ['/repo/plans/'] });

    expect(
      decideAgentGate({
        event: ev('write', { path: '' }),
        config,
        cwd: '/repo',
        resolveAbsolute,
        enforceWriteRoots: true,
      }),
    ).toBeUndefined();
  });

  test('non-write/edit/bash tools never gated', () => {
    const config = baseConfig({ bashDeny: ['*'], resolvedWriteRoots: ['/repo/plans/'] });

    expect(
      decideAgentGate({
        event: ev('read', { path: '/etc/passwd' }),
        config,
        cwd: '/repo',
        resolveAbsolute,
        enforceWriteRoots: true,
      }),
    ).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// createAgentGateFactory - wires both handlers and merges requestOptions
// ──────────────────────────────────────────────────────────────────────

describe('createAgentGateFactory', () => {
  type ToolCallHandler = (event: AgentGateToolCallEvent, ctx: { cwd: string; model?: { api?: string } }) => unknown;
  type RequestHandler = (event: { payload: unknown }, ctx: { cwd: string; model?: { api?: string } }) => unknown;

  const makeApi = (): {
    api: AgentGateExtensionAPI;
    toolCalls: ToolCallHandler[];
    requests: RequestHandler[];
  } => {
    const toolCalls: ToolCallHandler[] = [];
    const requests: RequestHandler[] = [];
    const api: AgentGateExtensionAPI = {
      on: (event: string, handler: unknown): void => {
        if (event === 'tool_call') toolCalls.push(handler as ToolCallHandler);
        if (event === 'before_provider_request') requests.push(handler as RequestHandler);
      },
    };
    return { api, toolCalls, requests };
  };

  test('registers a tool_call handler that delegates to decideAgentGate', () => {
    const factory = createAgentGateFactory({
      config: baseConfig({ bashAllow: ['rg *'] }),
      enforceWriteRoots: false,
      resolveAbsolute,
    });
    const { api, toolCalls, requests } = makeApi();
    factory(api);

    expect(toolCalls).toHaveLength(1);
    expect(requests).toHaveLength(0);

    const handler = toolCalls[0];

    expect(handler(ev('bash', { command: 'rg foo' }), { cwd: '/repo' })).toBeUndefined();
    expect(handler(ev('bash', { command: 'curl x' }), { cwd: '/repo' })).toMatchObject({ block: true });
  });

  test('skips before_provider_request when no requestOptions', () => {
    const factory = createAgentGateFactory({
      config: baseConfig(),
      enforceWriteRoots: false,
      resolveAbsolute,
    });
    const { api, requests } = makeApi();
    factory(api);

    expect(requests).toHaveLength(0);
  });

  test('registers before_provider_request when requestOptions present, deep-merging into payload', () => {
    const factory = createAgentGateFactory({
      config: baseConfig({
        requestOptions: { temperature: 0.42, chat_template_kwargs: { enable_thinking: true } },
      }),
      enforceWriteRoots: false,
      resolveAbsolute,
    });
    const { api, requests } = makeApi();
    factory(api);

    expect(requests).toHaveLength(1);

    const handler = requests[0];
    const result = handler(
      { payload: { temperature: 1.0, chat_template_kwargs: { preserve_thinking: true } } },
      { cwd: '/repo', model: { api: 'openai-completions' } },
    );

    expect(result).toEqual({
      temperature: 0.42,
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
    });
  });

  test('apis filter on requestOptions scopes the merge by api', () => {
    const factory = createAgentGateFactory({
      config: baseConfig({
        requestOptions: { apis: ['openai-completions'], temperature: 0.42 },
      }),
      enforceWriteRoots: false,
      resolveAbsolute,
    });
    const { api, requests } = makeApi();
    factory(api);

    const handler = requests[0];
    const matched = handler({ payload: { temperature: 1.0 } }, { cwd: '/repo', model: { api: 'openai-completions' } });

    expect(matched).toEqual({ temperature: 0.42 });

    const filtered = handler({ payload: { temperature: 1.0 } }, { cwd: '/repo', model: { api: 'anthropic-messages' } });

    expect(filtered).toBeUndefined();
  });
});
