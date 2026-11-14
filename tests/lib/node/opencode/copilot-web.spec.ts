/**
 * Tests for lib/node/opencode/copilot-web.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  endpointFromCredential,
  FETCH_TOOL_INPUT_SCHEMA,
  resolveCopilotWebConfig,
  toolsToHide,
} from '../../../../lib/node/opencode/copilot-web.ts';
import { DEFAULT_COPILOT_WEB_MODEL, DEFAULT_TIMEOUT_MS } from '../../../../lib/node/pi/copilot-web.ts';

describe('resolveCopilotWebConfig', () => {
  test('defaults', () => {
    expect(resolveCopilotWebConfig(undefined, {})).toEqual({
      enabled: true,
      websearch: true,
      setDefault: true,
      fetchTool: true,
      model: DEFAULT_COPILOT_WEB_MODEL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      integrationID: 'github-copilot',
      always: false,
      providerID: 'github-copilot',
    });
  });

  test('env beats options beats defaults', () => {
    const config = resolveCopilotWebConfig(
      { model: 'gpt-6.1-terra', fetchTool: false, timeoutMs: 5000 },
      { OPENCODE_COPILOT_WEB_MODEL: 'gpt-5.6-luna', OPENCODE_COPILOT_WEB_SET_DEFAULT: '0' },
    );
    expect(config).toMatchObject({ model: 'gpt-5.6-luna', fetchTool: false, setDefault: false, timeoutMs: 5000 });
  });

  test('a zero timeout falls back to the default', () => {
    expect(resolveCopilotWebConfig({ timeoutMs: 0 }, {}).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe('endpointFromCredential', () => {
  test('OAuth: uses the refresh token and metadata.apiEndpoint', () => {
    expect(
      endpointFromCredential({
        type: 'oauth',
        refresh: 'gho_refresh',
        access: 'gho_access',
        expires: 0,
        metadata: { apiEndpoint: 'https://api.business.githubcopilot.com' },
      }),
    ).toEqual({ token: 'gho_refresh', baseUrl: 'https://api.business.githubcopilot.com' });
  });

  test('OAuth: falls back to access, enterprise host, and the public default', () => {
    expect(
      endpointFromCredential({
        type: 'oauth',
        refresh: '',
        access: 'gho_a',
        metadata: { enterpriseUrl: 'acme.ghe.com' },
      }),
    ).toEqual({ token: 'gho_a', baseUrl: 'https://copilot-api.acme.ghe.com' });
    expect(endpointFromCredential({ type: 'oauth', refresh: 'gho_r' })).toEqual({
      token: 'gho_r',
      baseUrl: 'https://api.githubcopilot.com',
    });
  });

  test('a Copilot session token names its own host', () => {
    expect(endpointFromCredential({ type: 'key', key: 'tid=1;proxy-ep=proxy.individual.githubcopilot.com' })).toEqual({
      token: 'tid=1;proxy-ep=proxy.individual.githubcopilot.com',
      baseUrl: 'https://api.individual.githubcopilot.com',
    });
  });

  test('reports missing or unusable credentials', () => {
    const errorOf = (credential: unknown): string | undefined => {
      const r = endpointFromCredential(credential);
      return 'error' in r ? r.error : undefined;
    };
    expect(errorOf(undefined)).toMatch(/not connected/);
    expect(errorOf({ type: 'oauth', refresh: ' ', access: '' })).toMatch(/no token/);
    expect(errorOf({ type: 'key', key: '' })).toMatch(/empty/);
    expect(errorOf({ type: 'wellknown' })).toMatch(/Unsupported/);
  });
});

test('FETCH_TOOL_INPUT_SCHEMA requires only url', () => {
  expect(FETCH_TOOL_INPUT_SCHEMA.required).toEqual(['url']);
});

describe('toolsToHide', () => {
  const config = { always: false, providerID: 'github-copilot' };

  test('keeps everything on a Copilot model', () => {
    expect(toolsToHide(config, { providerID: 'github-copilot', ownsWebsearch: true })).toEqual([]);
  });

  test('hides fetch, and websearch only while the Copilot backend serves it', () => {
    expect(toolsToHide(config, { providerID: 'amazon-bedrock', ownsWebsearch: true })).toEqual([
      'copilot_web_fetch',
      'websearch',
    ]);
    expect(toolsToHide(config, { providerID: 'openai', ownsWebsearch: false })).toEqual(['copilot_web_fetch']);
  });

  test('always and a custom providerID override the gate', () => {
    expect(toolsToHide({ ...config, always: true }, { providerID: 'openai', ownsWebsearch: true })).toEqual([]);
    expect(
      toolsToHide({ always: false, providerID: 'copilot-work' }, { providerID: 'copilot-work', ownsWebsearch: true }),
    ).toEqual([]);
  });
});
