/**
 * Tests for lib/node/pi/comfyui/api.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  buildHistoryUrl,
  buildInterruptUrl,
  buildQueueUrl,
  buildViewUrl,
  extractOutputImages,
  isExecutionComplete,
  joinUrl,
  normalizeBaseUrl,
  parseWsMessage,
  toWsUrl,
} from '../../../../../lib/node/pi/comfyui/api.ts';

describe('url builders', () => {
  test('normalizeBaseUrl strips trailing slashes', () => {
    expect(normalizeBaseUrl('http://x:8188/')).toBe('http://x:8188');
    expect(normalizeBaseUrl('http://x:8188///')).toBe('http://x:8188');
    expect(normalizeBaseUrl('http://x:8188')).toBe('http://x:8188');
  });

  test('joinUrl inserts exactly one slash', () => {
    expect(joinUrl('http://x:8188/', '/prompt')).toBe('http://x:8188/prompt');
    expect(joinUrl('http://x:8188', 'prompt')).toBe('http://x:8188/prompt');
  });

  test('buildViewUrl encodes filename, subfolder, and type', () => {
    const url = buildViewUrl('http://x:8188', { filename: 'a b.png', subfolder: 'sub', type: 'output' });
    expect(url).toContain('http://x:8188/view?');
    expect(url).toContain('filename=a+b.png');
    expect(url).toContain('subfolder=sub');
    expect(url).toContain('type=output');
  });

  test('buildHistoryUrl encodes the prompt id', () => {
    expect(buildHistoryUrl('http://x:8188', 'abc-123')).toBe('http://x:8188/history/abc-123');
  });

  test('buildQueueUrl and buildInterruptUrl point at the right endpoints', () => {
    expect(buildQueueUrl('http://x:8188/')).toBe('http://x:8188/queue');
    expect(buildInterruptUrl('http://x:8188')).toBe('http://x:8188/interrupt');
  });

  test('toWsUrl upgrades scheme and appends clientId', () => {
    expect(toWsUrl('http://x:8188', 'cid')).toBe('ws://x:8188/ws?clientId=cid');
    expect(toWsUrl('https://x:8188/', 'cid')).toBe('wss://x:8188/ws?clientId=cid');
  });
});

describe('extractOutputImages', () => {
  test('collects every image across output nodes', () => {
    const history = {
      p1: {
        outputs: {
          '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
          '10': { images: [{ filename: 'b.png', subfolder: 'sub', type: 'temp' }] },
        },
      },
    };
    expect(extractOutputImages(history, 'p1')).toEqual([
      { filename: 'a.png', subfolder: '', type: 'output' },
      { filename: 'b.png', subfolder: 'sub', type: 'temp' },
    ]);
  });

  test('defaults missing subfolder/type and skips entries without a filename', () => {
    const history = { p1: { outputs: { '9': { images: [{ filename: 'a.png' }, { type: 'output' }] } } } };
    expect(extractOutputImages(history, 'p1')).toEqual([{ filename: 'a.png', subfolder: '', type: 'output' }]);
  });

  test('returns [] when the prompt is absent or malformed', () => {
    expect(extractOutputImages({}, 'p1')).toEqual([]);
    expect(extractOutputImages({ p1: {} }, 'p1')).toEqual([]);
    expect(extractOutputImages(null, 'p1')).toEqual([]);
  });
});

describe('parseWsMessage', () => {
  test('parses progress with value/max/prompt_id', () => {
    const event = parseWsMessage(JSON.stringify({ type: 'progress', data: { value: 5, max: 20, prompt_id: 'p1' } }));
    expect(event).toEqual({ type: 'progress', value: 5, max: 20, promptId: 'p1' });
  });

  test('parses executing with a null node (completion signal)', () => {
    const event = parseWsMessage(JSON.stringify({ type: 'executing', data: { node: null, prompt_id: 'p1' } }));
    expect(event).toEqual({ type: 'executing', node: null, promptId: 'p1' });
  });

  test('maps unknown types to other and rejects non-JSON / typeless', () => {
    expect(parseWsMessage(JSON.stringify({ type: 'execution_cached', data: {} }))?.type).toBe('other');
    expect(parseWsMessage('not json')).toBeNull();
    expect(parseWsMessage(JSON.stringify({ data: {} }))).toBeNull();
  });
});

describe('isExecutionComplete', () => {
  test('true only for executing/null-node matching the prompt id', () => {
    expect(isExecutionComplete({ type: 'executing', node: null, promptId: 'p1' }, 'p1')).toBe(true);
    expect(isExecutionComplete({ type: 'executing', node: '9', promptId: 'p1' }, 'p1')).toBe(false);
    expect(isExecutionComplete({ type: 'executing', node: null, promptId: 'p2' }, 'p1')).toBe(false);
    expect(isExecutionComplete({ type: 'progress', value: 1, max: 2 }, 'p1')).toBe(false);
  });
});
