/**
 * Specs for `annotateBashResult` - the helper that splices ASRT's
 * `annotateStderrWithSandboxFailures` output into pi's bash
 * `tool_result` content array.
 *
 * Without this splice the model sees opaque EPERM / EROFS messages
 * when the kernel sandbox blocks an operation; with it the model
 * sees ASRT's explanation prefixed by a visible tag so it can
 * recover the next turn (try a different host, ask for /sandbox-allow,
 * etc.).
 */

import { describe, expect, test } from 'vitest';

import { annotateBashResult, type BashContentItem } from '../../../../../lib/node/pi/sandbox/result-annotate.ts';

const TAG = '⚠️  sandbox blocked this operation:';

describe('annotateBashResult', () => {
  test('returns undefined when annotated == stderr (annotator added nothing)', () => {
    expect(annotateBashResult('EPERM', 'EPERM', [{ type: 'text', text: 'EPERM' }])).toBeUndefined();
  });

  test('returns undefined when content is empty', () => {
    expect(annotateBashResult('EPERM\nSandboxed: ~/.ssh denied', 'EPERM', [])).toBeUndefined();
    expect(annotateBashResult('EPERM\nSandboxed: ~/.ssh denied', 'EPERM', undefined)).toBeUndefined();
  });

  test('strips the leading stderr prefix from the annotation when present', () => {
    const stderr = 'cat: /home/u/.ssh/id_rsa: Operation not permitted\n';
    const annotated = `${stderr}sandbox: read denied for ~/.ssh; configured in filesystem.json`;
    const content: BashContentItem[] = [{ type: 'text', text: `${stderr}\nexit 1` }];

    const result = annotateBashResult(annotated, stderr, content);
    expect(result).toBeDefined();
    expect(result!.hint).toBe('sandbox: read denied for ~/.ssh; configured in filesystem.json');
    expect(result!.kind).toBe('fs');
    // Spliced into the FIRST text item, original tail preserved.
    expect(result!.content).toHaveLength(1);
    const firstText = result!.content[0] as { type: string; text: string };
    expect(firstText.text.startsWith(TAG)).toBe(true);
    expect(firstText.text).toContain('sandbox: read denied for ~/.ssh');
    expect(firstText.text).toContain(stderr);
    expect(firstText.text).toContain('exit 1');
  });

  test('treats annotations that do NOT prefix stderr as standalone hints', () => {
    const stderr = 'curl: (7) Failed to connect to evil.example.com';
    const annotated = 'Sandbox: network denied for host evil.example.com (not in network.allow).';
    const content: BashContentItem[] = [{ type: 'text', text: stderr }];

    const result = annotateBashResult(annotated, stderr, content);
    expect(result).toBeDefined();
    expect(result!.hint).toBe(annotated);
    expect(result!.kind).toBe('net');
    expect((result!.content[0] as { text: string }).text).toContain(TAG);
    expect((result!.content[0] as { text: string }).text).toContain(annotated);
  });

  test('classifies network-ish hints as kind=net', () => {
    const stderr = 'connect: Operation not permitted';
    const annotated = `${stderr}\nblocked by sandbox network policy (host github.com)`;
    const result = annotateBashResult(annotated, stderr, [{ type: 'text', text: stderr }]);
    expect(result?.kind).toBe('net');
  });

  test('classifies filesystem-ish hints as kind=fs (default when no network keywords)', () => {
    const stderr = 'open(/home/u/.ssh/id_rsa): EPERM';
    const annotated = `${stderr}\nsandbox: read denied for path inside read.deny.paths`;
    const result = annotateBashResult(annotated, stderr, [{ type: 'text', text: stderr }]);
    expect(result?.kind).toBe('fs');
  });

  test('passes through non-text content items unchanged', () => {
    const stderr = 'curl: connect failed';
    const annotated = `${stderr}\nsandbox: host blocked`;
    const content: BashContentItem[] = [
      { type: 'text', text: stderr },
      { type: 'image', text: '<base64>' } as BashContentItem,
    ];
    const result = annotateBashResult(annotated, stderr, content);
    expect(result?.content).toHaveLength(2);
    expect(result?.content[1]).toEqual({ type: 'image', text: '<base64>' });
  });

  test('prepends a new text item when no existing text content exists', () => {
    const stderr = 'EPERM';
    const annotated = `${stderr}\nsandbox: blocked`;
    const content: BashContentItem[] = [{ type: 'image', text: '<png>' } as BashContentItem];
    const result = annotateBashResult(annotated, stderr, content);
    expect(result).toBeDefined();
    expect(result!.content).toHaveLength(2);
    expect((result!.content[0] as { type: string }).type).toBe('text');
    expect((result!.content[0] as { text: string }).text).toContain(TAG);
    expect(result!.content[1]).toEqual({ type: 'image', text: '<png>' });
  });

  test('returns undefined when the hint reduces to empty whitespace after trim', () => {
    const stderr = 'EPERM';
    const annotated = `${stderr}\n   \n`;
    const result = annotateBashResult(annotated, stderr, [{ type: 'text', text: stderr }]);
    expect(result).toBeUndefined();
  });
});
