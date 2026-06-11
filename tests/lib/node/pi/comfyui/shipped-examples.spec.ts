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
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { SHIPPED_WORKFLOW_INPUTS } from '../../../../../lib/node/pi/comfyui/config.ts';
import type { InputMapping } from '../../../../../lib/node/pi/comfyui/types.ts';
import {
  loadWorkflowGraph,
  validateImageMappings,
  validateMapping,
} from '../../../../../lib/node/pi/comfyui/workflow.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const comfyuiDir = join(repoRoot, 'config/pi/comfyui');

interface ShippedMap {
  inputs: Record<string, InputMapping>;
  images?: InputMapping[];
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

const SHIPPED: Record<string, ShippedMap> = {
  'txt2img.api.json': { inputs: SHIPPED_WORKFLOW_INPUTS },
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
  'flux-kontext.api.json': {
    inputs: {
      prompt: { node: '6', key: 'text' },
      cfg: { node: '35', key: 'guidance' },
      seed: { node: '3', key: 'seed' },
      steps: { node: '3', key: 'steps' },
    },
    images: [{ node: '41', key: 'image' }],
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
  for (const [file, { inputs, images }] of Object.entries(SHIPPED)) {
    test(`${file} is a valid graph whose documented input map resolves`, () => {
      const { graph, error } = loadWorkflowGraph(join(comfyuiDir, file), repoRoot, homedir());
      expect(error).toBeUndefined();
      if (graph === undefined) throw new Error('graph should be defined');

      // Every mapped node (scalars + image slots) exists.
      expect(validateMapping(graph, inputs)).toEqual([]);
      expect(validateImageMappings(graph, images ?? [])).toEqual([]);

      // Every mapped input key is actually present on its node.
      const targets: [string, InputMapping][] = [
        ...Object.entries(inputs),
        ...(images ?? []).map((m, i): [string, InputMapping] => [`image ${i + 1}`, m]),
      ];
      for (const [name, target] of targets) {
        const node = graph[target.node];
        expect(node, `${name} -> node ${target.node}`).toBeDefined();
        expect(
          Object.prototype.hasOwnProperty.call(node.inputs, target.key),
          `${name} -> node ${target.node}.${target.key}`,
        ).toBe(true);
      }
    });
  }
});
