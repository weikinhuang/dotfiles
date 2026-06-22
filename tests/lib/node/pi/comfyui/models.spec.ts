/**
 * Tests for lib/node/pi/comfyui/models.ts.
 */

import { describe, expect, test } from 'vitest';

import { extractModelCatalog, formatModelCatalog } from '../../../../../lib/node/pi/comfyui/models.ts';

describe('extractModelCatalog', () => {
  test('pulls enum lists from loader nodes, deduped and sorted', () => {
    const objectInfo = {
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [['sdxl.safetensors', 'anima.safetensors']] } },
      },
      CheckpointLoader: {
        input: { required: { ckpt_name: [['anima.safetensors', 'flux.safetensors']] } },
      },
      LoraLoader: { input: { required: { lora_name: [['detail.safetensors']] } } },
    };
    expect(extractModelCatalog(objectInfo)).toEqual({
      checkpoints: ['anima.safetensors', 'flux.safetensors', 'sdxl.safetensors'],
      loras: ['detail.safetensors'],
    });
  });

  test('omits categories whose loader node is absent or malformed', () => {
    const objectInfo = {
      VAELoader: { input: { required: { vae_name: 'not-an-array' } } },
      CheckpointLoaderSimple: { input: { required: {} } },
      UNETLoader: { input: { required: { unet_name: [[]] } } },
    };
    expect(extractModelCatalog(objectInfo)).toEqual({});
  });

  test('empty object yields empty catalog', () => {
    expect(extractModelCatalog({})).toEqual({});
  });
});

describe('formatModelCatalog', () => {
  test('renders categories with counts and indented items', () => {
    const out = formatModelCatalog({ checkpoints: ['a.safetensors', 'b.safetensors'], vae: ['v.pt'] });
    expect(out).toBe('checkpoints (2):\n  a.safetensors\n  b.safetensors\nvae (1):\n  v.pt');
  });

  test('neutral note when empty', () => {
    expect(formatModelCatalog({})).toBe('no known model lists found in /object_info');
  });
});
