/** Exercise the real executor, local files, registry and collection with network stubs. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../../../../../../lib/node/pi/comfyui/config.ts';
import { formatGenerationDetail, reduceGenerations } from '../../../../../../lib/node/pi/comfyui/generations.ts';
import type { ComfyuiConfig, ComfyWorkflow } from '../../../../../../lib/node/pi/comfyui/types.ts';
import { executeGenerate } from '../../../../../../lib/node/pi/ext/comfyui/generate.ts';
import type { EnhancerAccess } from '../../../../../../lib/node/pi/ext/comfyui/enhancer.ts';
import { actCollect } from '../../../../../../lib/node/pi/ext/comfyui/jobs.ts';
import type { GenerateParams } from '../../../../../../lib/node/pi/ext/comfyui/params.ts';
import { runRefineCommand } from '../../../../../../lib/node/pi/ext/comfyui/refine-command.ts';
import { ComfyuiRuntime, GENERATIONS_CUSTOM_TYPE } from '../../../../../../lib/node/pi/ext/comfyui/runtime.ts';

const GRAPH = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'baked prompt' } },
  '2': { class_type: 'KSampler', inputs: { seed: 42, steps: 4, positive: ['1', 0] } },
} satisfies ComfyWorkflow;
const IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const enhancer = { getEnhancer: vi.fn(() => null), isAgentInstalled: () => true };
const refiner = { getRefiner: vi.fn(() => null), isAgentInstalled: () => true };
const notify = vi.fn();
let cwd: string;
let file: string;
let config: ComfyuiConfig;
let rt: ComfyuiRuntime;
let ctx: ExtensionContext;
let submitted: ComfyWorkflow[];
let submitError: string | undefined;
let extraMedia: boolean;

function generate(params: GenerateParams): ReturnType<typeof executeGenerate> {
  return executeGenerate(rt, enhancer, refiner, 'call1', params, undefined, undefined, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PI_COMFYUI_URL', '');
  vi.stubEnv('PI_COMFYUI_AUTH', '');
  cwd = mkdtempSync(join(tmpdir(), 'comfy-generate-'));
  file = join(cwd, 'graph.api.json');
  writeFileSync(file, JSON.stringify(GRAPH));
  config = {
    ...DEFAULT_CONFIG,
    baseUrl: 'http://comfy.test',
    saveDir: join(cwd, 'out'),
    timeoutMs: 2000,
    autoDownload: false,
    enhance: true,
    autoRefine: true,
    defaults: { width: 2048, height: 2048, steps: 99, cfg: 9, count: 3, negative: 'config negative' },
    workflows: { named: { file, inputs: { prompt: { node: '1', key: 'text' }, seed: { node: '2', key: 'seed' } } } },
  };
  rt = new ComfyuiRuntime({
    pi: { appendEntry: vi.fn(), events: { emit: vi.fn() } } as unknown as ExtensionAPI,
    loadConfig: () => config,
  });
  rt.cwd = cwd;
  ctx = {
    cwd,
    hasUI: false,
    model: { input: ['text', 'image'] },
    ui: { notify },
  } as unknown as ExtensionContext;
  submitted = [];
  submitError = undefined;
  extraMedia = false;
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor() {
        throw new Error('websocket disabled in test');
      }
    },
  );
  vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/prompt') {
      if (submitError) return Promise.resolve(new Response(submitError, { status: 400 }));
      if (typeof init?.body !== 'string') throw new Error('expected serialized JSON prompt');
      const body = JSON.parse(init.body) as { prompt: ComfyWorkflow };
      submitted.push(body.prompt);
      return Promise.resolve(Response.json({ prompt_id: `p${submitted.length}` }));
    }
    if (parsed.pathname.startsWith('/history/')) {
      const id = parsed.pathname.split('/').at(-1)!;
      return Promise.resolve(
        Response.json({
          [id]: {
            outputs: {
              '9': {
                images: [{ filename: 'preview.png', subfolder: '', type: 'output' }],
                ...(extraMedia
                  ? {
                      gifs: [{ filename: 'movie.mp4', type: 'output' }],
                      audio: [{ filename: 'sound.wav', type: 'output' }],
                    }
                  : {}),
              },
            },
          },
        }),
      );
    }
    if (parsed.pathname === '/view') return Promise.resolve(new Response(IMAGE));
    throw new Error(`unexpected network request: ${String(url)}`);
  });
});

afterEach(() => {
  rt.stopPollTimer();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

describe('workflowFile execution', () => {
  test('submits unchanged graph despite defaults/enhancement/refinement and returns a saved preview', async () => {
    const result = await generate({ workflowFile: './graph.api.json' });
    expect(result.isError).not.toBe(true);
    expect(submitted).toEqual([GRAPH]);
    expect(enhancer.getEnhancer).not.toHaveBeenCalled();
    expect(refiner.getRefiner).not.toHaveBeenCalled();
    expect(result.content.some((part) => part.type === 'image')).toBe(true);
    expect(readFileSync(result.details.savedPaths[0])).toEqual(IMAGE);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(GRAPH));
    expect(result.details.seed).toBeUndefined();
    const rec = rt.generations.generations[0];
    expect(rec).toMatchObject({ workflowFile: file, prompt: '', source: 'foreground' });
    expect(rec.width).toBeUndefined();
    expect(formatGenerationDetail(rec)).toContain('not inferred');
    expect(
      reduceGenerations(
        [{ type: 'custom', customType: GENERATIONS_CUSTOM_TYPE, data: rt.generations }],
        GENERATIONS_CUSTOM_TYPE,
      ).generations[0].workflowFile,
    ).toBe(file);
  });

  test('re-reads edits on the next call without registration or reload', async () => {
    await generate({ workflowFile: file });
    const changed = structuredClone(GRAPH);
    changed['2'].inputs.seed = 84;
    writeFileSync(file, JSON.stringify(changed));
    await generate({ workflowFile: file });
    expect(submitted).toEqual([GRAPH, changed]);
  });

  test.each([
    { prompt: 'override' },
    { workflow: 'named' },
    { variationOf: 'g1' },
    { inputImages: [] },
    { autoRefine: true },
  ])('rejects incompatible options before submission: %j', async (overrides) => {
    const result = await generate({ workflowFile: file, ...overrides });
    expect(result.isError).toBe(true);
    expect(result.details.error).toContain('incompatible options');
    expect(submitted).toEqual([]);
  });

  test('invalid and missing files fail before submission, including in background mode', async () => {
    writeFileSync(file, '{"nodes":[],"links":[]}');
    expect((await generate({ workflowFile: file, background: true })).isError).toBe(true);
    expect((await generate({ workflowFile: 'missing.json' })).details.error).toContain('not found');
    expect(submitted).toEqual([]);
    expect(rt.registry.jobs).toEqual([]);
  });

  test('save-only mode still saves all media and never attaches video/audio as images', async () => {
    extraMedia = true;
    const result = await generate({ workflowFile: file, sendToModel: false });
    expect(result.isError).not.toBe(true);
    expect(result.details.savedPaths).toHaveLength(3);
    expect(result.content.every((part) => part.type === 'text')).toBe(true);
    const visible = await generate({ workflowFile: file });
    expect(visible.content.filter((part) => part.type === 'image')).toHaveLength(1);
  });

  test('ephemeral mode still registers its collapse directive', async () => {
    const result = await generate({ workflowFile: file, ephemeral: true });
    expect(result.details.ephemeral).toBe(true);
    expect(result.content.some((part) => part.type === 'image')).toBe(true);
    expect(rt.generations.generations[0]).toMatchObject({ workflowFile: file, source: 'ephemeral' });
  });

  test.each([false, true])(
    'background collection preserves direct-file origin (autoDownload=%s)',
    async (autoDownload) => {
      config.autoDownload = autoDownload;
      const result = await generate({ workflowFile: file, background: true });
      rt.stopPollTimer();
      expect(result.details.background).toBe(true);
      await vi.waitFor(() => expect(rt.registry.jobs[0].promptId).toBe('p1'));
      rt.stopPollTimer();
      if (autoDownload) await rt.autoDownloadTick();
      const collected = await actCollect(rt, result.details.jobId, ctx, undefined);
      expect(collected.isError).not.toBe(true);
      expect(collected.details.status).toBe('done');
      expect(collected.content.some((part) => part.type === 'image')).toBe(true);
      expect(submitted).toEqual([GRAPH]);
      expect(rt.generations.generations).toHaveLength(1);
      expect(rt.generations.generations[0]).toMatchObject({ workflowFile: file, prompt: '', source: 'background' });
    },
  );

  test('surfaces foreground server validation errors', async () => {
    submitError = 'unknown node type';
    const result = await generate({ workflowFile: file });
    expect(result.isError).toBe(true);
    expect(result.details.error).toContain('unknown node type');
  });

  test('surfaces background server validation errors', async () => {
    submitError = 'unknown node type';
    const result = await generate({ workflowFile: file, background: true });
    await vi.waitFor(() => expect(rt.registry.jobs[0].status).toBe('error'));
    expect((await actCollect(rt, result.details.jobId, ctx, undefined)).details.error).toContain('unknown node type');
  });

  test('does not silently replay raw-file records through variationOf or standalone refinement', async () => {
    const rendered = await generate({ workflowFile: file });
    const id = rendered.details.generationId!;
    const varied = await generate({ variationOf: id, workflow: 'named', prompt: 'different' });
    expect(varied.details.error).toContain('cannot replay a workflowFile');
    await runRefineCommand(rt, refiner, id, ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('no input mappings'), 'warning');
    expect(submitted).toHaveLength(1);
  });
});

describe('required prompt writing for alternate interfaces', () => {
  test('missing writer fails before submission; full tool still falls back', async () => {
    const required = await executeGenerate(
      rt,
      enhancer,
      refiner,
      'rp-call',
      { workflow: 'named', prompt: '1girl, anime_style' },
      undefined,
      undefined,
      ctx,
      { requireEnhance: true },
    );
    expect(required.isError).toBe(true);
    expect(required.details.error).toContain('prompt writing failed');
    expect(submitted).toEqual([]);
    config.defaults = undefined;
    expect((await generate({ workflow: 'named', prompt: 'raw input' })).details.error).toBeUndefined();
    expect(submitted).toHaveLength(1);
  });
  test('failed writer never submits raw tags', async () => {
    const access: EnhancerAccess = {
      isAgentInstalled: () => true,
      getEnhancer: () => ({ isEnabled: () => true, enhance: () => Promise.resolve(null) }),
    };
    const result = await executeGenerate(
      rt,
      access,
      refiner,
      'rp-call',
      { workflow: 'named', prompt: '1girl' },
      undefined,
      undefined,
      ctx,
      { requireEnhance: true },
    );
    expect(result.isError).toBe(true);
    expect(submitted).toEqual([]);
  });
  test('NL writer gets isolated identities and collapse tracks the outer call id', async () => {
    let task = '';
    config.workflows.named.promptProtocol = 'Natural language';
    rt.recentScene = 'UNBOUNDED COMFY CONTEXT';
    rt.sceneBudget = 10000;
    const access: EnhancerAccess = {
      isAgentInstalled: () => true,
      getEnhancer: () => ({
        isEnabled: () => true,
        enhance: (_context, received) => {
          task = received;
          return Promise.resolve({
            prompt: 'An illustration of Mira with silver hair.',
            negative: 'unsupported negative',
          });
        },
      }),
    };
    const result = await executeGenerate(
      rt,
      access,
      refiner,
      'rp-call',
      {
        workflow: 'named',
        prompt: '1girl, silver_hair',
        context: 'Visual identity: Mira has silver hair.',
        ephemeral: true,
        autoRefine: false,
      },
      undefined,
      undefined,
      ctx,
      { requireEnhance: true, isolatedContext: true },
    );
    expect(result.details.error).toBeUndefined();
    expect(task).toContain('Natural language');
    expect(task).toContain('Illustration/anime style does not imply Danbooru tags');
    expect(task).toContain('Visual identity: Mira');
    expect(task).not.toContain('UNBOUNDED COMFY CONTEXT');
    expect(submitted[0]?.['1']?.inputs?.text).toBe('An illustration of Mira with silver hair.');
    expect(result.details.ephemeral).toBe(true);
    expect(rt.generations.generations[0].prompt).toBe('An illustration of Mira with silver hair.');
    expect(JSON.stringify(rt.ephemeral)).toContain('rp-call');
  });
});

describe('named workflow regression', () => {
  test('requires a prompt and still injects prompt/seed with variationOf reuse', async () => {
    config.enhance = false;
    config.autoRefine = false;
    config.defaults = undefined;
    expect((await generate({ workflow: 'named' })).details.error).toContain('prompt is required');
    const first = await generate({ workflow: 'named', prompt: 'new prompt', seed: 777 });
    expect(first.isError).not.toBe(true);
    expect(submitted[0]).toMatchObject({
      '1': { inputs: { text: 'new prompt' } },
      '2': { inputs: { seed: 777 } },
    });
    expect(rt.generations.generations[0].workflowFile).toBeUndefined();
    const second = await generate({ variationOf: first.details.generationId });
    expect(second.isError).not.toBe(true);
    expect(submitted[1]).toEqual(submitted[0]);
  });
});
