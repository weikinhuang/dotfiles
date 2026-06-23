/**
 * Tests for lib/node/pi/comfyui/describe.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  commonParams,
  describeWorkflow,
  describeWorkflows,
  imageRoleNames,
  recommendsEnhance,
  supportedParams,
  workflowCapabilities,
} from '../../../../../lib/node/pi/comfyui/describe.ts';
import type { WorkflowConfig } from '../../../../../lib/node/pi/comfyui/types.ts';

describe('supportedParams', () => {
  test('lists mapped params with batch renamed to count', () => {
    const wf: WorkflowConfig = {
      file: 'x.json',
      inputs: {
        prompt: { node: '6', key: 'text' },
        seed: { node: '3', key: 'seed' },
        batch: { node: '5', key: 'batch_size' },
      },
    };
    expect(supportedParams(wf)).toEqual(['prompt', 'seed', 'count']);
  });

  test('appends inputImages when positional image slots exist', () => {
    const wf: WorkflowConfig = {
      file: 'e.json',
      inputs: { prompt: { node: '4', key: 'text' } },
      images: [{ node: '20', key: 'image' }],
    };
    expect(supportedParams(wf)).toEqual(['prompt', 'inputImages']);
  });

  test('appends images (not inputImages) for a role map', () => {
    const wf: WorkflowConfig = {
      file: 'r.json',
      inputs: { prompt: { node: '4', key: 'text' } },
      images: { init: { node: '20', key: 'image' }, mask: { node: '21', key: 'image', kind: 'mask' } },
    };
    expect(supportedParams(wf)).toEqual(['prompt', 'images']);
  });
});

describe('imageRoleNames', () => {
  test('is empty for positional / text-to-image workflows', () => {
    expect(imageRoleNames({ file: 'x.json', inputs: {} })).toEqual([]);
    expect(imageRoleNames({ file: 'x.json', inputs: {}, images: [{ node: '1', key: 'image' }] })).toEqual([]);
  });

  test('lists roles and tags mask slots', () => {
    const wf: WorkflowConfig = {
      file: 'r.json',
      inputs: {},
      images: {
        init: { node: '20', key: 'image' },
        mask: { node: '21', key: 'image', kind: 'mask' },
        control: { node: '22', key: 'image' },
      },
    };
    expect(imageRoleNames(wf)).toEqual(['init', 'mask (mask)', 'control']);
  });
});

describe('recommendsEnhance', () => {
  test('false when protocol is undefined / empty / natural language', () => {
    expect(recommendsEnhance(undefined)).toBe(false);
    expect(recommendsEnhance('')).toBe(false);
    expect(recommendsEnhance('  ')).toBe(false);
    expect(recommendsEnhance('natural language')).toBe(false);
    expect(recommendsEnhance('Natural Language, one paragraph')).toBe(false);
  });

  test('true for a non-natural-language protocol', () => {
    expect(recommendsEnhance('Danbooru tags, comma-separated')).toBe(true);
    expect(recommendsEnhance('booru tags')).toBe(true);
  });
});

describe('describeWorkflow', () => {
  test('renders description, tags, params, slots, protocol, and gated enhance hint', () => {
    const wf: WorkflowConfig = {
      file: 'a.json',
      inputs: {
        prompt: { node: '6', key: 'text' },
        negative: { node: '7', key: 'text' },
        batch: { node: '5', key: 'batch_size' },
      },
      images: [{ node: '20', key: 'image' }],
      description: 'anime / illustration',
      tags: ['anime', 'sdxl'],
      promptProtocol: 'Danbooru tags, comma-separated',
    };
    const base =
      'anima: anime / illustration [anime, sdxl] | params: prompt, negative, count, inputImages | ' +
      '1 reference image | protocol: Danbooru tags, comma-separated';
    expect(describeWorkflow('anima', wf)).toBe(base);
    expect(describeWorkflow('anima', wf, { enhanceHint: true })).toBe(`${base} | recommends enhance`);
  });

  test('a bare text-to-image workflow stays short', () => {
    const wf: WorkflowConfig = {
      file: 't.json',
      inputs: { prompt: { node: '6', key: 'text' } },
    };
    expect(describeWorkflow('txt2img', wf)).toBe('txt2img | params: prompt');
  });

  test('pluralizes multiple reference images', () => {
    const wf: WorkflowConfig = {
      file: 'm.json',
      inputs: { prompt: { node: '4', key: 'text' } },
      images: [
        { node: '20', key: 'image' },
        { node: '30', key: 'image' },
      ],
    };
    expect(describeWorkflow('multi', wf)).toContain('2 reference images');
  });

  test('lists named roles instead of a reference-image count', () => {
    const wf: WorkflowConfig = {
      file: 'inpaint.json',
      inputs: { prompt: { node: '6', key: 'text' } },
      images: {
        init: { node: '20', key: 'image' },
        mask: { node: '21', key: 'image', kind: 'mask' },
      },
      description: 'inpaint',
    };
    expect(describeWorkflow('inpaint', wf)).toBe(
      'inpaint: inpaint | params: prompt, images | roles: init, mask (mask)',
    );
  });
});

describe('describeWorkflows', () => {
  test('factors common params into a header and shows per-workflow extras', () => {
    const workflows: Record<string, WorkflowConfig> = {
      txt2img: { file: 't.json', inputs: { prompt: { node: '6', key: 'text' } } },
      anima: { file: 'a.json', inputs: { prompt: { node: '6', key: 'text' } }, description: 'anime' },
    };
    const out = describeWorkflows(workflows, 'txt2img');
    expect(out).toBe('All workflows accept: prompt.\ntxt2img (default)\nanima: anime');
  });

  test('lists only the extras each workflow adds beyond the common set', () => {
    const workflows: Record<string, WorkflowConfig> = {
      base: {
        file: 'b.json',
        inputs: { prompt: { node: '6', key: 'text' }, seed: { node: '3', key: 'seed' } },
      },
      wide: {
        file: 'w.json',
        inputs: {
          prompt: { node: '6', key: 'text' },
          seed: { node: '3', key: 'seed' },
          width: { node: '5', key: 'w' },
          height: { node: '5', key: 'h' },
        },
      },
    };
    const out = describeWorkflows(workflows, 'base');
    expect(out).toBe('All workflows accept: prompt, seed.\nbase (default)\nwide | +width, height');
  });

  test('skips the header for a single workflow', () => {
    const workflows: Record<string, WorkflowConfig> = {
      only: { file: 'o.json', inputs: { prompt: { node: '6', key: 'text' } } },
    };
    expect(describeWorkflows(workflows, 'only')).toBe('only | params: prompt (default)');
  });

  test('neutral note when no workflows', () => {
    expect(describeWorkflows({}, 'txt2img')).toBe('(no workflows configured)');
  });
});

describe('commonParams', () => {
  test('intersects tunable params across workflows in first-workflow order', () => {
    const workflows: Record<string, WorkflowConfig> = {
      a: {
        file: 'a.json',
        inputs: { prompt: { node: '1', key: 't' }, seed: { node: '2', key: 's' }, batch: { node: '3', key: 'b' } },
      },
      b: { file: 'b.json', inputs: { seed: { node: '2', key: 's' }, prompt: { node: '1', key: 't' } } },
    };
    expect(commonParams(workflows)).toEqual(['prompt', 'seed']);
  });

  test('empty when no workflows', () => {
    expect(commonParams({})).toEqual([]);
  });
});

describe('workflowCapabilities', () => {
  test('aggregates params, dimensions, and image-input shapes', () => {
    const caps = workflowCapabilities({
      t2i: {
        file: 't.json',
        inputs: {
          prompt: { node: '1', key: 't' },
          width: { node: '2', key: 'w' },
          height: { node: '2', key: 'h' },
          batch: { node: '3', key: 'b' },
        },
      },
      edit: { file: 'e.json', inputs: { prompt: { node: '1', key: 't' } }, images: [{ node: '9', key: 'image' }] },
      inpaint: {
        file: 'i.json',
        inputs: { prompt: { node: '1', key: 't' } },
        images: { init: { node: '9', key: 'image' }, mask: { node: '8', key: 'image', kind: 'mask' } },
      },
    });
    expect([...caps.params].sort()).toEqual(['count', 'height', 'prompt', 'width']);
    expect(caps.dimensions).toBe(true);
    expect(caps.positionalImages).toBe(true);
    expect(caps.roleImages).toBe(true);
    expect(caps.maskRole).toBe(true);
    expect(caps.imageInput).toBe(true);
  });

  test('pure text-to-image setup reports no image / dimension capability', () => {
    const caps = workflowCapabilities({
      t2i: { file: 't.json', inputs: { prompt: { node: '1', key: 't' } } },
    });
    expect(caps.dimensions).toBe(false);
    expect(caps.positionalImages).toBe(false);
    expect(caps.roleImages).toBe(false);
    expect(caps.maskRole).toBe(false);
    expect(caps.imageInput).toBe(false);
  });
});
