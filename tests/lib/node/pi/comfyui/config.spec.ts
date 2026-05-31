/**
 * Tests for lib/node/pi/comfyui/config.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  coerceConfigLayer,
  DEFAULT_CONFIG,
  interpolateEnv,
  mergeConfigLayers,
  resolveAuthHeaders,
  resolveBaseUrl,
  resolveSendToModel,
} from '../../../../../lib/node/pi/comfyui/config.ts';

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
