/** Exercise the real executor, local files, registry and collection with network stubs. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../../../../../../lib/node/pi/comfyui/config.ts';
import { formatGenerationDetail, reduceGenerations } from '../../../../../../lib/node/pi/comfyui/generations.ts';
import type { ComfyuiConfig, ComfyWorkflow } from '../../../../../../lib/node/pi/comfyui/types.ts';
import { executeGenerate } from '../../../../../../lib/node/pi/ext/comfyui/generate.ts';
import type { EnhancerAccess } from '../../../../../../lib/node/pi/ext/comfyui/enhancer.ts';
import { actCancel, actCollect } from '../../../../../../lib/node/pi/ext/comfyui/jobs.ts';
import type { RefinerAccess } from '../../../../../../lib/node/pi/ext/comfyui/refiner.ts';
import { renderGenerateResult } from '../../../../../../lib/node/pi/ext/comfyui/render.ts';
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
  rt.liveCards.reset(false);
  rt.stopPollTimer();
  vi.useRealTimers();
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

describe('original background TUI cards', () => {
  const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
  function row(): {
    toolCallId: string;
    state: object;
    executionStarted: boolean;
    isPartial: boolean;
    invalidate: ReturnType<typeof vi.fn<() => void>>;
  } {
    return { toolCallId: 'call1', state: {}, executionStarted: false, isPartial: false, invalidate: vi.fn() };
  }
  function start(): ReturnType<typeof row> {
    ctx = {
      ...ctx,
      mode: 'tui',
      sessionManager: { getBranch: () => [] },
      ui: { notify, setStatus: vi.fn() },
    } as unknown as ExtensionContext;
    rt.onSessionStart(ctx);
    const context = row();
    rt.liveCards.capture(context);
    return context;
  }
  function liveGenerate(params: GenerateParams, access: RefinerAccess = refiner): ReturnType<typeof executeGenerate> {
    return executeGenerate(rt, enhancer, access, 'call1', params, undefined, undefined, ctx, { liveCard: true });
  }
  function visible(
    result: Awaited<ReturnType<typeof generate>>,
    context: ReturnType<typeof row>,
    expanded = false,
  ): string {
    return renderGenerateResult(result, { expanded }, theme, context, rt.liveCards.read(context))
      .render(500)
      .join('\n');
  }

  test('updates after return, downloads all media, freezes terminal paths without altering the result', async () => {
    const context = start();
    config.autoDownload = true;
    extraMedia = true;
    const result = await liveGenerate({ workflowFile: file, background: true });
    const original = JSON.stringify(result);
    expect(visible(result, context)).toContain('background [1]');
    await vi.waitFor(() => expect(rt.registry.jobs[0].promptId).toBe('p1'));
    rt.stopPollTimer();
    expect(visible(result, context)).toContain('running');
    const poll = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/view') await gate;
      return poll(url, init);
    });
    const downloading = rt.autoDownloadTick();
    expect(visible(result, context)).toContain('checking / downloading');
    release();
    await downloading;
    expect(context.invalidate).toHaveBeenCalled();
    expect(visible(result, context)).toContain('done');
    expect(visible(result, context)).toContain('1 image and 1 video and 1 audio file');
    const final = visible(result, context, true);
    expect(final).toContain('saved:');
    expect(final).toContain(rt.registry.jobs[0].savedPaths[0]);
    expect(JSON.stringify(result)).toBe(original);
    expect(result.content.every((part) => part.type === 'text')).toBe(true);
    expect(result.details.savedPaths).toEqual([]);
    // The terminal projection survives disposal, but an export with the same id does not acquire it.
    rt.registry.jobs = [];
    expect(visible(result, context, true)).toBe(final);
    expect(visible(result, row())).toContain('▶ background [1]');
    expect(rt.liveCards.read(row())).toBeUndefined();
  });

  test('preparation and cancellation are live while returned details remain unchanged', async () => {
    const context = start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const access: EnhancerAccess = {
      isAgentInstalled: () => true,
      getEnhancer: () => ({
        isEnabled: () => true,
        enhance: async () => {
          await gate;
          return null;
        },
      }),
    };
    config.defaults = undefined;
    const result = await executeGenerate(
      rt,
      access,
      refiner,
      'call1',
      { workflow: 'named', prompt: 'a cat', background: true },
      undefined,
      undefined,
      ctx,
      { liveCard: true },
    );
    const original = JSON.stringify(result);
    expect(visible(result, context)).toContain('queued');
    expect(visible(result, context)).toContain('enhancing prompt');
    await actCancel(rt, result.details.jobId, ctx, undefined);
    expect(visible(result, context)).toContain('cancelled');
    release();
    // Allow the cancelled submit's best-effort cancellation to drain against stubs.
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(JSON.stringify(result)).toBe(original);
    expect(rt.registry.jobs[0].status).toBe('cancelled');
  });

  test('submission errors flush and freeze the original card', async () => {
    const context = start();
    submitError = 'unknown node type';
    const result = await liveGenerate({ workflowFile: file, background: true });
    const original = JSON.stringify(result);
    visible(result, context);
    await vi.waitFor(() => expect(rt.registry.jobs[0].status).toBe('error'));
    expect(visible(result, context)).toContain('error');
    expect(visible(result, context)).toContain('unknown node type');
    expect(JSON.stringify(result)).toBe(original);
  });

  test('managed refinement reports rounds and freezes the final best saved path', async () => {
    const context = start();
    config.defaults = undefined;
    config.enhance = false;
    config.workflows.named.inputs.batch = { node: '2', key: 'batch_size' };
    let critiques = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const access: RefinerAccess = {
      isAgentInstalled: () => true,
      getRefiner: () => ({
        isEnabled: () => true,
        critique: async () => {
          critiques++;
          if (critiques === 1)
            return { verdict: 'revise', score: 4, assessment: '', issues: [], action: { type: 'reroll' } };
          await gate;
          return { verdict: 'accept', score: 9, assessment: '', issues: [] };
        },
      }),
    };
    const result = await liveGenerate({ workflow: 'named', prompt: 'a cat', background: true }, access);
    const original = JSON.stringify(result);
    visible(result, context);
    await vi.waitFor(() => expect(critiques).toBe(2));
    expect(visible(result, context)).toContain('refining 1/');
    release();
    await vi.waitFor(() => expect(rt.registry.jobs[0].status).toBe('done'));
    expect(visible(result, context, true)).toContain('refine:');
    expect(visible(result, context, true)).toContain(rt.registry.jobs[0].savedPaths[0]);
    expect(JSON.stringify(result)).toBe(original);
  });

  test('manual collection updates a pull-only original card without changing its submission snapshot', async () => {
    const context = start();
    const result = await liveGenerate({ workflowFile: file, background: true });
    const original = JSON.stringify(result);
    await vi.waitFor(() => expect(rt.registry.jobs[0].promptId).toBe('p1'));
    expect(visible(result, context)).toContain('waiting for collect');
    await actCollect(rt, result.details.jobId, ctx, undefined);
    expect(visible(result, context)).toContain('done');
    expect(JSON.stringify(result)).toBe(original);
  });

  test('one UI timer refreshes elapsed time; tree/start/shutdown discard ownership', async () => {
    const context = start();
    const result = await liveGenerate({ workflowFile: file, background: true });
    const second = { ...row(), toolCallId: 'call2' };
    rt.liveCards.capture(second);
    const result2 = await executeGenerate(
      rt,
      enhancer,
      refiner,
      'call2',
      { workflowFile: file, background: true },
      undefined,
      undefined,
      ctx,
      { liveCard: true },
    );
    await vi.waitFor(() => expect(rt.registry.jobs[1].promptId).toBe('p2'));
    vi.useFakeTimers();
    expect(visible(result, context)).toContain('running');
    expect(visible(result2, second)).toContain('running');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(context.invalidate).toHaveBeenCalledTimes(3);
    expect(second.invalidate).toHaveBeenCalledTimes(3);
    rt.onSessionTree(ctx);
    expect(vi.getTimerCount()).toBe(0);
    expect(rt.liveCards.read(context)).toBeUndefined();
    rt.onSessionStart(ctx);
    expect(rt.liveCards.read(context)).toBeUndefined();
    rt.onShutdown(ctx);
    rt.onShutdown(ctx);
    expect(vi.getTimerCount()).toBe(0);
    expect(rt.registry.jobs).toEqual([]);
  });

  test('shutdown stops an active card before releasing UI resources', async () => {
    const context = start();
    const result = await liveGenerate({ workflowFile: file, background: true });
    await vi.waitFor(() => expect(rt.registry.jobs[0].promptId).toBe('p1'));
    vi.useFakeTimers();
    visible(result, context);
    expect(vi.getTimerCount()).toBe(1);
    const setStatus = vi.fn(() => {
      expect(vi.getTimerCount()).toBe(0);
      expect(rt.liveCards.read(context)).toBeUndefined();
    });
    ctx.ui.setStatus = setStatus;
    rt.onShutdown({ ...ctx, hasUI: true });
    expect(setStatus).toHaveBeenCalledWith('comfyui', undefined);
    vi.advanceTimersByTime(1000);
    expect(context.invalidate).not.toHaveBeenCalled();
    expect(rt.liveCards.read(context)).toBeUndefined();
  });

  test.each(['rpc', 'print', 'json'] as const)('does not attach %s executions', async (mode) => {
    const context = start();
    ctx = { ...ctx, mode };
    rt.onSessionStart(ctx);
    rt.liveCards.capture(context);
    await liveGenerate({ workflowFile: file, background: true });
    await vi.waitFor(() => expect(rt.registry.jobs[0].promptId).toBe('p1'));
    expect(rt.liveCards.read(context)).toBeUndefined();
  });

  test('a facade using the same id cannot bind a captured generate_image row', async () => {
    const context = start();
    const result = await generate({ workflowFile: file, background: true });
    await vi.waitFor(() => expect(rt.registry.jobs[0].promptId).toBe('p1'));
    expect(rt.liveCards.read(context)).toBeUndefined();
    expect(visible(result, context)).toContain('▶ background [1]');
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
