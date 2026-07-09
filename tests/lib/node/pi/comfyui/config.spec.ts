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

  test('coerces the ephemeral boolean and drops a non-boolean', () => {
    expect(coerceConfigLayer({ ephemeral: true }).ephemeral).toBe(true);
    expect(coerceConfigLayer({ ephemeral: 'yes' }).ephemeral).toBeUndefined();
  });

  test('coerces the autoDownload boolean and drops a non-boolean', () => {
    expect(coerceConfigLayer({ autoDownload: false }).autoDownload).toBe(false);
    expect(coerceConfigLayer({ autoDownload: 'no' }).autoDownload).toBeUndefined();
  });

  test('coerces pollIntervalMs and clamps it to the floor', () => {
    expect(coerceConfigLayer({ pollIntervalMs: 5000 }).pollIntervalMs).toBe(5000);
    expect(coerceConfigLayer({ pollIntervalMs: 200 }).pollIntervalMs).toBe(1000);
    expect(coerceConfigLayer({ pollIntervalMs: 0 }).pollIntervalMs).toBeUndefined();
    expect(coerceConfigLayer({ pollIntervalMs: 'fast' }).pollIntervalMs).toBeUndefined();
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

  test('parses an images[] list and drops malformed entries', () => {
    const out = coerceConfigLayer({
      workflows: {
        edit: {
          file: '~/edit.json',
          inputs: { prompt: { node: '4', key: 'text' } },
          images: [
            { node: '20', key: 'image' },
            { node: '21', key: 'image' },
            { node: '', key: 'image' },
            { key: 'image' },
          ],
        },
      },
    });
    expect(out.workflows).toEqual({
      edit: {
        file: '~/edit.json',
        inputs: { prompt: { node: '4', key: 'text' } },
        images: [
          { node: '20', key: 'image' },
          { node: '21', key: 'image' },
        ],
      },
    });
  });

  test('omits images when absent or not a non-empty array', () => {
    const noImages = coerceConfigLayer({ workflows: { t2i: { file: '~/t2i.json', inputs: {} } } });
    expect(noImages.workflows?.t2i).toEqual({ file: '~/t2i.json', inputs: {} });
    const emptyImages = coerceConfigLayer({
      workflows: { t2i: { file: '~/t2i.json', inputs: {}, images: [{ node: '' }] } },
    });
    expect(emptyImages.workflows?.t2i).toEqual({ file: '~/t2i.json', inputs: {} });
  });

  test('parses a role-keyed images map with kind / invert', () => {
    const out = coerceConfigLayer({
      workflows: {
        inpaint: {
          file: '~/inpaint.json',
          inputs: { prompt: { node: '4', key: 'text' } },
          images: {
            init: { node: '20', key: 'image' },
            mask: { node: '21', key: 'image', kind: 'mask', invert: true },
            bogusKind: { node: '22', key: 'image', kind: 'nope' },
            dropped: { key: 'image' },
          },
        },
      },
    });
    expect(out.workflows?.inpaint).toEqual({
      file: '~/inpaint.json',
      inputs: { prompt: { node: '4', key: 'text' } },
      images: {
        init: { node: '20', key: 'image' },
        mask: { node: '21', key: 'image', kind: 'mask', invert: true },
        bogusKind: { node: '22', key: 'image' },
      },
    });
  });

  test('omits a role-keyed images map with no valid slots', () => {
    const out = coerceConfigLayer({
      workflows: { r: { file: '~/r.json', inputs: {}, images: { init: { key: 'image' } } } },
    });
    expect(out.workflows?.r).toEqual({ file: '~/r.json', inputs: {} });
  });

  test('parses description, tags, and promptProtocol metadata', () => {
    const out = coerceConfigLayer({
      workflows: {
        anima: {
          file: '~/anima.json',
          inputs: { prompt: { node: '6', key: 'text' } },
          description: 'anime / illustration',
          tags: ['anime', 'sdxl', '', 42],
          promptProtocol: 'Danbooru tags, comma-separated',
        },
      },
    });
    expect(out.workflows?.anima).toEqual({
      file: '~/anima.json',
      inputs: { prompt: { node: '6', key: 'text' } },
      description: 'anime / illustration',
      tags: ['anime', 'sdxl'],
      promptProtocol: 'Danbooru tags, comma-separated',
    });
  });

  test('parses a workflow guidanceFile', () => {
    const out = coerceConfigLayer({
      workflows: { anima: { file: '~/a.json', inputs: {}, guidanceFile: '~/guide.md' } },
    });
    expect(out.workflows?.anima).toEqual({ file: '~/a.json', inputs: {}, guidanceFile: '~/guide.md' });
  });

  test('parses a per-workflow enhance override (true/false), dropping non-booleans', () => {
    const on = coerceConfigLayer({ workflows: { a: { file: '~/a.json', inputs: {}, enhance: true } } });
    expect(on.workflows?.a).toEqual({ file: '~/a.json', inputs: {}, enhance: true });
    const off = coerceConfigLayer({ workflows: { a: { file: '~/a.json', inputs: {}, enhance: false } } });
    expect(off.workflows?.a.enhance).toBe(false);
    const bad = coerceConfigLayer({ workflows: { a: { file: '~/a.json', inputs: {}, enhance: 'yes' } } });
    expect(bad.workflows?.a.enhance).toBeUndefined();
  });

  test('parses a per-workflow refine override (true/false), dropping non-booleans', () => {
    const on = coerceConfigLayer({ workflows: { a: { file: '~/a.json', inputs: {}, refine: true } } });
    expect(on.workflows?.a).toEqual({ file: '~/a.json', inputs: {}, refine: true });
    const off = coerceConfigLayer({ workflows: { a: { file: '~/a.json', inputs: {}, refine: false } } });
    expect(off.workflows?.a.refine).toBe(false);
    const bad = coerceConfigLayer({ workflows: { a: { file: '~/a.json', inputs: {}, refine: 'yes' } } });
    expect(bad.workflows?.a.refine).toBeUndefined();
  });

  test('parses per-workflow refineGuidanceFile / refineCriteria, dropping empty / wrong-typed', () => {
    const ok = coerceConfigLayer({
      workflows: {
        a: {
          file: '~/a.json',
          inputs: {},
          refineGuidanceFile: '~/refine.md',
          refineCriteria: 'full body, facing left',
        },
      },
    });
    expect(ok.workflows?.a).toEqual({
      file: '~/a.json',
      inputs: {},
      refineGuidanceFile: '~/refine.md',
      refineCriteria: 'full body, facing left',
    });
    const bad = coerceConfigLayer({
      workflows: { a: { file: '~/a.json', inputs: {}, refineGuidanceFile: '', refineCriteria: 7 } },
    });
    expect(bad.workflows?.a).toEqual({ file: '~/a.json', inputs: {} });
  });

  test('parses a per-workflow refineWith companion map, dropping wrong-typed / empty channels', () => {
    const out = coerceConfigLayer({
      workflows: {
        anima: {
          file: '~/anima.json',
          inputs: {},
          refineWith: {
            img2img: 'anima-img2img',
            inpaint: 'anima-inpaint',
            detailer: 'anima-detailer',
            ground: 'anima-ground',
            bogus: 'ignored',
            empty: '',
            wrongType: 42,
          },
        },
      },
    });
    expect(out.workflows?.anima).toEqual({
      file: '~/anima.json',
      inputs: {},
      refineWith: {
        img2img: 'anima-img2img',
        inpaint: 'anima-inpaint',
        detailer: 'anima-detailer',
        ground: 'anima-ground',
      },
    });
  });

  test('omits a refineWith map with no valid channels', () => {
    const out = coerceConfigLayer({
      workflows: { a: { file: '~/a.json', inputs: {}, refineWith: { img2img: '', detailer: 5 } } },
    });
    expect(out.workflows?.a).toEqual({ file: '~/a.json', inputs: {} });
    const notObj = coerceConfigLayer({ workflows: { a: { file: '~/a.json', inputs: {}, refineWith: 'nope' } } });
    expect(notObj.workflows?.a).toEqual({ file: '~/a.json', inputs: {} });
  });

  test('parses enhancer knobs (enhance, enhanceModel, enhanceGuidanceFile)', () => {
    const out = coerceConfigLayer({
      enhance: true,
      enhanceModel: 'openai/gpt-4o-mini',
      enhanceGuidanceFile: '~/global-guide.md',
    });
    expect(out.enhance).toBe(true);
    expect(out.enhanceModel).toBe('openai/gpt-4o-mini');
    expect(out.enhanceGuidanceFile).toBe('~/global-guide.md');
  });

  test('parses refine knobs (autoRefine, refineModel, refineGuidanceFile)', () => {
    const out = coerceConfigLayer({
      autoRefine: true,
      refineModel: 'local/gemma-12b-vision',
      refineGuidanceFile: '~/global-refine.md',
    });
    expect(out.autoRefine).toBe(true);
    expect(out.refineModel).toBe('local/gemma-12b-vision');
    expect(out.refineGuidanceFile).toBe('~/global-refine.md');
  });

  test('parses refineTimeoutMs; drops non-positive', () => {
    expect(coerceConfigLayer({ refineTimeoutMs: 90000 }).refineTimeoutMs).toBe(90000);
    expect(coerceConfigLayer({ refineTimeoutMs: 0 }).refineTimeoutMs).toBeUndefined();
    expect(coerceConfigLayer({ refineTimeoutMs: 'slow' }).refineTimeoutMs).toBeUndefined();
  });

  test('coerces refineAcceptThreshold into [0, 10], falling back to 7 on an invalid value', () => {
    expect(coerceConfigLayer({ refineAcceptThreshold: 0 }).refineAcceptThreshold).toBe(0);
    expect(coerceConfigLayer({ refineAcceptThreshold: 8 }).refineAcceptThreshold).toBe(8);
    expect(coerceConfigLayer({ refineAcceptThreshold: 10 }).refineAcceptThreshold).toBe(10);
    expect(coerceConfigLayer({ refineAcceptThreshold: 11 }).refineAcceptThreshold).toBe(7);
    expect(coerceConfigLayer({ refineAcceptThreshold: 50 }).refineAcceptThreshold).toBe(7);
    expect(coerceConfigLayer({ refineAcceptThreshold: -1 }).refineAcceptThreshold).toBe(7);
    expect(coerceConfigLayer({ refineAcceptThreshold: '8' }).refineAcceptThreshold).toBe(7);
    expect(coerceConfigLayer({}).refineAcceptThreshold).toBeUndefined();
  });

  test('parses and rounds maxRefineIterations; drops non-positive', () => {
    expect(coerceConfigLayer({ maxRefineIterations: 3 }).maxRefineIterations).toBe(3);
    expect(coerceConfigLayer({ maxRefineIterations: 2.6 }).maxRefineIterations).toBe(3);
    expect(coerceConfigLayer({ maxRefineIterations: 0 }).maxRefineIterations).toBeUndefined();
    expect(coerceConfigLayer({ maxRefineIterations: -1 }).maxRefineIterations).toBeUndefined();
    expect(coerceConfigLayer({ maxRefineIterations: 'lots' }).maxRefineIterations).toBeUndefined();
  });

  test('drops empty / wrong-typed refine knobs', () => {
    const out = coerceConfigLayer({ autoRefine: 'yes', refineModel: '', refineGuidanceFile: 5 });
    expect(out.autoRefine).toBeUndefined();
    expect(out.refineModel).toBeUndefined();
    expect(out.refineGuidanceFile).toBeUndefined();
  });

  test('parses enhanceTimeoutMs; drops non-positive', () => {
    expect(coerceConfigLayer({ enhanceTimeoutMs: 60000 }).enhanceTimeoutMs).toBe(60000);
    expect(coerceConfigLayer({ enhanceTimeoutMs: 0 }).enhanceTimeoutMs).toBeUndefined();
    expect(coerceConfigLayer({ enhanceTimeoutMs: 'slow' }).enhanceTimeoutMs).toBeUndefined();
  });

  test('parses and rounds enhanceContextChars; drops non-positive (0 = off)', () => {
    expect(coerceConfigLayer({ enhanceContextChars: 1500 }).enhanceContextChars).toBe(1500);
    expect(coerceConfigLayer({ enhanceContextChars: 1499.6 }).enhanceContextChars).toBe(1500);
    expect(coerceConfigLayer({ enhanceContextChars: 0 }).enhanceContextChars).toBeUndefined();
    expect(coerceConfigLayer({ enhanceContextChars: 'lots' }).enhanceContextChars).toBeUndefined();
  });

  test('drops empty / wrong-typed enhancer knobs', () => {
    const out = coerceConfigLayer({ enhance: 'yes', enhanceModel: '', enhanceGuidanceFile: 5 });
    expect(out.enhance).toBeUndefined();
    expect(out.enhanceModel).toBeUndefined();
    expect(out.enhanceGuidanceFile).toBeUndefined();
  });

  test('parses and rounds previewMaxDimension; drops non-positive', () => {
    expect(coerceConfigLayer({ previewMaxDimension: 1024 }).previewMaxDimension).toBe(1024);
    expect(coerceConfigLayer({ previewMaxDimension: 1023.6 }).previewMaxDimension).toBe(1024);
    expect(coerceConfigLayer({ previewMaxDimension: 0 }).previewMaxDimension).toBeUndefined();
    expect(coerceConfigLayer({ previewMaxDimension: -512 }).previewMaxDimension).toBeUndefined();
    expect(coerceConfigLayer({ previewMaxDimension: 'big' }).previewMaxDimension).toBeUndefined();
  });

  test('drops empty / wrong-typed metadata fields', () => {
    const out = coerceConfigLayer({
      workflows: {
        t2i: {
          file: '~/t2i.json',
          inputs: {},
          description: '',
          tags: 'not-an-array',
          promptProtocol: 123,
        },
      },
    });
    expect(out.workflows?.t2i).toEqual({ file: '~/t2i.json', inputs: {} });
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

  test('ephemeral defaults to false and is overridable', () => {
    expect(mergeConfigLayers().ephemeral).toBe(false);
    expect(mergeConfigLayers({ ephemeral: true }).ephemeral).toBe(true);
  });

  test('autoDownload defaults to true and is overridable', () => {
    expect(mergeConfigLayers().autoDownload).toBe(true);
    expect(mergeConfigLayers({ autoDownload: false }).autoDownload).toBe(false);
  });

  test('pollIntervalMs defaults to 3000 and is overridable', () => {
    expect(mergeConfigLayers().pollIntervalMs).toBe(3000);
    expect(mergeConfigLayers({ pollIntervalMs: 5000 }).pollIntervalMs).toBe(5000);
  });

  test('refine knobs default and are overridable', () => {
    const defaults = mergeConfigLayers();
    expect(defaults.autoRefine).toBe(false);
    expect(defaults.refineTimeoutMs).toBe(120000);
    expect(defaults.maxRefineIterations).toBe(2);
    expect(defaults.refineAcceptThreshold).toBe(7);
    expect(defaults.refineModel).toBeUndefined();
    expect(defaults.refineGuidanceFile).toBeUndefined();

    const over = mergeConfigLayers(
      { autoRefine: true, maxRefineIterations: 1, refineTimeoutMs: 90000 },
      { refineAcceptThreshold: 8, refineModel: 'local/qwen-vl', refineGuidanceFile: '~/g.md' },
    );
    expect(over.autoRefine).toBe(true);
    expect(over.maxRefineIterations).toBe(1);
    expect(over.refineTimeoutMs).toBe(90000);
    expect(over.refineAcceptThreshold).toBe(8);
    expect(over.refineModel).toBe('local/qwen-vl');
    expect(over.refineGuidanceFile).toBe('~/g.md');
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

  test('per-workflow refineWith merges by name: replaced wholesale, others added', () => {
    const base = {
      workflows: {
        anima: { file: 'a.json', inputs: {}, refine: true, refineWith: { img2img: 'anima-img2img' } },
      },
    };
    const over = {
      workflows: {
        anima: { file: 'a.json', inputs: {}, refineWith: { inpaint: 'anima-inpaint', detailer: 'anima-detailer' } },
        flux: { file: 'f.json', inputs: {}, refineWith: { ground: 'flux-edit' } },
      },
    };
    const out = mergeConfigLayers(base, over);
    // The higher layer replaces the `anima` workflow wholesale, so its earlier
    // refineWith / refine fields are dropped, not field-merged.
    expect(out.workflows.anima).toEqual({
      file: 'a.json',
      inputs: {},
      refineWith: { inpaint: 'anima-inpaint', detailer: 'anima-detailer' },
    });
    expect(out.workflows.flux).toEqual({ file: 'f.json', inputs: {}, refineWith: { ground: 'flux-edit' } });
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

  test('loadUserWorkflowNames de-duplicates a name present in both layers', () => {
    // The same workflow id in the user and project layers is one workflow (the
    // project layer overrides), so the returned name list must not repeat it.
    writeUser({ workflows: { shared: { file: 'u.json', inputs: {} }, userwf: { file: 'u2.json', inputs: {} } } });
    writeProject({ workflows: { shared: { file: 'p.json', inputs: {} }, projwf: { file: 'p2.json', inputs: {} } } });
    const names = loadUserWorkflowNames(cwd);
    expect(names.filter((n) => n === 'shared')).toHaveLength(1);
    expect([...names].sort()).toEqual(['projwf', 'shared', 'userwf']);
  });

  test('malformed config files degrade to no user workflows', () => {
    writeFileSync(join(agentDir, 'comfyui.json'), '{ not json');
    expect(loadUserWorkflowNames(cwd)).toEqual([]);
    expect(loadComfyuiConfig(cwd, shipped).workflows.txt2img).toEqual(shipped);
  });

  test('config files accept // and /* */ comments and trailing commas (JSONC)', () => {
    writeFileSync(
      join(agentDir, 'comfyui.json'),
      [
        '{',
        '  // device-local override',
        '  "baseUrl": "http://user:8188",',
        '  "workflows": {',
        '    "userwf": { "file": "u.json", "inputs": {} }, /* trailing comma below */',
        '  },',
        '}',
      ].join('\n'),
    );
    const config = loadComfyuiConfig(cwd, shipped);
    expect(config.baseUrl).toBe('http://user:8188');
    expect(loadUserWorkflowNames(cwd)).toEqual(['userwf']);
  });
});
