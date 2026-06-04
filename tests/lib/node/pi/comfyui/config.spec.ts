/**
 * Tests for lib/node/pi/comfyui/config.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  coerceConfigLayer,
  DEFAULT_CONFIG,
  interpolateEnv,
  loadComfyuiConfig,
  loadUserWorkflowNames,
  mergeConfigLayers,
  resolveAuthHeaders,
  resolveBaseUrl,
  resolveSendToModel,
  SHIPPED_WORKFLOW_INPUTS,
} from '../../../../../lib/node/pi/comfyui/config.ts';
import type { WorkflowConfig } from '../../../../../lib/node/pi/comfyui/types.ts';

describe('coerceConfigLayer', () => {
  test('keeps well-typed fields and drops wrong-typed ones', () => {
    const out = coerceConfigLayer({
      baseUrl: 'https://comfy.example:8188',
      timeoutMs: 60000,
      saveDir: 'out',
      defaultWorkflow: 'txt2img',
      timeoutMsTypo: 1,
    });
    expect(out).toEqual({
      baseUrl: 'https://comfy.example:8188',
      timeoutMs: 60000,
      saveDir: 'out',
      defaultWorkflow: 'txt2img',
    });
  });

  test('rejects non-positive / non-finite timeoutMs and empty strings', () => {
    expect(coerceConfigLayer({ timeoutMs: 0 }).timeoutMs).toBeUndefined();
    expect(coerceConfigLayer({ timeoutMs: -5 }).timeoutMs).toBeUndefined();
    expect(coerceConfigLayer({ baseUrl: '' }).baseUrl).toBeUndefined();
    expect(coerceConfigLayer({ saveDir: '' }).saveDir).toBeUndefined();
  });

  test('coerces the sendToModel boolean and drops a non-boolean', () => {
    expect(coerceConfigLayer({ sendToModel: false }).sendToModel).toBe(false);
    expect(coerceConfigLayer({ sendToModel: 'no' }).sendToModel).toBeUndefined();
  });

  test('coerces the background boolean and drops a non-boolean', () => {
    expect(coerceConfigLayer({ background: true }).background).toBe(true);
    expect(coerceConfigLayer({ background: 'yes' }).background).toBeUndefined();
  });

  test('parses a well-formed auth header and rejects a malformed one', () => {
    expect(coerceConfigLayer({ authHeader: { name: 'Authorization', value: 'Bearer x' } }).authHeader).toEqual({
      name: 'Authorization',
      value: 'Bearer x',
    });
    expect(coerceConfigLayer({ authHeader: { name: '', value: 'x' } }).authHeader).toBeUndefined();
    expect(coerceConfigLayer({ authHeader: { name: 'X' } }).authHeader).toBeUndefined();
  });

  test('keeps only well-formed workflows and input mappings', () => {
    const out = coerceConfigLayer({
      workflows: {
        txt2img: {
          file: '~/wf.json',
          inputs: {
            prompt: { node: '6', key: 'text' },
            broken: { node: '3' },
            alsoBroken: { node: '', key: 'x' },
          },
        },
        noFile: { inputs: {} },
      },
    });
    expect(out.workflows).toEqual({
      txt2img: { file: '~/wf.json', inputs: { prompt: { node: '6', key: 'text' } } },
    });
  });

  test('coerces a generation defaults block, dropping wrong-typed fields', () => {
    const out = coerceConfigLayer({
      defaults: { width: 1024, height: 1024, steps: 30, cfg: 5, denoise: 0.7, count: 2, negative: 'blurry' },
    });
    expect(out.defaults).toEqual({
      width: 1024,
      height: 1024,
      steps: 30,
      cfg: 5,
      denoise: 0.7,
      count: 2,
      negative: 'blurry',
    });
  });

  test('rejects non-positive / non-finite numeric defaults but keeps a valid negative', () => {
    const out = coerceConfigLayer({ defaults: { width: 0, height: -5, steps: 'lots', negative: '' } });
    expect(out.defaults).toEqual({ negative: '' });
  });

  test('an all-garbage defaults block is dropped entirely', () => {
    expect(coerceConfigLayer({ defaults: { width: 0, steps: -1 } }).defaults).toBeUndefined();
    expect(coerceConfigLayer({ defaults: 'nope' }).defaults).toBeUndefined();
  });

  test('non-object input yields an empty layer', () => {
    expect(coerceConfigLayer(null)).toEqual({});
    expect(coerceConfigLayer('str')).toEqual({});
    expect(coerceConfigLayer([1, 2])).toEqual({});
  });
});

describe('mergeConfigLayers', () => {
  test('with no layers returns a copy of the defaults', () => {
    const out = mergeConfigLayers();
    expect(out).toEqual(DEFAULT_CONFIG);
    expect(out.workflows).not.toBe(DEFAULT_CONFIG.workflows);
  });

  test('higher-priority scalar layers override lower ones', () => {
    const out = mergeConfigLayers({ baseUrl: 'http://a', timeoutMs: 1000 }, { baseUrl: 'http://b' });
    expect(out.baseUrl).toBe('http://b');
    expect(out.timeoutMs).toBe(1000);
  });

  test('sendToModel defaults to true and is overridable', () => {
    expect(mergeConfigLayers().sendToModel).toBe(true);
    expect(mergeConfigLayers({ sendToModel: false }).sendToModel).toBe(false);
  });

  test('background defaults to false and is overridable', () => {
    expect(mergeConfigLayers().background).toBe(false);
    expect(mergeConfigLayers({ background: true }).background).toBe(true);
  });

  test('workflows merge by name across layers', () => {
    const base = { workflows: { txt2img: { file: 'a.json', inputs: {} } } };
    const over = {
      workflows: {
        txt2img: { file: 'b.json', inputs: {} },
        img2img: { file: 'c.json', inputs: {} },
      },
    };
    const out = mergeConfigLayers(base, over);
    expect(out.workflows).toEqual({
      txt2img: { file: 'b.json', inputs: {} },
      img2img: { file: 'c.json', inputs: {} },
    });
  });

  test('authHeader is replaced wholesale by a setting layer', () => {
    const out = mergeConfigLayers({ authHeader: { name: 'A', value: '1' } }, { authHeader: { name: 'B', value: '2' } });
    expect(out.authHeader).toEqual({ name: 'B', value: '2' });
  });

  test('defaults merge by field across layers', () => {
    const out = mergeConfigLayers(
      { defaults: { width: 512, height: 512, steps: 20 } },
      { defaults: { steps: 30, cfg: 5 } },
    );
    expect(out.defaults).toEqual({ width: 512, height: 512, steps: 30, cfg: 5 });
  });

  test('no defaults block leaves defaults undefined', () => {
    expect(mergeConfigLayers().defaults).toBeUndefined();
  });
});

describe('interpolateEnv', () => {
  test('expands ${VAR} from env and blanks unknowns', () => {
    expect(interpolateEnv('Bearer ${TOK}', { TOK: 'abc' })).toBe('Bearer abc');
    expect(interpolateEnv('Bearer ${MISSING}', {})).toBe('Bearer ');
    expect(interpolateEnv('no refs here', { TOK: 'abc' })).toBe('no refs here');
  });
});

describe('resolveBaseUrl', () => {
  test('PI_COMFYUI_URL overrides config and trailing slash is dropped', () => {
    const cfg = mergeConfigLayers({ baseUrl: 'http://config:8188/' });
    expect(resolveBaseUrl(cfg, {})).toBe('http://config:8188');
    expect(resolveBaseUrl(cfg, { PI_COMFYUI_URL: 'https://override:9000/' })).toBe('https://override:9000');
  });

  test('interpolates env refs in the base url', () => {
    const cfg = mergeConfigLayers({ baseUrl: 'https://${HOST}:8188' });
    expect(resolveBaseUrl(cfg, { HOST: 'comfy.internal' })).toBe('https://comfy.internal:8188');
  });
});

describe('resolveAuthHeaders', () => {
  test('returns interpolated header, or empty when unset / blank', () => {
    const withToken = mergeConfigLayers({ authHeader: { name: 'Authorization', value: 'Bearer ${TOK}' } });
    expect(resolveAuthHeaders(withToken, { TOK: 'secret' })).toEqual({ Authorization: 'Bearer secret' });
    expect(resolveAuthHeaders(mergeConfigLayers(), { TOK: 'secret' })).toEqual({});
    const blank = mergeConfigLayers({ authHeader: { name: 'X', value: '${MISSING}' } });
    expect(resolveAuthHeaders(blank, {})).toEqual({});
  });
});

describe('resolveSendToModel', () => {
  test('does not send when not requested, without flagging vision', () => {
    expect(resolveSendToModel(false, ['text', 'image'])).toEqual({ send: false, visionBlocked: false });
    expect(resolveSendToModel(false, ['text'])).toEqual({ send: false, visionBlocked: false });
  });

  test('sends when requested and the model accepts image input', () => {
    expect(resolveSendToModel(true, ['text', 'image'])).toEqual({ send: true, visionBlocked: false });
  });

  test('suppresses and flags vision when the model lacks image input', () => {
    expect(resolveSendToModel(true, ['text'])).toEqual({ send: false, visionBlocked: true });
    expect(resolveSendToModel(true, [])).toEqual({ send: false, visionBlocked: true });
  });

  test('honors the request when model capabilities are unknown', () => {
    expect(resolveSendToModel(true, undefined)).toEqual({ send: true, visionBlocked: false });
    expect(resolveSendToModel(true, null)).toEqual({ send: true, visionBlocked: false });
  });
});

describe('SHIPPED_WORKFLOW_INPUTS', () => {
  test('maps every shipped tunable to a node + input key', () => {
    expect(SHIPPED_WORKFLOW_INPUTS.prompt).toEqual({ node: '6', key: 'text' });
    expect(SHIPPED_WORKFLOW_INPUTS.batch).toEqual({ node: '5', key: 'batch_size' });
    expect(Object.keys(SHIPPED_WORKFLOW_INPUTS)).toEqual([
      'prompt',
      'negative',
      'seed',
      'steps',
      'cfg',
      'denoise',
      'width',
      'height',
      'batch',
    ]);
  });
});

describe('loadComfyuiConfig / loadUserWorkflowNames', () => {
  let agentDir: string;
  let cwd: string;
  let prevAgentDir: string | undefined;
  const shipped: WorkflowConfig = { file: '/ext/txt2img.api.json', inputs: SHIPPED_WORKFLOW_INPUTS };

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'comfyui-agent-'));
    cwd = mkdtempSync(join(tmpdir(), 'comfyui-cwd-'));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const writeProject = (config: unknown): void => {
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'comfyui.json'), JSON.stringify(config));
  };
  const writeUser = (config: unknown): void => {
    writeFileSync(join(agentDir, 'comfyui.json'), JSON.stringify(config));
  };

  test('with no config files, returns defaults plus the shipped workflow', () => {
    const config = loadComfyuiConfig(cwd, shipped);
    expect(config.baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
    expect(config.workflows.txt2img).toEqual(shipped);
    expect(loadUserWorkflowNames(cwd)).toEqual([]);
  });

  test('project config layers over user config over the shipped default', () => {
    writeUser({ baseUrl: 'http://user:8188', workflows: { userwf: { file: 'u.json', inputs: {} } } });
    writeProject({ baseUrl: 'http://project:8188', workflows: { projwf: { file: 'p.json', inputs: {} } } });
    const config = loadComfyuiConfig(cwd, shipped);
    expect(config.baseUrl).toBe('http://project:8188');
    expect(Object.keys(config.workflows).sort()).toEqual(['projwf', 'txt2img', 'userwf']);
  });

  test('loadUserWorkflowNames ignores the shipped default and lists user + project names', () => {
    writeUser({ workflows: { userwf: { file: 'u.json', inputs: {} } } });
    writeProject({ workflows: { projwf: { file: 'p.json', inputs: {} } } });
    expect(loadUserWorkflowNames(cwd).sort()).toEqual(['projwf', 'userwf']);
  });

  test('malformed config files degrade to no user workflows', () => {
    writeFileSync(join(agentDir, 'comfyui.json'), '{ not json');
    expect(loadUserWorkflowNames(cwd)).toEqual([]);
    expect(loadComfyuiConfig(cwd, shipped).workflows.txt2img).toEqual(shipped);
  });
});
