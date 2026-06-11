/**
 * Tests for lib/node/pi/comfyui/workflow.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { ComfyWorkflow } from '../../../../../lib/node/pi/comfyui/types.ts';
import {
  injectInputs,
  isComfyWorkflow,
  loadWorkflowGraph,
  randomSeed,
  validateMapping,
} from '../../../../../lib/node/pi/comfyui/workflow.ts';

function sampleWorkflow(): ComfyWorkflow {
  return {
    '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7 } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'old positive' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'old negative' } },
  };
}

const MAP = {
  prompt: { node: '6', key: 'text' },
  negative: { node: '7', key: 'text' },
  seed: { node: '3', key: 'seed' },
  width: { node: '5', key: 'width' },
};

describe('isComfyWorkflow', () => {
  test('accepts a graph of nodes with inputs objects', () => {
    expect(isComfyWorkflow(sampleWorkflow())).toBe(true);
  });

  test('rejects empty objects, arrays, and nodes without inputs', () => {
    expect(isComfyWorkflow({})).toBe(false);
    expect(isComfyWorkflow([])).toBe(false);
    expect(isComfyWorkflow(null)).toBe(false);
    expect(isComfyWorkflow({ '1': { class_type: 'X' } })).toBe(false);
  });
});

describe('injectInputs', () => {
  test('writes mapped params and leaves the original untouched', () => {
    const original = sampleWorkflow();
    const { workflow, errors } = injectInputs(original, MAP, {
      prompt: 'a cat',
      negative: 'blurry',
      seed: 42,
      width: 1024,
    });
    expect(errors).toEqual([]);
    expect(workflow['6'].inputs?.text).toBe('a cat');
    expect(workflow['7'].inputs?.text).toBe('blurry');
    expect(workflow['3'].inputs?.seed).toBe(42);
    expect(workflow['5'].inputs?.width).toBe(1024);
    // original is not mutated (deep clone)
    expect(original['6'].inputs?.text).toBe('old positive');
  });

  test('skips undefined params, keeping the baked-in values', () => {
    const { workflow, errors } = injectInputs(sampleWorkflow(), MAP, { prompt: 'x', seed: undefined });
    expect(errors).toEqual([]);
    expect(workflow['6'].inputs?.text).toBe('x');
    expect(workflow['3'].inputs?.seed).toBe(1);
  });

  test('records an error for an unmapped param', () => {
    const { errors } = injectInputs(sampleWorkflow(), MAP, { steps: 30 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('no input mapping for "steps"');
  });

  test('records an error when a mapped node is missing from the graph', () => {
    const badMap = { prompt: { node: '999', key: 'text' } };
    const { errors } = injectInputs(sampleWorkflow(), badMap, { prompt: 'x' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('node "999"');
  });
});

describe('validateMapping', () => {
  test('returns no errors when every mapped node exists', () => {
    expect(validateMapping(sampleWorkflow(), MAP)).toEqual([]);
  });

  test('flags each dangling mapping entry', () => {
    const map = { prompt: { node: '6', key: 'text' }, ghost: { node: '404', key: 'x' } };
    const errors = validateMapping(sampleWorkflow(), map);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ghost');
  });
});

describe('loadWorkflowGraph', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'comfyui-wf-spec-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('reads and validates an absolute workflow file', () => {
    const file = join(tmp, 'wf.json');
    writeFileSync(file, JSON.stringify(sampleWorkflow()));
    const loaded = loadWorkflowGraph(file, tmp, tmp);
    expect(loaded.error).toBeUndefined();
    expect(loaded.graph?.['6'].inputs?.text).toBe('old positive');
  });

  test('expands a leading ~ against the supplied homedir', () => {
    const file = join(tmp, 'home-wf.json');
    writeFileSync(file, JSON.stringify(sampleWorkflow()));
    const loaded = loadWorkflowGraph('~/home-wf.json', '/nowhere', tmp);
    expect(loaded.error).toBeUndefined();
    expect(loaded.graph).toBeDefined();
  });

  test('resolves a relative path against cwd, not homedir', () => {
    mkdirSync(join(tmp, 'local'), { recursive: true });
    writeFileSync(join(tmp, 'local', 'cwd.api.json'), JSON.stringify(sampleWorkflow()));
    const loaded = loadWorkflowGraph('./local/cwd.api.json', tmp, '/some/home');
    expect(loaded.error).toBeUndefined();
    expect(loaded.graph).toBeDefined();
  });

  test('errors when the file is missing', () => {
    const loaded = loadWorkflowGraph(join(tmp, 'nope.json'), tmp, tmp);
    expect(loaded.graph).toBeUndefined();
    expect(loaded.error).toContain('workflow file not found');
  });

  test('errors when the file is not a valid API-format graph', () => {
    const file = join(tmp, 'bad.json');
    writeFileSync(file, JSON.stringify({ '1': { class_type: 'X' } }));
    const loaded = loadWorkflowGraph(file, tmp, tmp);
    expect(loaded.graph).toBeUndefined();
    expect(loaded.error).toContain('not a valid API-format graph');
  });

  test('errors on malformed JSON', () => {
    const file = join(tmp, 'broken.json');
    writeFileSync(file, '{ not json');
    const loaded = loadWorkflowGraph(file, tmp, tmp);
    expect(loaded.graph).toBeUndefined();
    expect(loaded.error).toContain('not a valid API-format graph');
  });

  test('accepts // and /* */ comments and trailing commas (JSONC)', () => {
    const file = join(tmp, 'jsonc.api.json');
    writeFileSync(
      file,
      [
        '{',
        '  // positive prompt node',
        '  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "old positive" } },',
        '  /* sampler */',
        '  "3": { "class_type": "KSampler", "inputs": { "seed": 1 } },',
        '}',
      ].join('\n'),
    );
    const loaded = loadWorkflowGraph(file, tmp, tmp);
    expect(loaded.error).toBeUndefined();
    expect(loaded.graph?.['6'].inputs?.text).toBe('old positive');
  });
});

describe('randomSeed', () => {
  test('is a non-negative safe integer derived from rand()', () => {
    expect(randomSeed(() => 0)).toBe(0);
    expect(randomSeed(() => 0.5)).toBe(500000000000000);
    const seed = randomSeed();
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});
