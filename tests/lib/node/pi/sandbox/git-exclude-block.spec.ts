/**
 * Tests for lib/node/pi/sandbox/git-exclude-block.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  PI_SANDBOX_EXCLUDE_BEGIN,
  PI_SANDBOX_EXCLUDE_END,
  buildManagedBlock,
  computeExcludableStubs,
  type StubProbe,
  spliceManagedBlock,
  stripManagedBlock,
} from '../../../../../lib/node/pi/sandbox/git-exclude-block.ts';

/** Body of a managed block (header comment + entries) without the
 *  begin/end markers, for exact-match assertions. */
function buildBody(entries: string[]): string {
  const full = buildManagedBlock(entries).split('\n');
  // drop begin (first) and end (last) markers
  return full.slice(1, -1).join('\n') + '\n';
}

describe('buildManagedBlock', () => {
  test('renders marker pair + header + entries', () => {
    const block = buildManagedBlock(['/.bashrc', '/.claude/commands/']);
    const lines = block.split('\n');
    expect(lines[0]).toBe(PI_SANDBOX_EXCLUDE_BEGIN);
    expect(lines[lines.length - 1]).toBe(PI_SANDBOX_EXCLUDE_END);
    expect(block).toContain('/.bashrc');
    expect(block).toContain('/.claude/commands/');
    expect(block).toContain('Managed by the pi sandbox extension');
  });

  test('empty entries yields empty string', () => {
    expect(buildManagedBlock([])).toBe('');
  });
});

describe('stripManagedBlock', () => {
  test('removes the managed block and preserves surrounding content', () => {
    const spliced = spliceManagedBlock('# user rules\n*.log\n', ['/.bashrc']);
    const stripped = stripManagedBlock(spliced);
    expect(stripped).toBe('# user rules\n*.log\n');
    expect(stripped).not.toContain(PI_SANDBOX_EXCLUDE_BEGIN);
  });

  test('is a no-op when no managed block is present', () => {
    const content = '# user rules\n*.log\n';
    expect(stripManagedBlock(content)).toBe(content);
  });

  test('self-heals duplicate blocks (idempotent removal)', () => {
    const dup =
      '*.log\n' +
      `${PI_SANDBOX_EXCLUDE_BEGIN}\n/.bashrc\n${PI_SANDBOX_EXCLUDE_END}\n` +
      `${PI_SANDBOX_EXCLUDE_BEGIN}\n/.gitconfig\n${PI_SANDBOX_EXCLUDE_END}\n`;
    expect(stripManagedBlock(dup)).toBe('*.log\n');
  });

  test('dangling begin (no end) is stripped to EOF', () => {
    const corrupt = `*.log\n${PI_SANDBOX_EXCLUDE_BEGIN}\n/.bashrc\n`;
    expect(stripManagedBlock(corrupt)).toBe('*.log\n');
  });

  test('empty result when the file was only our block', () => {
    const only = `${PI_SANDBOX_EXCLUDE_BEGIN}\n/.bashrc\n${PI_SANDBOX_EXCLUDE_END}\n`;
    expect(stripManagedBlock(only)).toBe('');
  });
});

describe('spliceManagedBlock', () => {
  test('appends block separated by one blank line, single trailing newline', () => {
    const out = spliceManagedBlock('# user rules\n*.log\n', ['/.bashrc']);
    expect(out).toBe(
      '# user rules\n*.log\n\n' +
        `${PI_SANDBOX_EXCLUDE_BEGIN}\n` +
        buildBody(['/.bashrc']) +
        `${PI_SANDBOX_EXCLUDE_END}\n`,
    );
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  test('is idempotent across repeated splices with the same entries', () => {
    const once = spliceManagedBlock('*.log\n', ['/.bashrc', '/.gitconfig']);
    const twice = spliceManagedBlock(once, ['/.bashrc', '/.gitconfig']);
    expect(twice).toBe(once);
  });

  test('refreshes the block when the entry set changes', () => {
    const first = spliceManagedBlock('*.log\n', ['/.bashrc']);
    const second = spliceManagedBlock(first, ['/.gitconfig']);
    expect(second).toContain('/.gitconfig');
    expect(second).not.toContain('/.bashrc');
    // exactly one managed block
    expect(second.split(PI_SANDBOX_EXCLUDE_BEGIN).length - 1).toBe(1);
  });

  test('empty entries strips to bare content', () => {
    const withBlock = spliceManagedBlock('*.log\n', ['/.bashrc']);
    expect(spliceManagedBlock(withBlock, [])).toBe('*.log\n');
  });

  test('handles an empty starting file', () => {
    const out = spliceManagedBlock('', ['/.bashrc']);
    expect(out).toBe(buildManagedBlock(['/.bashrc']) + '\n');
  });
});

describe('computeExcludableStubs', () => {
  const probeFor =
    (map: Record<string, StubProbe>) =>
    (abs: string): StubProbe =>
      map[abs] ?? 'absent';

  test('includes absent and empty stubs, excludes real (non-empty) files', () => {
    const cwd = '/repo';
    const entries = computeExcludableStubs(cwd, {
      fileStubs: ['.bashrc', '.mcp.json', 'package.json'],
      dirStubs: [],
      probe: probeFor({
        '/repo/.bashrc': 'absent',
        '/repo/.mcp.json': 'nonempty-file', // real user file - must NOT be hidden
        '/repo/package.json': 'empty-file',
      }),
    });
    expect(entries).toEqual(['/.bashrc', '/package.json']);
    expect(entries).not.toContain('/.mcp.json');
  });

  test('skips git-tracked names', () => {
    const cwd = '/repo';
    const entries = computeExcludableStubs(cwd, {
      fileStubs: ['.gitconfig', '.bashrc'],
      dirStubs: [],
      isTracked: (abs) => abs === '/repo/.gitconfig',
      probe: () => 'absent',
    });
    expect(entries).toEqual(['/.bashrc']);
  });

  test('directory stubs get a trailing slash; non-empty dirs are excluded', () => {
    const cwd = '/repo';
    const entries = computeExcludableStubs(cwd, {
      fileStubs: [],
      dirStubs: ['.vscode', '.claude/commands'],
      probe: probeFor({
        '/repo/.vscode': 'empty-dir',
        '/repo/.claude/commands': 'nonempty-dir',
      }),
    });
    expect(entries).toEqual(['/.vscode/']);
  });
});
