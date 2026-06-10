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
import { loadWorkflowGraph, validateMapping } from '../../../../../lib/node/pi/comfyui/workflow.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const comfyuiDir = join(repoRoot, 'config/pi/comfyui');

const SHIPPED: Record<string, Record<string, InputMapping>> = {
  'txt2img.api.json': SHIPPED_WORKFLOW_INPUTS,
  'img2img.api.json': {
    prompt: { node: '6', key: 'text' },
    negative: { node: '7', key: 'text' },
    image: { node: '10', key: 'image' },
    denoise: { node: '3', key: 'denoise' },
    seed: { node: '3', key: 'seed' },
    steps: { node: '3', key: 'steps' },
    cfg: { node: '3', key: 'cfg' },
  },
  'qwen-image-edit.api.json': {
    prompt: { node: '6', key: 'prompt' },
    image: { node: '41', key: 'image' },
    denoise: { node: '3', key: 'denoise' },
    seed: { node: '3', key: 'seed' },
    steps: { node: '3', key: 'steps' },
  },
};

describe('shipped comfyui example graphs', () => {
  for (const [file, mapping] of Object.entries(SHIPPED)) {
    test(`${file} is a valid graph whose documented input map resolves`, () => {
      const { graph, error } = loadWorkflowGraph(join(comfyuiDir, file), repoRoot, homedir());
      expect(error).toBeUndefined();
      if (graph === undefined) throw new Error('graph should be defined');

      // Every mapped node exists.
      expect(validateMapping(graph, mapping)).toEqual([]);

      // Every mapped input key is actually present on its node.
      for (const [name, target] of Object.entries(mapping)) {
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
