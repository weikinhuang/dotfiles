/**
 * Tests for lib/node/decision-model/config.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  DEFAULT_SHELL_POLICY,
  describeDecisionModelStatus,
  loadDecisionModelConfig,
  resolveDecisionModelConfig,
  type ResolveOptions,
} from '../../../../lib/node/decision-model/config.ts';

const OPTS: ResolveOptions = {
  configPath: '/home/u/.pi/agent/decision-model.json',
  defaultLogPath: '/home/u/.pi/agent/decision-model.jsonl',
  env: { TYPESAFE_API_KEY: 'secret-key' },
  home: '/home/u',
};

const MINIMAL = {
  provider: { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', apiKeyEnv: 'TYPESAFE_API_KEY' },
};

test('resolve: a minimal config is ready with defaults', () => {
  const status = resolveDecisionModelConfig(MINIMAL, OPTS);
  expect(status.state).toBe('ready');
  if (status.state !== 'ready') return;
  const { config } = status;
  expect(config.endpoint.url).toBe('https://api.typesafe.ai/v1/systemone');
  expect(config.endpoint.apiKey).toBe('secret-key');
  expect(config.endpoint.timeoutMs).toBe(3000);
  expect(config.providerLabel).toBe('api.typesafe.ai');
  expect(config.logPath).toBe(OPTS.defaultLogPath);
  expect(config.shell).toEqual(DEFAULT_SHELL_POLICY);
});

test('resolve: missing / disabled / invalid states', () => {
  expect(resolveDecisionModelConfig(undefined, OPTS)).toEqual({ state: 'missing' });
  expect(resolveDecisionModelConfig({ ...MINIMAL, enabled: false }, OPTS)).toEqual({ state: 'disabled' });
  expect(resolveDecisionModelConfig([], OPTS).state).toBe('invalid');
  expect(resolveDecisionModelConfig({}, OPTS)).toMatchObject({ state: 'invalid', error: '"provider" is required' });
  expect(resolveDecisionModelConfig({ provider: { model: 'm', apiKey: 'k' } }, OPTS)).toMatchObject({
    state: 'invalid',
    error: '"provider.baseUrl" is required',
  });
  expect(resolveDecisionModelConfig({ provider: { baseUrl: 'not a url', model: 'm', apiKey: 'k' } }, OPTS).state).toBe(
    'invalid',
  );
  expect(resolveDecisionModelConfig({ provider: { baseUrl: 'https://x', apiKey: 'k' } }, OPTS)).toMatchObject({
    state: 'invalid',
    error: '"provider.model" is required',
  });
});

test('resolve: API key from env wins; the literal key is the fallback', () => {
  const both = { provider: { ...MINIMAL.provider, apiKey: 'literal' } };
  const ready = resolveDecisionModelConfig(both, OPTS);
  expect(ready.state === 'ready' && ready.config.endpoint.apiKey).toBe('secret-key');

  const fallback = resolveDecisionModelConfig(both, { ...OPTS, env: {} });
  expect(fallback.state === 'ready' && fallback.config.endpoint.apiKey).toBe('literal');

  const blank = resolveDecisionModelConfig(both, { ...OPTS, env: { TYPESAFE_API_KEY: '  ' } });
  expect(blank.state === 'ready' && blank.config.endpoint.apiKey).toBe('literal');

  const neither = resolveDecisionModelConfig(MINIMAL, { ...OPTS, env: {} });
  expect(neither).toMatchObject({
    state: 'invalid',
    error: 'API key env var TYPESAFE_API_KEY is unset and no "provider.apiKey" is set',
  });

  const noKeyAtAll = resolveDecisionModelConfig({ provider: { baseUrl: 'https://x', model: 'm' } }, OPTS);
  expect(noKeyAtAll).toMatchObject({ state: 'invalid', error: 'set "provider.apiKey" or "provider.apiKeyEnv"' });

  const literal = resolveDecisionModelConfig(
    { provider: { baseUrl: 'https://x', model: 'm', apiKey: 'literal' } },
    { ...OPTS, env: {} },
  );
  expect(literal.state === 'ready' && literal.config.endpoint.apiKey).toBe('literal');
});

test('resolve: endpoint override, headers, timeout, and state budget', () => {
  const status = resolveDecisionModelConfig(
    {
      maxStateChars: 1200,
      provider: {
        ...MINIMAL.provider,
        endpoint: 'https://gw.example/ai/run/@cf/cloudflare/clef',
        headers: { 'X-A': 'b', 'X-Bad': 3 },
        timeoutMs: 800,
      },
    },
    OPTS,
  );
  expect(status.state).toBe('ready');
  if (status.state !== 'ready') return;
  expect(status.config.endpoint.url).toBe('https://gw.example/ai/run/@cf/cloudflare/clef');
  expect(status.config.providerLabel).toBe('gw.example');
  expect(status.config.endpoint.headers).toEqual({ 'X-A': 'b' });
  expect(status.config.endpoint.timeoutMs).toBe(800);
  expect(status.config.maxStateChars).toBe(1200);
});

test('resolve: log path can be disabled, absolute, ~-relative, or relative to the config', () => {
  const logOf = (log: unknown): string | undefined => {
    const s = resolveDecisionModelConfig({ ...MINIMAL, log }, OPTS);
    return s.state === 'ready' ? s.config.logPath : 'not-ready';
  };
  expect(logOf(false)).toBeUndefined();
  expect(logOf(true)).toBe(OPTS.defaultLogPath);
  expect(logOf('/var/log/dm.jsonl')).toBe('/var/log/dm.jsonl');
  expect(logOf('~/logs/dm.jsonl')).toBe('/home/u/logs/dm.jsonl');
  expect(logOf('dm.jsonl')).toBe('/home/u/.pi/agent/dm.jsonl');
});

test('resolve: shell policy overrides and unknown effects warn', () => {
  const warnings: string[] = [];
  const status = resolveDecisionModelConfig(
    { ...MINIMAL, shell: { allowEffects: ['read_only', 'everything'], threshold: 0.95, maxRisk: 2 } },
    OPTS,
    warnings,
  );
  expect(status.state === 'ready' && status.config.shell).toEqual({
    enabled: true,
    allowEffects: ['read_only'],
    threshold: 0.95,
    maxRisk: DEFAULT_SHELL_POLICY.maxRisk,
  });
  expect(warnings[0]).toContain('allowEffects');

  const off = resolveDecisionModelConfig({ ...MINIMAL, shell: { enabled: false } }, OPTS);
  expect(off.state === 'ready' && off.config.shell.enabled).toBe(false);
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-model-config-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('load: missing file is silent, JSONC parses, a parse error is invalid', () => {
  const configPath = join(dir, 'decision-model.json');
  const opts = { ...OPTS, configPath };
  expect(loadDecisionModelConfig(opts)).toEqual({ status: { state: 'missing' }, warnings: [] });

  writeFileSync(configPath, `{\n  // Jev\n  "provider": ${JSON.stringify(MINIMAL.provider)},\n}\n`);
  expect(loadDecisionModelConfig(opts).status.state).toBe('ready');

  writeFileSync(configPath, '{ "provider": ');
  expect(loadDecisionModelConfig(opts).status.state).toBe('invalid');
});

test('describe: status lines never include the key', () => {
  const ready = resolveDecisionModelConfig(MINIMAL, OPTS);
  const line = describeDecisionModelStatus(ready, OPTS.configPath);
  expect(line).toContain('on (api.typesafe.ai, jev-latest');
  expect(line).toContain('read_only+workspace_write');
  expect(line).not.toContain('secret-key');
  expect(describeDecisionModelStatus({ state: 'missing' }, '/x.json')).toBe('off (no /x.json)');
  expect(describeDecisionModelStatus({ state: 'invalid', error: 'boom' }, '/x.json')).toBe('off (/x.json: boom)');
});
