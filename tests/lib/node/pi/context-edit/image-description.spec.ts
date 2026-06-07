/**
 * Tests for lib/node/pi/context-edit/image-description.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import {
  buildCaptionTask,
  CAPTION_MAX_CHARS,
  capDescription,
  extractGenerationPrompt,
  imageExtForMime,
  needsAutoCaption,
  selectImageDescription,
} from '../../../../../lib/node/pi/context-edit/image-description.ts';
import type { LooseMessage } from '../../../../../lib/node/pi/context-edit/target.ts';

const genCall = (id: string, name: string, args: Record<string, unknown>): LooseMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: args }],
  timestamp: 1,
});

describe('extractGenerationPrompt', () => {
  test('returns the positive prompt for a generate_image call', () => {
    const messages = [genCall('c1', 'generate_image', { prompt: 'a red fox in snow', seed: 7 })];
    expect(extractGenerationPrompt(messages, 'c1')).toBe('a red fox in snow');
  });

  test('returns the prompt for a comfyui call', () => {
    const messages = [genCall('c2', 'comfyui', { prompt: '  cyberpunk city  ' })];
    expect(extractGenerationPrompt(messages, 'c2')).toBe('cyberpunk city');
  });

  test('undefined for a non-generator tool', () => {
    const messages = [genCall('c3', 'read', { path: 'pic.png', prompt: 'ignored' })];
    expect(extractGenerationPrompt(messages, 'c3')).toBeUndefined();
  });

  test('undefined when the toolCallId is not present', () => {
    const messages = [genCall('c1', 'generate_image', { prompt: 'x' })];
    expect(extractGenerationPrompt(messages, 'missing')).toBeUndefined();
  });

  test('undefined for an empty / non-string prompt arg', () => {
    expect(extractGenerationPrompt([genCall('c1', 'generate_image', { prompt: '   ' })], 'c1')).toBeUndefined();
    expect(extractGenerationPrompt([genCall('c1', 'generate_image', { prompt: 42 })], 'c1')).toBeUndefined();
  });

  test('undefined for an empty toolCallId', () => {
    expect(extractGenerationPrompt([genCall('c1', 'generate_image', { prompt: 'x' })], '')).toBeUndefined();
  });

  test('ignores toolCall parts on non-assistant messages', () => {
    const messages: LooseMessage[] = [
      {
        role: 'toolResult',
        toolCallId: 'c1',
        content: [{ type: 'toolCall', id: 'c1', name: 'generate_image', arguments: { prompt: 'x' } }],
        timestamp: 1,
      },
    ];
    expect(extractGenerationPrompt(messages, 'c1')).toBeUndefined();
  });
});

describe('capDescription', () => {
  test('trims, collapses whitespace, returns undefined for empty', () => {
    expect(capDescription('  a   b\nc ')).toBe('a b c');
    expect(capDescription('   ')).toBeUndefined();
    expect(capDescription(undefined)).toBeUndefined();
  });

  test('caps at maxChars with an ellipsis', () => {
    const out = capDescription('abcdefghij', 5);
    expect(out).toBe('abcd\u2026');
    expect(out?.length).toBe(5);
  });

  test('default cap is CAPTION_MAX_CHARS', () => {
    const long = 'x'.repeat(CAPTION_MAX_CHARS + 50);
    expect(capDescription(long)?.length).toBe(CAPTION_MAX_CHARS);
  });
});

describe('selectImageDescription', () => {
  test('agent summary wins over generation prompt and caption', () => {
    expect(
      selectImageDescription({ agentSummary: 'summary', generationPrompt: 'prompt', autoCaption: 'caption' }),
    ).toBe('summary');
  });

  test('falls back to generation prompt, then auto-caption', () => {
    expect(selectImageDescription({ generationPrompt: 'prompt', autoCaption: 'caption' })).toBe('prompt');
    expect(selectImageDescription({ autoCaption: 'caption' })).toBe('caption');
  });

  test('undefined when every source is empty', () => {
    expect(selectImageDescription({})).toBeUndefined();
    expect(
      selectImageDescription({ agentSummary: '  ', generationPrompt: '', autoCaption: undefined }),
    ).toBeUndefined();
  });

  test('the chosen source is capped', () => {
    expect(selectImageDescription({ generationPrompt: 'abcdefghij' }, 5)).toBe('abcd\u2026');
  });
});

describe('needsAutoCaption', () => {
  test('true only when both agent summary and generation prompt are empty', () => {
    expect(needsAutoCaption({})).toBe(true);
    expect(needsAutoCaption({ agentSummary: '   ', generationPrompt: '' })).toBe(true);
    expect(needsAutoCaption({ generationPrompt: 'p' })).toBe(false);
    expect(needsAutoCaption({ agentSummary: 's' })).toBe(false);
  });
});

describe('imageExtForMime', () => {
  test('maps known mime types, defaults to png', () => {
    expect(imageExtForMime('image/png')).toBe('png');
    expect(imageExtForMime('image/jpeg')).toBe('jpg');
    expect(imageExtForMime('IMAGE/JPEG')).toBe('jpg');
    expect(imageExtForMime('image/gif')).toBe('gif');
    expect(imageExtForMime('image/webp')).toBe('webp');
    expect(imageExtForMime('application/octet-stream')).toBe('png');
    expect(imageExtForMime(undefined)).toBe('png');
  });
});

describe('buildCaptionTask', () => {
  test('names the path and the character cap, asks for caption-only output', () => {
    const task = buildCaptionTask('/tmp/x/image.png', 250);
    expect(task).toContain('/tmp/x/image.png');
    expect(task).toContain('250 characters');
    expect(task.toLowerCase()).toContain('read');
    expect(task.toLowerCase()).toContain('only the caption');
  });
});
