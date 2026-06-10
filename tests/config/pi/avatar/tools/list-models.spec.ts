/**
 * Tests for config/pi/avatar/tools/list-models.ts pure helpers.
 *
 * Pure module - no network or pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import {
  extractModelList,
  extractModelLists,
  formatLists,
  parseArgs,
} from '../../../../../config/pi/avatar/tools/list-models.ts';

/** A trimmed-down /object_info shaped like ComfyUI's real payload. */
const OBJECT_INFO: Record<string, unknown> = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['sdxl-anime.safetensors', 'pony.safetensors'], {}] } },
  },
  UNETLoader: {
    input: { required: { unet_name: [['flux1-dev-kontext.safetensors'], { tooltip: 'x' }] } },
  },
  VAELoader: {
    input: { required: { vae_name: [['ae.safetensors']] } },
  },
  DualCLIPLoader: {
    input: { required: { clip_name1: [['clip_l.safetensors', 't5xxl.safetensors']] } },
  },
};

describe('extractModelList', () => {
  test('pulls the enum filename list from a loader input', () => {
    expect(
      extractModelList(OBJECT_INFO, { label: 'checkpoints', node: 'CheckpointLoaderSimple', input: 'ckpt_name' }),
    ).toEqual(['sdxl-anime.safetensors', 'pony.safetensors']);
  });

  test('handles an input spec with no trailing metadata object', () => {
    expect(extractModelList(OBJECT_INFO, { label: 'vae', node: 'VAELoader', input: 'vae_name' })).toEqual([
      'ae.safetensors',
    ]);
  });

  test('returns undefined for an absent node (uninstalled custom node)', () => {
    expect(
      extractModelList(OBJECT_INFO, { label: 'ipadapter', node: 'IPAdapterModelLoader', input: 'ipadapter_file' }),
    ).toBeUndefined();
  });
});

describe('extractModelLists', () => {
  test('collects only the categories present on the server', () => {
    const lists = extractModelLists(OBJECT_INFO);
    const labels = lists.map((l) => l.label);
    expect(labels).toEqual(['checkpoints', 'unet', 'vae', 'dual clip']);
    expect(lists.find((l) => l.label === 'dual clip')?.models).toEqual(['clip_l.safetensors', 't5xxl.safetensors']);
  });
});

describe('formatLists', () => {
  test('renders a header with node.input and a count per category', () => {
    const out = formatLists(extractModelLists(OBJECT_INFO));
    expect(out).toContain('checkpoints  (CheckpointLoaderSimple.ckpt_name) - 2');
    expect(out).toContain('  sdxl-anime.safetensors');
  });

  test('reports an empty result clearly', () => {
    expect(formatLists([])).toContain('No loader nodes with model lists found');
  });
});

describe('parseArgs', () => {
  test('defaults server from PI_COMFYUI_URL and JSON off', () => {
    const opts = parseArgs([], { PI_COMFYUI_URL: 'http://comfy.local:8188/' });
    expect(opts.server).toBe('http://comfy.local:8188');
    expect(opts.json).toBe(false);
  });

  test('--server and --json overrides, both flag forms', () => {
    expect(parseArgs(['--server=http://127.0.0.1:9999', '--json']).server).toBe('http://127.0.0.1:9999');
    expect(parseArgs(['--json']).json).toBe(true);
  });

  test('throws on unknown arguments', () => {
    expect(() => parseArgs(['--nope'])).toThrow('Unknown argument: --nope');
  });
});
