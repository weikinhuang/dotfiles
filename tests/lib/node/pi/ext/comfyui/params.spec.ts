/**
 * Tests for lib/node/pi/ext/comfyui/params.ts - the capability-driven
 * pruning of the `generate_image` schema. Drives `buildGenerateParams`
 * through the real `workflowCapabilities`, then asserts which params
 * survive on the built TypeBox object (`.properties`).
 */

import { describe, expect, test } from 'vitest';

import { workflowCapabilities } from '../../../../../../lib/node/pi/comfyui/describe.ts';
import type { ComfyuiConfig, WorkflowConfig } from '../../../../../../lib/node/pi/comfyui/types.ts';
import { buildGenerateParams } from '../../../../../../lib/node/pi/ext/comfyui/params.ts';

function mkConfig(workflows: Record<string, WorkflowConfig>, overrides: Partial<ComfyuiConfig> = {}): ComfyuiConfig {
  return {
    baseUrl: 'http://127.0.0.1:8188',
    timeoutMs: 1000,
    saveDir: 'out',
    defaultWorkflow: Object.keys(workflows)[0] ?? 'txt2img',
    sendToModel: true,
    ephemeral: false,
    background: false,
    autoDownload: true,
    pollIntervalMs: 1000,
    enhance: false,
    workflows,
    ...overrides,
  };
}

/** Sorted property keys of a built schema. */
function keys(config: ComfyuiConfig, caps: ReturnType<typeof workflowCapabilities>, enhance: boolean): string[] {
  const schema = buildGenerateParams(config, caps, enhance);
  return Object.keys(schema.properties).sort();
}

// Workflow mapping every tunable scalar/text param + both dimensions.
const FULL_SCALARS: WorkflowConfig = {
  file: 'full.json',
  inputs: {
    prompt: { node: '1', key: 'text' },
    negative: { node: '2', key: 'text' },
    seed: { node: '3', key: 'seed' },
    steps: { node: '3', key: 'steps' },
    cfg: { node: '3', key: 'cfg' },
    denoise: { node: '3', key: 'denoise' },
    width: { node: '4', key: 'w' },
    height: { node: '4', key: 'h' },
    batch: { node: '5', key: 'batch_size' },
  },
};

describe('buildGenerateParams', () => {
  test('full capability matrix keeps every param (mask union present)', () => {
    const workflows: Record<string, WorkflowConfig> = {
      full: FULL_SCALARS,
      edit: { file: 'e.json', inputs: { prompt: { node: '1', key: 'text' } }, images: [{ node: '9', key: 'image' }] },
      inpaint: {
        file: 'i.json',
        inputs: { prompt: { node: '1', key: 'text' } },
        images: { init: { node: '9', key: 'image' }, mask: { node: '8', key: 'image', kind: 'mask' } },
      },
    };
    const config = mkConfig(workflows);
    const caps = workflowCapabilities(workflows);
    expect(keys(config, caps, true)).toEqual(
      [
        'aspect',
        'background',
        'cfg',
        'context',
        'count',
        'denoise',
        'enhance',
        'ephemeral',
        'height',
        'images',
        'inputImages',
        'negative',
        'previewMaxDimension',
        'prompt',
        'refine',
        'seed',
        'sendToModel',
        'steps',
        'variationOf',
        'width',
        'workflow',
      ].sort(),
    );
    // The mask role keeps the bbox synth spec in the `images` value union.
    const schema = buildGenerateParams(config, caps, true);
    expect(JSON.stringify(schema.properties.images)).toContain('bbox');
  });

  test('pure text-to-image setup prunes to the ungated params only', () => {
    const workflows: Record<string, WorkflowConfig> = {
      t2i: { file: 't.json', inputs: { prompt: { node: '1', key: 'text' } } },
    };
    const config = mkConfig(workflows);
    const caps = workflowCapabilities(workflows);
    // Dropped: negative/width/height/steps/cfg/seed/denoise/count (not mapped),
    // aspect (no dims), refine (no image input), inputImages/images (no image
    // slots), enhance/context (enhancer unavailable).
    expect(keys(config, caps, false)).toEqual(
      ['background', 'ephemeral', 'previewMaxDimension', 'prompt', 'sendToModel', 'variationOf', 'workflow'].sort(),
    );
  });

  test('enhance + context appear only when the enhancer is available at registration', () => {
    const workflows: Record<string, WorkflowConfig> = {
      t2i: { file: 't.json', inputs: { prompt: { node: '1', key: 'text' } } },
    };
    const config = mkConfig(workflows);
    const caps = workflowCapabilities(workflows);
    expect(keys(config, caps, false)).not.toContain('enhance');
    expect(keys(config, caps, false)).not.toContain('context');
    expect(keys(config, caps, true)).toContain('enhance');
    expect(keys(config, caps, true)).toContain('context');
  });

  test('role workflow without a mask slot drops the bbox union but keeps images + refine', () => {
    const workflows: Record<string, WorkflowConfig> = {
      img2img: {
        file: 'r.json',
        inputs: { prompt: { node: '1', key: 'text' } },
        images: { init: { node: '9', key: 'image' } },
      },
    };
    const config = mkConfig(workflows);
    const caps = workflowCapabilities(workflows);
    const built = keys(config, caps, false);
    expect(built).toContain('images');
    expect(built).toContain('refine'); // role map implies imageInput
    expect(built).not.toContain('inputImages'); // role map, not positional
    const schema = buildGenerateParams(config, caps, false);
    expect(JSON.stringify(schema.properties.images)).not.toContain('bbox');
  });

  test('config defaults + workflow list are layered onto the schema', () => {
    const workflows: Record<string, WorkflowConfig> = {
      anima: { file: 'a.json', inputs: { prompt: { node: '1', key: 'text' } } },
      sketch: { file: 's.json', inputs: { prompt: { node: '1', key: 'text' } } },
    };
    const config = mkConfig(workflows, {
      defaultWorkflow: 'anima',
      sendToModel: false,
      ephemeral: true,
      background: true,
    });
    const caps = workflowCapabilities(workflows);
    const schema = buildGenerateParams(config, caps, false);
    expect((schema.properties.sendToModel as { default?: boolean }).default).toBe(false);
    expect((schema.properties.ephemeral as { default?: boolean }).default).toBe(true);
    expect((schema.properties.background as { default?: boolean }).default).toBe(true);
    expect((schema.properties.workflow as { description?: string }).description).toBe(
      'One of: anima, sketch. Default anima.',
    );
  });
});
