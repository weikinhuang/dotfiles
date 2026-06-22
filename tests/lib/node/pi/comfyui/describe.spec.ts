/**
 * Tests for lib/node/pi/comfyui/describe.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  describeWorkflow,
  describeWorkflows,
  recommendsEnhance,
  supportedParams,
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

  test('appends inputImages when image slots exist', () => {
    const wf: WorkflowConfig = {
      file: 'e.json',
      inputs: { prompt: { node: '4', key: 'text' } },
      images: [{ node: '20', key: 'image' }],
    };
    expect(supportedParams(wf)).toEqual(['prompt', 'inputImages']);
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
});

describe('describeWorkflows', () => {
  test('marks the default workflow and lists one line each', () => {
    const workflows: Record<string, WorkflowConfig> = {
      txt2img: { file: 't.json', inputs: { prompt: { node: '6', key: 'text' } } },
      anima: { file: 'a.json', inputs: { prompt: { node: '6', key: 'text' } }, description: 'anime' },
    };
    const out = describeWorkflows(workflows, 'txt2img');
    expect(out).toBe('txt2img | params: prompt (default)\nanima: anime | params: prompt');
  });

  test('neutral note when no workflows', () => {
    expect(describeWorkflows({}, 'txt2img')).toBe('(no workflows configured)');
  });
});
