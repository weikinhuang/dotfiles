/**
 * Tests for lib/node/pi/llama-thinking-budget/load-config.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  loadProviderInjections,
  loadSettingsBudgets,
} from '../../../../../lib/node/pi/llama-thinking-budget/load-config.ts';

describe('loadSettingsBudgets / loadProviderInjections', () => {
  let agentDir: string;
  let cwd: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'ltb-agent-'));
    cwd = mkdtempSync(join(tmpdir(), 'ltb-cwd-'));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const writeUserSettings = (config: unknown): void => {
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(config));
  };
  const writeProjectSettings = (config: unknown): void => {
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify(config));
  };
  const writeUserModels = (config: unknown): void => {
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify(config));
  };
  const writeProjectModels = (config: unknown): void => {
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'models.json'), JSON.stringify(config));
  };

  test('with no files returns empty budgets / no providers', () => {
    expect(loadSettingsBudgets(cwd)).toEqual({});
    expect(loadProviderInjections(cwd).size).toBe(0);
  });

  test('reads thinkingBudgets from the user settings.json', () => {
    writeUserSettings({ thinkingBudgets: { minimal: 100, high: 400 } });
    expect(loadSettingsBudgets(cwd)).toEqual({ minimal: 100, high: 400 });
  });

  test('project settings overlay user settings by level', () => {
    writeUserSettings({ thinkingBudgets: { minimal: 100, low: 200 } });
    writeProjectSettings({ thinkingBudgets: { low: 999 } });
    expect(loadSettingsBudgets(cwd)).toEqual({ minimal: 100, low: 999 });
  });

  test('malformed settings degrade to empty', () => {
    writeFileSync(join(agentDir, 'settings.json'), '{ not json');
    expect(loadSettingsBudgets(cwd)).toEqual({});
  });

  test('collects opted-in providers from models.json', () => {
    writeUserModels({
      providers: {
        'llama-cpp': { thinkingBudgetInjection: { field: 'tbt', budgets: { medium: 8192 } } },
        'no-inject': { baseUrl: 'http://x' },
      },
    });
    const providers = loadProviderInjections(cwd);
    expect([...providers.keys()]).toEqual(['llama-cpp']);
    expect(providers.get('llama-cpp')?.field).toBe('tbt');
    expect(providers.get('llama-cpp')?.budgets).toEqual({ medium: 8192 });
  });

  test('project models win over user models for the same provider', () => {
    writeUserModels({ providers: { p: { thinkingBudgetInjection: { field: 'user' } } } });
    writeProjectModels({ providers: { p: { thinkingBudgetInjection: { field: 'project' } } } });
    expect(loadProviderInjections(cwd).get('p')?.field).toBe('project');
  });

  test('malformed models.json degrades to no providers', () => {
    writeFileSync(join(agentDir, 'models.json'), '{ not json');
    expect(loadProviderInjections(cwd).size).toBe(0);
  });

  test('accepts JSONC comments in config files', () => {
    writeFileSync(
      join(agentDir, 'models.json'),
      ['{', '  // a comment', '  "providers": { "p": { "thinkingBudgetInjection": {} } },', '}'].join('\n'),
    );
    expect(loadProviderInjections(cwd).get('p')?.field).toBe('thinking_budget_tokens');
  });
});
