import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { prepareWorkflowFile } from '../../../../../lib/node/pi/comfyui/workflow-file.ts';

let dir: string;
const graph = { '1': { class_type: 'KSampler', inputs: { seed: 123, steps: 4 } } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comfy-file-'));
  writeFileSync(join(dir, 'graph.api.json'), JSON.stringify(graph));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('prepareWorkflowFile', () => {
  test.each(['graph.api.json', './graph.api.json', '~/graph.api.json'])(
    'resolves %s and preserves baked values',
    (path) => {
      expect(prepareWorkflowFile({ workflowFile: path }, dir, dir)).toEqual({
        file: join(dir, 'graph.api.json'),
        graph,
      });
    },
  );

  test('accepts absolute paths, JSONC, and output controls', () => {
    const file = join(dir, 'graph.api.json');
    writeFileSync(file, '{ // comment\n "1": {"class_type":"SaveImage", "inputs": {},},}');
    expect(
      prepareWorkflowFile(
        {
          workflowFile: file,
          background: true,
          sendToModel: false,
          ephemeral: false,
          previewMaxDimension: 512,
          enhance: false,
          autoRefine: false,
        },
        '/other',
        '/home',
      ),
    ).toEqual({
      file,
      graph: { '1': { class_type: 'SaveImage', inputs: {} } },
    });
  });

  test.each(['', '   '])('rejects an empty path %j', (path) => {
    expect(prepareWorkflowFile({ workflowFile: path }, dir, dir)).toHaveProperty(
      'error',
      expect.stringContaining('non-empty'),
    );
  });

  test.each([
    ['workflow', 'named'],
    ['prompt', 'cat'],
    ['negative', 'bad'],
    ['seed', 123],
    ['width', 512],
    ['height', 512],
    ['steps', 4],
    ['cfg', 1],
    ['denoise', 0.5],
    ['aspect', 'square'],
    ['duration', 4],
    ['refImageSize', 'match'],
    ['count', 1],
    ['inputImages', []],
    ['inputVideos', []],
    ['inputAudios', []],
    ['images', {}],
    ['variationOf', 'g1'],
    ['refine', 'g1'],
    ['enhance', true],
    ['autoRefine', true],
    ['context', 'scene'],
    ['refineCriteria', 'sharp'],
  ])('rejects explicit %s rather than silently ignoring it', (key, value) => {
    const result = prepareWorkflowFile({ workflowFile: 'graph.api.json', [key]: value }, dir, dir);
    expect(result).toHaveProperty('error', expect.stringContaining(`incompatible options: ${key}`));
  });

  test.each([
    '{',
    '{}',
    '[]',
    '{"nodes":[],"links":[]}',
    '{"1":{"inputs":{}}}',
    '{"1":{"class_type":"","inputs":{}}}',
    '{"1":{"class_type":"X","inputs":[]}}',
  ])('rejects invalid graph %s', (text) => {
    writeFileSync(join(dir, 'graph.api.json'), text);
    expect(prepareWorkflowFile({ workflowFile: 'graph.api.json' }, dir, dir)).toHaveProperty('error');
  });

  test('reports missing files and directories without throwing', () => {
    expect(prepareWorkflowFile({ workflowFile: 'missing.json' }, dir, dir)).toHaveProperty(
      'error',
      expect.stringContaining('not found'),
    );
    expect(prepareWorkflowFile({ workflowFile: dir }, dir, dir)).toHaveProperty('error');
  });
});
