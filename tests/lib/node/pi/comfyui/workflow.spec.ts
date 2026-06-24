/**
 * Tests for lib/node/pi/comfyui/workflow.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { ComfyWorkflow } from '../../../../../lib/node/pi/comfyui/types.ts';
import {
  formatWorkflowValidation,
  injectImageList,
  injectImageRoles,
  injectInputs,
  isComfyWorkflow,
  isRoleMap,
  loadWorkflowGraph,
  randomSeed,
  validateImageMappings,
  validateImageRoleMap,
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

describe('injectImageList', () => {
  const refTargets = [
    { node: '6', key: 'image' },
    { node: '7', key: 'image' },
  ];

  test('writes each name into its ordered slot and leaves the original untouched', () => {
    const wf = sampleWorkflow();
    const result = injectImageList(wf, refTargets, ['ref-a', 'ref-b']);
    expect(result.errors).toEqual([]);
    expect(result.workflow['6'].inputs?.image).toBe('ref-a');
    expect(result.workflow['7'].inputs?.image).toBe('ref-b');
    expect(wf['6'].inputs?.image).toBeUndefined();
  });

  test('fills only the supplied slots, leaving trailing slots untouched', () => {
    const result = injectImageList(sampleWorkflow(), refTargets, ['ref-a']);
    expect(result.errors).toEqual([]);
    expect(result.workflow['6'].inputs?.image).toBe('ref-a');
    expect(result.workflow['7'].inputs?.image).toBeUndefined();
  });

  test('records an error when a target node is missing from the graph', () => {
    const result = injectImageList(sampleWorkflow(), [{ node: '404', key: 'image' }], ['ref-a']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('reference image 1');
  });
});

describe('validateImageMappings', () => {
  test('returns no errors when every image slot exists', () => {
    const targets = [
      { node: '6', key: 'image' },
      { node: '7', key: 'image' },
    ];
    expect(validateImageMappings(sampleWorkflow(), targets)).toEqual([]);
  });

  test('flags each dangling image slot by index', () => {
    const targets = [
      { node: '6', key: 'image' },
      { node: '404', key: 'image' },
    ];
    const errors = validateImageMappings(sampleWorkflow(), targets);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('image 2');
  });
});

describe('isRoleMap', () => {
  test('treats an array as positional and an object as a role map', () => {
    expect(isRoleMap(undefined)).toBe(false);
    expect(isRoleMap([{ node: '6', key: 'image' }])).toBe(false);
    expect(isRoleMap({ init: { node: '6', key: 'image' } })).toBe(true);
  });
});

describe('injectImageRoles', () => {
  const roleMap = {
    init: { node: '6', key: 'image' },
    mask: { node: '7', key: 'image', kind: 'mask' as const },
  };

  test('writes each uploaded name into its role node and clones the input', () => {
    const original = sampleWorkflow();
    const { workflow, errors } = injectImageRoles(original, roleMap, { init: 'in.png', mask: 'm.png' });
    expect(errors).toEqual([]);
    expect(workflow['6'].inputs?.image).toBe('in.png');
    expect(workflow['7'].inputs?.image).toBe('m.png');
    expect(original['6'].inputs?.image).toBeUndefined();
  });

  test('ignores roles absent from the upload set', () => {
    const { workflow, errors } = injectImageRoles(sampleWorkflow(), roleMap, { init: 'in.png' });
    expect(errors).toEqual([]);
    expect(workflow['6'].inputs?.image).toBe('in.png');
    expect(workflow['7'].inputs?.image).toBeUndefined();
  });

  test('flags an upload for an unknown role or a missing node', () => {
    const r1 = injectImageRoles(sampleWorkflow(), roleMap, { control: 'c.png' });
    expect(r1.errors[0]).toContain('no image role "control"');
    const bad = { init: { node: '404', key: 'image' } };
    const r2 = injectImageRoles(sampleWorkflow(), bad, { init: 'in.png' });
    expect(r2.errors[0]).toContain('404');
  });
});

describe('validateImageRoleMap', () => {
  test('flags each role whose node is missing', () => {
    const errors = validateImageRoleMap(sampleWorkflow(), {
      init: { node: '6', key: 'image' },
      mask: { node: '404', key: 'image', kind: 'mask' },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('role "mask"');
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

describe('formatWorkflowValidation', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'comfyui-wfval-spec-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('placeholder when no workflows are configured', () => {
    expect(formatWorkflowValidation({}, tmp, tmp)).toBe('no workflows configured');
  });

  test('checkmark line listing the mapped inputs for a valid workflow', () => {
    const file = join(tmp, 'ok.json');
    writeFileSync(file, JSON.stringify(sampleWorkflow()));
    const out = formatWorkflowValidation({ ok: { file, inputs: MAP } }, tmp, tmp);
    expect(out).toBe('\u2713 ok: prompt, negative, seed, width');
  });

  test('cross line with the loader error when the file is missing', () => {
    const out = formatWorkflowValidation({ gone: { file: join(tmp, 'nope.json'), inputs: MAP } }, tmp, tmp);
    expect(out).toMatch(/^\u2717 gone: /);
    expect(out).toContain('not found');
  });

  test('cross line with mapping errors when a mapped node is absent', () => {
    const file = join(tmp, 'badmap.json');
    writeFileSync(file, JSON.stringify(sampleWorkflow()));
    const out = formatWorkflowValidation({ bad: { file, inputs: { prompt: { node: '999', key: 'text' } } } }, tmp, tmp);
    expect(out).toMatch(/^\u2717 bad: /);
    expect(out).toContain('node "999"');
  });

  test('one line per workflow, in insertion order', () => {
    const file = join(tmp, 'ok.json');
    writeFileSync(file, JSON.stringify(sampleWorkflow()));
    const out = formatWorkflowValidation(
      {
        ok: { file, inputs: { prompt: { node: '6', key: 'text' } } },
        gone: { file: join(tmp, 'x.json'), inputs: MAP },
      },
      tmp,
      tmp,
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('\u2713 ok: prompt');
    expect(lines[1]).toMatch(/^\u2717 gone: /);
  });
});
