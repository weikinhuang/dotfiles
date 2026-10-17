/**
 * Guards the shipped example workflow graphs under `config/pi/comfyui/`
 * against drift from their documented input maps. Each map entry must
 * resolve to a node that exists in the graph AND an input key present on
 * that node, so a graph edit that renames/removes a mapped node or key
 * is caught here instead of at generation time.
 *
 * The maps mirror what `comfyui.md` / `comfyui-example.json` document for
 * each example; `txt2img` reuses the canonical `SHIPPED_WORKFLOW_INPUTS`.
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { coerceConfigLayer, SHIPPED_WORKFLOW_INPUTS } from '../../../../../lib/node/pi/comfyui/config.ts';
import type { AutogrowImageSlots, AutogrowMediaSlots, InputMapping } from '../../../../../lib/node/pi/comfyui/types.ts';
import {
  injectAutogrowImageList,
  injectInputs,
  isAutogrowImageSlots,
  loadWorkflowGraph,
  validateAutogrowImageSlots,
  validateAutogrowMediaSlots,
  validateImageMappings,
  validateMapping,
} from '../../../../../lib/node/pi/comfyui/workflow.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const comfyuiDir = join(repoRoot, 'config/pi/comfyui');

interface ShippedMap {
  inputs: Record<string, InputMapping>;
  images?: InputMapping[] | AutogrowImageSlots;
  videos?: AutogrowMediaSlots;
  audios?: AutogrowMediaSlots;
}

const FLUX2_T2I_INPUTS: Record<string, InputMapping> = {
  prompt: { node: '4', key: 'text' },
  negative: { node: '5', key: 'text' },
  seed: { node: '12', key: 'noise_seed' },
  steps: { node: '8', key: 'steps' },
  cfg: { node: '10', key: 'cfg' },
  width: { node: '6', key: 'value' },
  height: { node: '7', key: 'value' },
  batch: { node: '9', key: 'batch_size' },
};

const FLUX2_EDIT_INPUTS: Record<string, InputMapping> = {
  prompt: { node: '4', key: 'text' },
  negative: { node: '5', key: 'text' },
  seed: { node: '12', key: 'noise_seed' },
  steps: { node: '8', key: 'steps' },
  cfg: { node: '10', key: 'cfg' },
  batch: { node: '9', key: 'batch_size' },
};

// MOSS-Image graphs share one layout: prompt/negative CLIPTextEncode 6/7,
// KSampler 12, EmptyFlux2LatentImage 9 (mirrors comfyui-example.json).
const MOSS_IMAGE_INPUTS: Record<string, InputMapping> = {
  prompt: { node: '6', key: 'text' },
  negative: { node: '7', key: 'text' },
  seed: { node: '12', key: 'seed' },
  steps: { node: '12', key: 'steps' },
  cfg: { node: '12', key: 'cfg' },
  width: { node: '9', key: 'width' },
  height: { node: '9', key: 'height' },
  batch: { node: '9', key: 'batch_size' },
};

const SHIPPED: Record<string, ShippedMap> = {
  'txt2img.api.json': { inputs: SHIPPED_WORKFLOW_INPUTS },
  'krea2-turbo.api.json': {
    inputs: {
      prompt: { node: '4', key: 'text' },
      seed: { node: '7', key: 'seed' },
      width: { node: '6', key: 'width' },
      height: { node: '6', key: 'height' },
      batch: { node: '6', key: 'batch_size' },
    },
  },
  'krea2-turbo-2gpu.api.json': {
    inputs: {
      prompt: { node: '4', key: 'text' },
      seed: { node: '7', key: 'seed' },
      width: { node: '6', key: 'width' },
      height: { node: '6', key: 'height' },
      batch: { node: '6', key: 'batch_size' },
    },
  },
  'moss-image-sft.api.json': { inputs: MOSS_IMAGE_INPUTS },
  'moss-image-sft-fast.api.json': { inputs: MOSS_IMAGE_INPUTS },
  'moss-image-sft-reference.api.json': { inputs: MOSS_IMAGE_INPUTS },
  'moss-image-base.api.json': { inputs: MOSS_IMAGE_INPUTS },
  'moss-image-base-fast.api.json': { inputs: MOSS_IMAGE_INPUTS },
  'moss-image-base-reference.api.json': { inputs: MOSS_IMAGE_INPUTS },
  'img2img.api.json': {
    inputs: {
      prompt: { node: '6', key: 'text' },
      negative: { node: '7', key: 'text' },
      denoise: { node: '3', key: 'denoise' },
      seed: { node: '3', key: 'seed' },
      steps: { node: '3', key: 'steps' },
      cfg: { node: '3', key: 'cfg' },
    },
    images: [{ node: '10', key: 'image' }],
  },
  'qwen-image-edit.api.json': {
    inputs: {
      prompt: { node: '6', key: 'prompt' },
      seed: { node: '3', key: 'seed' },
      steps: { node: '3', key: 'steps' },
    },
    images: [{ node: '41', key: 'image' }],
  },
  'qwen-image-edit-2.1.api.json': {
    inputs: {
      prompt: { node: '8', key: 'prompt' },
      negative: { node: '8', key: 'negative_prompt' },
      seed: { node: '9', key: 'seed' },
      steps: { node: '9', key: 'steps' },
      cfg: { node: '9', key: 'cfg' },
      width: { node: '12', key: 'width', alsoSet: [{ node: '13', key: 'switch', value: true }] },
      height: { node: '12', key: 'height', alsoSet: [{ node: '13', key: 'switch', value: true }] },
    },
    images: {
      mode: 'autogrow',
      loader: { node: '7', key: 'image', output: 0 },
      target: { node: '8', keyPrefix: 'images.image_' },
      min: 0,
      max: 16,
    },
  },
  'minimax-h3-fl2va-t2i.api.json': {
    inputs: {
      prompt: { node: '7', key: 'text' },
      seed: { node: '10', key: 'noise_seed' },
      steps: { node: '12', key: 'steps' },
      width: { node: '8', key: 'width' },
      height: { node: '8', key: 'height' },
    },
  },
  'minimax-h3-ref2va-edit.api.json': {
    inputs: {
      prompt: { node: '7', key: 'prompt' },
      seed: { node: '10', key: 'noise_seed' },
      steps: { node: '12', key: 'steps' },
      width: { node: '17', key: 'value' },
      height: { node: '18', key: 'value' },
      refImageSize: { node: '7', key: 'ref_image_size' },
    },
    images: {
      mode: 'autogrow',
      loader: { node: '16', key: 'image', output: 0 },
      target: { node: '7', keyPrefix: 'ref_images.ref_image_', indexBase: 0 },
      min: 1,
      max: 9,
    },
  },
  'minimax-h3-ref2va-spectrum.api.json': {
    inputs: {
      prompt: { node: '14', key: 'prompt' },
      seed: { node: '15', key: 'noise_seed' },
      steps: { node: '17', key: 'steps' },
      width: { node: '14', key: 'width' },
      height: { node: '14', key: 'height' },
      duration: { node: '14', key: 'length', transform: 'secondsToFrames24H3' },
      refImageSize: { node: '14', key: 'ref_image_size' },
    },
    images: {
      mode: 'autogrow',
      loader: { node: '10', key: 'image', output: 0 },
      target: { node: '14', keyPrefix: 'ref_images.ref_image_', indexBase: 0 },
      max: 9,
    },
    videos: {
      mode: 'autogrow',
      templates: ['11', '12'],
      loader: { node: '11', key: 'file' },
      outputs: [
        {
          source: { node: '12', output: 0 },
          target: { node: '14', keyPrefix: 'ref_videos.ref_video_', indexBase: 0 },
        },
        {
          source: { node: '12', output: 1 },
          target: { node: '14', keyPrefix: 'ref_video_audios.ref_video_audio_', indexBase: 0 },
        },
      ],
      max: 3,
    },
    audios: {
      mode: 'autogrow',
      templates: ['13'],
      loader: { node: '13', key: 'audio' },
      outputs: [
        {
          source: { node: '13', output: 0 },
          target: { node: '14', keyPrefix: 'ref_audios.ref_audio_', indexBase: 0 },
        },
      ],
      max: 3,
    },
  },
  'anima-inpaint.api.json': {
    inputs: {
      prompt: { node: '65', key: 'string' },
      negative: { node: '12', key: 'text' },
      seed: { node: '20', key: 'seed' },
      steps: { node: '20', key: 'steps' },
      cfg: { node: '20', key: 'cfg' },
      denoise: { node: '20', key: 'denoise' },
    },
    images: [
      { node: '16', key: 'image' },
      { node: '17', key: 'image' },
    ],
  },
  'flux2-t2i.api.json': { inputs: FLUX2_T2I_INPUTS },
  'flux2-t2i-fast.api.json': { inputs: FLUX2_T2I_INPUTS },
  'flux2-edit.api.json': { inputs: FLUX2_EDIT_INPUTS, images: [{ node: '20', key: 'image' }] },
  'flux2-edit-fast.api.json': { inputs: FLUX2_EDIT_INPUTS, images: [{ node: '20', key: 'image' }] },
  'flux2-edit-multi.api.json': {
    inputs: FLUX2_EDIT_INPUTS,
    images: [
      { node: '20', key: 'image' },
      { node: '30', key: 'image' },
    ],
  },
};

describe('shipped comfyui example graphs', () => {
  for (const [file, { inputs, images, videos, audios }] of Object.entries(SHIPPED)) {
    test(`${file} is a valid graph whose documented input map resolves`, () => {
      const { graph, error } = loadWorkflowGraph(join(comfyuiDir, file), repoRoot, homedir());
      expect(error).toBeUndefined();
      if (graph === undefined) throw new Error('graph should be defined');

      // Every mapped node (scalars + image slots) exists.
      expect(validateMapping(graph, inputs)).toEqual([]);
      const imageErrors = isAutogrowImageSlots(images)
        ? validateAutogrowImageSlots(graph, images)
        : validateImageMappings(graph, images ?? []);
      expect(imageErrors).toEqual([]);
      expect(videos === undefined ? [] : validateAutogrowMediaSlots(graph, videos, 'video')).toEqual([]);
      expect(audios === undefined ? [] : validateAutogrowMediaSlots(graph, audios, 'audio')).toEqual([]);

      // Every mapped input key is actually present on its node.
      const imageTargets: [string, InputMapping][] = isAutogrowImageSlots(images)
        ? [
            ['image loader', images.loader],
            [
              'image target',
              { node: images.target.node, key: `${images.target.keyPrefix}${images.target.indexBase ?? 1}` },
            ],
          ]
        : (images ?? []).map((m, i): [string, InputMapping] => [`image ${i + 1}`, m]);
      const targets: [string, InputMapping][] = [...Object.entries(inputs), ...imageTargets];
      for (const [name, target] of targets) {
        const node = graph[target.node];
        expect(node, `${name} -> node ${target.node}`).toBeDefined();
        expect(
          Object.prototype.hasOwnProperty.call(node.inputs, target.key),
          `${name} -> node ${target.node}.${target.key}`,
        ).toBe(true);
        for (const sideEffect of target.alsoSet ?? []) {
          const sideNode = graph[sideEffect.node];
          expect(sideNode, `${name} alsoSet -> node ${sideEffect.node}`).toBeDefined();
          expect(
            Object.prototype.hasOwnProperty.call(sideNode.inputs, sideEffect.key),
            `${name} alsoSet -> node ${sideEffect.node}.${sideEffect.key}`,
          ).toBe(true);
        }
      }
    });
  }

  test('Qwen Image 2.1 activates its custom latent only when dimensions are supplied', () => {
    const file = 'qwen-image-edit-2.1.api.json';
    const { graph, error } = loadWorkflowGraph(join(comfyuiDir, file), repoRoot, homedir());
    expect(error).toBeUndefined();
    if (graph === undefined) throw new Error('graph should be defined');

    const inputs = SHIPPED[file].inputs;
    const inherited = injectInputs(graph, inputs, { width: undefined, height: undefined });
    expect(inherited.errors).toEqual([]);
    expect(inherited.workflow['13'].inputs?.switch).toBe(false);
    expect(inherited.workflow['9'].inputs?.latent_image).toEqual(['13', 0]);

    const custom = injectInputs(graph, inputs, { width: 1280, height: 768 });
    expect(custom.errors).toEqual([]);
    expect(custom.workflow['12'].inputs).toMatchObject({ width: 1280, height: 768 });
    expect(custom.workflow['13'].inputs?.switch).toBe(true);
  });

  test.each(['minimax-h3-fl2va-t2i', 'minimax-h3-ref2va-edit'])(
    '%s is registered as a still workflow with matching maps and dual-GPU placement',
    (name) => {
      const file = `${name}.api.json`;
      const example = coerceConfigLayer(
        JSON.parse(readFileSync(join(repoRoot, 'config/pi/comfyui-example.json'), 'utf8')),
      );
      const registered = example.workflows?.[name];
      expect(registered?.inputs).toEqual(SHIPPED[file].inputs);
      expect(registered?.images).toEqual(SHIPPED[file].images);
      expect(registered?.outputType).toBe('image');
      for (const unsupported of ['cfg', 'negative', 'duration', 'batch']) {
        expect(registered?.inputs).not.toHaveProperty(unsupported);
      }
      const { graph, error } = loadWorkflowGraph(join(comfyuiDir, file), repoRoot, homedir());
      expect(error).toBeUndefined();
      if (graph === undefined) throw new Error('graph should be defined');
      expect(graph['4'].inputs?.device).toBe('gpu:1');
      expect(graph['6'].inputs?.device).toBe('gpu:1');
      expect(graph['8'].class_type).toBe('EmptyLatentImage');
      expect(graph['8'].inputs?.batch_size).toBe(1);
      expect(graph['13'].inputs?.latent_image).toEqual(['8', 0]);
      expect(graph['15'].class_type).toBe('SaveImage');
      expect(
        Object.values(graph).some((node) =>
          ['SaveVideo', 'CreateVideo', 'VAEDecodeAudio'].includes(node.class_type ?? ''),
        ),
      ).toBe(false);
    },
  );

  test('H3 still edit keeps injected dimensions synchronized and the video latent disconnected', () => {
    const file = 'minimax-h3-ref2va-edit.api.json';
    const { graph } = loadWorkflowGraph(join(comfyuiDir, file), repoRoot, homedir());
    if (graph === undefined) throw new Error('graph should be defined');
    const custom = injectInputs(graph, SHIPPED[file].inputs, {
      prompt: 'Edit <Picture 1> using the style of <Picture 2>.',
      width: 1280,
      height: 768,
      seed: 42,
      steps: 12,
      refImageSize: 'max',
    });
    expect(custom.errors).toEqual([]);
    expect(custom.workflow['17'].inputs?.value).toBe(1280);
    expect(custom.workflow['18'].inputs?.value).toBe(768);
    expect(custom.workflow['7'].inputs?.width).toEqual(custom.workflow['8'].inputs?.width);
    expect(custom.workflow['7'].inputs?.height).toEqual(custom.workflow['8'].inputs?.height);
    expect(custom.workflow['7'].inputs?.ref_image_size).toBe('max');
    expect(custom.workflow['7'].inputs?.length).toBe(5);
    expect(custom.workflow['10'].inputs?.noise_seed).toBe(42);
    expect(custom.workflow['12'].inputs?.steps).toBe(12);
    expect(Object.values(custom.workflow).flatMap((node) => Object.values(node.inputs ?? {}))).not.toContainEqual([
      '7',
      1,
    ]);
  });

  test('H3 still edit requires 1-9 references and rewrites zero-based autogrow links', () => {
    const file = 'minimax-h3-ref2va-edit.api.json';
    const { graph } = loadWorkflowGraph(join(comfyuiDir, file), repoRoot, homedir());
    const slots = SHIPPED[file].images;
    if (graph === undefined || !isAutogrowImageSlots(slots))
      throw new Error('graph and autogrow slots should be defined');
    expect(injectAutogrowImageList(graph, slots, []).errors).toEqual(['requires at least 1 reference image(s)']);
    expect(injectAutogrowImageList(graph, slots, ['target.png']).errors).toEqual([]);
    const two = injectAutogrowImageList(graph, slots, ['target.png', 'style.png']);
    expect(two.errors).toEqual([]);
    expect(two.workflow['16'].inputs?.image).toBe('target.png');
    expect(two.workflow['7'].inputs?.['ref_images.ref_image_0']).toEqual(['16', 0]);
    const second = two.workflow['7'].inputs?.['ref_images.ref_image_1'] as [string, number];
    expect(second[1]).toBe(0);
    expect(two.workflow[second[0]].inputs?.image).toBe('style.png');
    expect(
      injectAutogrowImageList(
        graph,
        slots,
        Array.from({ length: 9 }, (_, i) => `ref${i}.png`),
      ).errors,
    ).toEqual([]);
    expect(
      injectAutogrowImageList(
        graph,
        slots,
        Array.from({ length: 10 }, (_, i) => `ref${i}.png`),
      ).errors,
    ).toEqual(['accepts at most 9 reference image(s)']);
  });
});
