/**
 * Tests for lib/node/pi/subagent/config.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  coerceSubagentConfigLayer,
  DEFAULT_SUBAGENT_CONFIG,
  loadSubagentConfig,
  mergeSubagentConfigLayers,
  subagentEnvLayer,
} from '../../../../../lib/node/pi/subagent/config.ts';

describe('coerceSubagentConfigLayer', () => {
  test('keeps well-typed fields and drops wrong-typed ones', () => {
    expect(coerceSubagentConfigLayer({ model: 'openai/gpt', maxTurns: 10, concurrency: 2, bogus: 1 })).toEqual({
      model: 'openai/gpt',
      maxTurns: 10,
      concurrency: 2,
    });
  });

  test('rejects empty model and non-positive numbers', () => {
    expect(coerceSubagentConfigLayer({ model: '   ' }).model).toBeUndefined();
    expect(coerceSubagentConfigLayer({ maxTurns: 0 }).maxTurns).toBeUndefined();
    expect(coerceSubagentConfigLayer({ concurrency: -1 }).concurrency).toBeUndefined();
  });

  test('does not clamp concurrency at the layer level', () => {
    expect(coerceSubagentConfigLayer({ concurrency: 99 }).concurrency).toBe(99);
  });

  test('drops a model that is not a valid provider/id spec', () => {
    // Regression: previously ANY non-empty string was accepted, so a
    // bare "gpt-4" (no provider slash) flowed through to the model
    // registry as an un-resolvable override. Now validated + dropped.
    expect(coerceSubagentConfigLayer({ model: 'gpt-4' }).model).toBeUndefined();
    expect(coerceSubagentConfigLayer({ model: 'openai/' }).model).toBeUndefined();
    expect(coerceSubagentConfigLayer({ model: '/gpt' }).model).toBeUndefined();
    expect(coerceSubagentConfigLayer({ model: 42 as unknown as string }).model).toBeUndefined();
  });

  test('normalizes a valid model spec (trims components, keeps modelId slashes)', () => {
    expect(coerceSubagentConfigLayer({ model: ' openai / gpt-4o ' }).model).toBe('openai/gpt-4o');
    expect(coerceSubagentConfigLayer({ model: 'amazon-bedrock/us.anthropic.model:0' }).model).toBe(
      'amazon-bedrock/us.anthropic.model:0',
    );
  });

  test('non-object input yields an empty layer', () => {
    expect(coerceSubagentConfigLayer(null)).toEqual({});
    expect(coerceSubagentConfigLayer('x')).toEqual({});
  });
});

describe('subagentEnvLayer', () => {
  test('reads the three PI_SUBAGENT_* knobs', () => {
    expect(
      subagentEnvLayer({ PI_SUBAGENT_MODEL: 'local/llama', PI_SUBAGENT_MAX_TURNS: '5', PI_SUBAGENT_CONCURRENCY: '2' }),
    ).toEqual({ model: 'local/llama', maxTurns: 5, concurrency: 2 });
  });

  test('drops invalid env values', () => {
    expect(subagentEnvLayer({ PI_SUBAGENT_MAX_TURNS: 'lots' })).toEqual({});
    expect(subagentEnvLayer({})).toEqual({});
  });

  test('drops a PI_SUBAGENT_MODEL that is not provider/id', () => {
    expect(subagentEnvLayer({ PI_SUBAGENT_MODEL: 'gpt-4' })).toEqual({});
    expect(subagentEnvLayer({ PI_SUBAGENT_MODEL: '' })).toEqual({});
  });
});

describe('mergeSubagentConfigLayers', () => {
  test('no layers returns the built-in defaults', () => {
    expect(mergeSubagentConfigLayers()).toEqual(DEFAULT_SUBAGENT_CONFIG);
  });

  test('higher layers override lower ones', () => {
    const out = mergeSubagentConfigLayers({ model: 'a', maxTurns: 3 }, { model: 'b' });
    expect(out.model).toBe('b');
    expect(out.maxTurns).toBe(3);
  });

  test('clamps the final resolved concurrency to [1, 8]', () => {
    expect(mergeSubagentConfigLayers({ concurrency: 99 }).concurrency).toBe(8);
    expect(mergeSubagentConfigLayers({ concurrency: 1 }).concurrency).toBe(1);
  });
});

describe('loadSubagentConfig', () => {
  let agentDir: string;
  let cwd: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'subagent-agent-'));
    cwd = mkdtempSync(join(tmpdir(), 'subagent-cwd-'));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const writeUser = (config: unknown): void => writeFileSync(join(agentDir, 'subagent.json'), JSON.stringify(config));
  const writeProject = (config: unknown): void => {
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'subagent.json'), JSON.stringify(config));
  };

  test('with no files and no env returns the built-in defaults', () => {
    expect(loadSubagentConfig(cwd, {})).toEqual(DEFAULT_SUBAGENT_CONFIG);
  });

  test('project beats user beats env knob', () => {
    writeUser({ model: 'user/m', maxTurns: 10 });
    writeProject({ model: 'project/m' });
    const config = loadSubagentConfig(cwd, { PI_SUBAGENT_MODEL: 'env/m', PI_SUBAGENT_CONCURRENCY: '2' });
    expect(config.model).toBe('project/m');
    expect(config.maxTurns).toBe(10);
    // env wins for concurrency (no file sets it), still clamped
    expect(config.concurrency).toBe(2);
  });

  test('malformed files degrade to env + defaults', () => {
    writeFileSync(join(agentDir, 'subagent.json'), '{ not json');
    expect(loadSubagentConfig(cwd, {})).toEqual(DEFAULT_SUBAGENT_CONFIG);
  });
});
