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
  historyHasEntry,
  historyHasError,
  isExecutionComplete,
  joinUrl,
  normalizeBaseUrl,
  parseWsMessage,
  queueHasPrompt,
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

  test('collects gifs/video and audio outputs alongside images', () => {
    const history = {
      p1: {
        outputs: {
          '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
          '11': { gifs: [{ filename: 'clip.webp', subfolder: '', type: 'output' }] },
          '12': { audio: [{ filename: 'song.flac', subfolder: '', type: 'output' }] },
        },
      },
    };
    expect(extractOutputImages(history, 'p1')).toEqual([
      { filename: 'a.png', subfolder: '', type: 'output' },
      { filename: 'clip.webp', subfolder: '', type: 'output' },
      { filename: 'song.flac', subfolder: '', type: 'output' },
    ]);
  });

  test('de-duplicates a Preview(temp)+Save(output) pair, keeping the output ref', () => {
    const history = {
      p1: {
        outputs: {
          '9': { images: [{ filename: 'a.png', subfolder: '', type: 'temp' }] },
          '10': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
        },
      },
    };
    expect(extractOutputImages(history, 'p1')).toEqual([{ filename: 'a.png', subfolder: '', type: 'output' }]);
  });

  test('keeps same-named files in different subfolders distinct', () => {
    const history = {
      p1: {
        outputs: {
          '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
          '10': { images: [{ filename: 'a.png', subfolder: 'sub', type: 'output' }] },
        },
      },
    };
    expect(extractOutputImages(history, 'p1')).toHaveLength(2);
  });
});

describe('historyHasEntry', () => {
  test('true only when the prompt has an entry object', () => {
    expect(historyHasEntry({ p1: { outputs: {} } }, 'p1')).toBe(true);
    expect(historyHasEntry({ p1: {} }, 'p1')).toBe(true);
    expect(historyHasEntry({}, 'p1')).toBe(false);
    expect(historyHasEntry(null, 'p1')).toBe(false);
  });
});

describe('queueHasPrompt', () => {
  test('finds the prompt in either the running or pending list', () => {
    const queue = {
      queue_running: [[0, 'p1', {}]],
      queue_pending: [[1, 'p2', {}]],
    };
    expect(queueHasPrompt(queue, 'p1')).toBe(true);
    expect(queueHasPrompt(queue, 'p2')).toBe(true);
    expect(queueHasPrompt(queue, 'p3')).toBe(false);
  });

  test('false for malformed or empty bodies', () => {
    expect(queueHasPrompt(null, 'p1')).toBe(false);
    expect(queueHasPrompt({}, 'p1')).toBe(false);
    expect(queueHasPrompt({ queue_running: 'nope' }, 'p1')).toBe(false);
    expect(queueHasPrompt({ queue_running: [['no-id-here']] }, 'p1')).toBe(false);
  });
});

describe('historyHasError', () => {
  test('true only when the prompt entry reports status_str error', () => {
    expect(historyHasError({ p1: { status: { status_str: 'error' } } }, 'p1')).toBe(true);
    expect(historyHasError({ p1: { status: { status_str: 'success' } } }, 'p1')).toBe(false);
  });

  test('false for absent prompt, missing status, or malformed shapes', () => {
    expect(historyHasError({}, 'p1')).toBe(false);
    expect(historyHasError({ p1: {} }, 'p1')).toBe(false);
    expect(historyHasError({ p1: { status: {} } }, 'p1')).toBe(false);
    expect(historyHasError(null, 'p1')).toBe(false);
    expect(historyHasError('nope', 'p1')).toBe(false);
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
