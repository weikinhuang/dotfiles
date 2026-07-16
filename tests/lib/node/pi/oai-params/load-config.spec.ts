/**
 * Tests for lib/node/pi/oai-params/load-config.ts (disk layering).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { loadVariantRegistrations } from '../../../../../lib/node/pi/oai-params/load-config.ts';

describe('loadVariantRegistrations', () => {
  let agentDir: string;
  let cwd: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'oai-agent-'));
    cwd = mkdtempSync(join(tmpdir(), 'oai-cwd-'));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const writeAgent = (file: string, data: unknown): void => {
    writeFileSync(join(agentDir, file), typeof data === 'string' ? data : JSON.stringify(data));
  };
  const writeProject = (file: string, data: unknown): void => {
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(cwd, '.pi', file), typeof data === 'string' ? data : JSON.stringify(data));
  };

  const modelsJson = {
    providers: {
      'llama-cpp': {
        baseUrl: 'https://llm.example.com/v1',
        api: 'openai-completions',
        apiKey: 'sk-local',
        models: [
          {
            id: 'qwen3-6-27b',
            name: 'Qwen',
            reasoning: true,
            input: ['text'],
            contextWindow: 163840,
            maxTokens: 32768,
          },
        ],
      },
    },
  };

  test('empty when no oai-params.json exists', () => {
    writeAgent('models.json', modelsJson);
    const out = loadVariantRegistrations(cwd);
    expect(out.variants).toEqual([]);
    expect(out.registrations).toEqual([]);
    expect(out.injections.size).toBe(0);
  });

  test('resolves a global variant against global models.json', () => {
    writeAgent('models.json', modelsJson);
    writeAgent('oai-params.json', {
      'qwen-creative': { extends: 'llama-cpp/qwen3-6-27b', samplingParams: { temperature: 1.0 } },
    });
    const out = loadVariantRegistrations(cwd);
    expect(out.errors).toEqual([]);
    expect(out.registrations.map((r) => r.providerName)).toEqual(['qwen-creative']);
    expect(out.injections.get('qwen-creative')?.parentId).toBe('qwen3-6-27b');
  });

  test('project oai-params.json overrides global by id', () => {
    writeAgent('models.json', modelsJson);
    writeAgent('oai-params.json', {
      'qwen-creative': { extends: 'llama-cpp/qwen3-6-27b', samplingParams: { temperature: 0.5 } },
    });
    writeProject('oai-params.json', {
      'qwen-creative': { extends: 'llama-cpp/qwen3-6-27b', samplingParams: { temperature: 1.2 } },
    });
    const out = loadVariantRegistrations(cwd);
    expect(out.injections.get('qwen-creative')?.samplingParams).toEqual({ temperature: 1.2 });
  });

  test('tolerates JSONC comments and trailing commas', () => {
    writeAgent('models.json', modelsJson);
    writeAgent(
      'oai-params.json',
      `{
        // a creative preset
        "qwen-creative": { "extends": "llama-cpp/qwen3-6-27b", "samplingParams": { "top_k": 40, } },
      }`,
    );
    const out = loadVariantRegistrations(cwd);
    expect(out.errors).toEqual([]);
    expect(out.injections.get('qwen-creative')?.samplingParams).toEqual({ top_k: 40 });
  });

  test('surfaces resolution errors for an unknown parent', () => {
    writeAgent('models.json', modelsJson);
    writeAgent('oai-params.json', { orphan: { extends: 'ghost/model' } });
    const out = loadVariantRegistrations(cwd);
    expect(out.registrations).toEqual([]);
    expect(out.errors[0]).toContain('unknown provider "ghost"');
  });
});
