/**
 * Tests for config/pi/avatar/tools/workflow-registry.ts.
 *
 * Pure module - no network or pi runtime needed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { ComfyWorkflow } from '../../../../../lib/node/pi/comfyui/types.ts';
import {
  loadAndValidateRegistry,
  parseRegistry,
  validateRegistryEntry,
} from '../../../../../config/pi/avatar/tools/workflow-registry.ts';

function sampleGraph(): ComfyWorkflow {
  return {
    '12': { class_type: 'CLIPTextEncode', inputs: { text: 'negative' } },
    '19': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 4 } },
    '28': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '64': { class_type: 'ConcatStringSingle', inputs: { string_a: '', string_b: '' } },
  };
}

function writeWorkflow(dir: string, name: string, graph: ComfyWorkflow): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(graph));
  return file;
}

describe('validateRegistryEntry', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'avatar-wf-reg-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('accepts a valid generate entry when every mapped node exists', () => {
    const wfFile = writeWorkflow(tmp, 'anima.api.json', sampleGraph());
    const entry = {
      file: wfFile,
      role: 'generate' as const,
      inputs: {
        prompt: { node: '64', key: 'string_b' },
        negative: { node: '12', key: 'text' },
        seed: { node: '19', key: 'seed' },
        steps: { node: '19', key: 'steps' },
        cfg: { node: '19', key: 'cfg' },
        width: { node: '28', key: 'width' },
        height: { node: '28', key: 'height' },
        batch: { node: '28', key: 'batch_size' },
      },
    };

    const result = validateRegistryEntry('anima', entry, tmp, tmp);
    expect(result.errors).toEqual([]);
    expect(result.workflow?.graph['64'].inputs?.string_b).toBe('');
  });

  test('flags a dangling node reference in the input map', () => {
    const wfFile = writeWorkflow(tmp, 'bad.api.json', sampleGraph());
    const entry = {
      file: wfFile,
      role: 'generate' as const,
      inputs: {
        prompt: { node: '999', key: 'text' },
      },
    };

    const result = validateRegistryEntry('broken', entry, tmp, tmp);
    expect(result.workflow).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('prompt');
    expect(result.errors[0]).toContain('node "999"');
  });

  test('edit role requires an image input mapping', () => {
    const wfFile = writeWorkflow(tmp, 'edit.api.json', sampleGraph());
    const entry = {
      file: wfFile,
      role: 'edit' as const,
      inputs: {
        prompt: { node: '64', key: 'string_b' },
      },
    };

    const result = validateRegistryEntry('kontext', entry, tmp, tmp);
    expect(result.workflow).toBeUndefined();
    expect(result.errors[0]).toContain('edit role requires an "image" input mapping');
  });

  test('generate role rejects an image input mapping', () => {
    const wfFile = writeWorkflow(tmp, 'gen.api.json', {
      ...sampleGraph(),
      '99': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
    });
    const entry = {
      file: wfFile,
      role: 'generate' as const,
      inputs: {
        prompt: { node: '64', key: 'string_b' },
        image: { node: '99', key: 'image' },
      },
    };

    const result = validateRegistryEntry('anima', entry, tmp, tmp);
    expect(result.workflow).toBeUndefined();
    expect(result.errors[0]).toContain('generate role must not declare an "image" input mapping');
  });

  test('reference role requires an image input mapping', () => {
    const wfFile = writeWorkflow(tmp, 'ref.api.json', sampleGraph());
    const entry = {
      file: wfFile,
      role: 'reference' as const,
      inputs: {
        prompt: { node: '64', key: 'string_b' },
      },
    };

    const result = validateRegistryEntry('sdxl-ipadapter', entry, tmp, tmp);
    expect(result.workflow).toBeUndefined();
    expect(result.errors[0]).toContain('reference role requires an "image" input mapping');
  });

  test('accepts a reference role with an image input mapping', () => {
    const wfFile = writeWorkflow(tmp, 'ref-ok.api.json', {
      ...sampleGraph(),
      '21': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
    });
    const entry = {
      file: wfFile,
      role: 'reference' as const,
      inputs: {
        prompt: { node: '64', key: 'string_b' },
        image: { node: '21', key: 'image' },
      },
    };

    const result = validateRegistryEntry('sdxl-ipadapter', entry, tmp, tmp);
    expect(result.errors).toEqual([]);
    expect(result.workflow?.entry.role).toBe('reference');
  });
});

describe('loadAndValidateRegistry', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'avatar-wf-reg-load-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('loads and validates a registry file', () => {
    mkdirSync(join(tmp, 'workflows'), { recursive: true });
    writeWorkflow(tmp, 'workflows/anima.api.json', sampleGraph());
    const registryFile = join(tmp, 'workflows.json');
    writeFileSync(
      registryFile,
      JSON.stringify({
        anima: {
          file: 'workflows/anima.api.json',
          role: 'generate',
          inputs: {
            prompt: { node: '64', key: 'string_b' },
            negative: { node: '12', key: 'text' },
          },
        },
      }),
    );

    const result = loadAndValidateRegistry(registryFile, tmp, tmp);
    expect(result.errors).toEqual([]);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]?.name).toBe('anima');
  });
});

describe('parseRegistry', () => {
  test('drops malformed entries and keeps valid ones', () => {
    const registry = parseRegistry({
      anima: {
        file: 'anima.api.json',
        role: 'generate',
        inputs: { prompt: { node: '64', key: 'string_b' } },
      },
      broken: { role: 'edit' },
    });
    expect(Object.keys(registry)).toEqual(['anima']);
    expect(registry.anima?.role).toBe('generate');
  });
});
