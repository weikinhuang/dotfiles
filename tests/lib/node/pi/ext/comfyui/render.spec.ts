/**
 * Tests for lib/node/pi/ext/comfyui/render.ts - the `renderCall` /
 * `renderResult` formatters for the `generate_image` and `image_jobs`
 * tools. The formatters are pure of session state (they read only the
 * tool args, the result `details`, and the render options/context), so a
 * stub identity theme makes their text output assertable.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Text } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'vitest';

import type { ImageJob } from '../../../../../../lib/node/pi/comfyui/jobs.ts';
import type { GenerateDetails, JobsDetails } from '../../../../../../lib/node/pi/ext/comfyui/details.ts';
import {
  renderGenerateCall,
  renderGenerateResult,
  renderJobsCall,
  renderJobsResult,
} from '../../../../../../lib/node/pi/ext/comfyui/render.ts';

// Identity theme: `fg` and `bold` pass the text through unchanged so the
// rendered string is exactly the formatter's logical content (no ANSI).
const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/** Render a Text component to a single string (wide enough to avoid wrapping). */
function out(t: Text): string {
  return t
    .render(200)
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n');
}

function gen(details: Partial<GenerateDetails>): { details: Partial<GenerateDetails> } {
  return { details };
}
function jobs(details: Partial<JobsDetails>): { details: Partial<JobsDetails> } {
  return { details };
}

describe('renderGenerateCall', () => {
  test('shows a trimmed, collapsed prompt preview', () => {
    expect(out(renderGenerateCall({ prompt: '  a   red\n cat  ' }, theme))).toBe('generate_image a red cat');
  });
  test('truncates a long prompt with an ellipsis', () => {
    const long = 'x'.repeat(80);
    expect(out(renderGenerateCall({ prompt: long }, theme))).toBe(`generate_image ${'x'.repeat(60)}…`);
  });
  test('tolerates a missing prompt', () => {
    // (trailing space after the title is trimmed by the render helper)
    expect(out(renderGenerateCall({}, theme))).toBe('generate_image');
  });
});

describe('renderGenerateResult', () => {
  test('error wins over everything', () => {
    expect(out(renderGenerateResult(gen({ error: 'boom' }), {}, theme, {}))).toBe('✗ boom');
  });

  test('background submission shows the job handle (collapsed)', () => {
    expect(out(renderGenerateResult(gen({ background: true, jobId: 'j1', seed: 5 }), {}, theme, {}))).toBe(
      '▶ background [j1] · seed 5',
    );
  });

  test('background expanded shows prompt + negative from the call args', () => {
    const r = renderGenerateResult(gen({ background: true, jobId: 'j1' }), { expanded: true }, theme, {
      args: { prompt: 'a cat', negative: 'blurry' },
    });
    expect(out(r)).toBe('▶ background [j1]\nprompt:   a cat\nnegative: blurry');
  });

  test('partial render with no images yet surfaces the progress line', () => {
    expect(out(renderGenerateResult(gen({ progress: 'generating 12/30' }), { isPartial: true }, theme, {}))).toBe(
      '⟳ generating 12/30',
    );
  });

  test('partial render falls back to "working…" with no progress', () => {
    expect(out(renderGenerateResult(gen({}), {}, theme, { isPartial: true }))).toBe('⟳ working…');
  });

  test('success summary carries generation id, count, seed, and ephemeral marker', () => {
    expect(
      out(
        renderGenerateResult(
          gen({ savedPaths: ['/a.png'], seed: 7, generationId: 'g3', ephemeral: true }),
          {},
          theme,
          {},
        ),
      ),
    ).toBe('✓ [g3] 1 image · seed 7 · ephemeral');
  });

  test('success summary pluralizes and omits absent decorations', () => {
    expect(out(renderGenerateResult(gen({ savedPaths: ['/a.png', '/b.png'] }), {}, theme, {}))).toBe('✓ 2 images');
  });

  test('expanded success shows prompt, negative default, and each saved path', () => {
    const r = renderGenerateResult(gen({ savedPaths: ['/a.png', '/b.png'] }), { expanded: true }, theme, {
      args: { prompt: 'a cat' },
    });
    expect(out(r)).toBe(
      '✓ 2 images\nprompt:   a cat\nnegative: (workflow default)\nsaved:    /a.png\nsaved:    /b.png',
    );
  });
});

describe('renderJobsCall', () => {
  test('shows the action verb', () => {
    expect(out(renderJobsCall({ action: 'list' }, theme))).toBe('image_jobs list');
  });
  test('appends the job id when present', () => {
    expect(out(renderJobsCall({ action: 'collect', id: 'j2' }, theme))).toBe('image_jobs collect [j2]');
  });
});

describe('renderJobsResult', () => {
  test('error wins', () => {
    expect(out(renderJobsResult(jobs({ error: 'nope' }), theme))).toBe('✗ nope');
  });

  test('empty list', () => {
    expect(out(renderJobsResult(jobs({ action: 'list', jobs: [] }), theme))).toBe('(no background image jobs)');
  });

  test('non-empty list renders one line per job containing its id', () => {
    const job: ImageJob = {
      id: 'j7',
      promptId: 'p',
      workflow: 'anima',
      status: 'running',
      prompt: 'a cat',
      savedPaths: [],
      saveDir: '/out',
      sendToModel: true,
      startedAt: Date.now(),
    };
    expect(out(renderJobsResult(jobs({ action: 'list', jobs: [job] }), theme))).toContain('j7');
  });

  test('status glyphs for collect outcomes', () => {
    expect(out(renderJobsResult(jobs({ jobId: 'j1', status: 'running' }), theme))).toBe('⟳ [j1] still running');
    expect(out(renderJobsResult(jobs({ jobId: 'j1', status: 'cancelled' }), theme))).toBe('◌ [j1] cancelled');
    expect(out(renderJobsResult(jobs({ jobId: 'j1', status: 'done', savedPaths: ['/a.png'] }), theme))).toBe(
      '✓ [j1] 1 image',
    );
  });

  test('falls back to a bare id when status is unknown', () => {
    expect(out(renderJobsResult(jobs({ jobId: 'j9' }), theme))).toBe('[j9]');
  });
});
