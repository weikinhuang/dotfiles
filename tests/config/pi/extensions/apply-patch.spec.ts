/**
 * Tests for `config/pi/extensions/apply-patch.ts` — the `apply_patch`
 * tool's pi-coupled shell. Mirrors the extension's execute pipeline
 * inline so the spec runs without a pi runtime (same pattern as
 * `hooks.spec.ts` / `filesystem.spec.ts` / `sandbox.spec.ts`).
 *
 * Coverage:
 *   - Happy path: a multi-op patch (Add + Update) lands on disk via
 *     atomic-write; file bytes match the patch intent.
 *   - Hunk-mismatch: the tool returns isError with the recovery block
 *     as a second text part and writes nothing.
 *
 * Plan: phase 3 of `plans/pi-cc-parity.md`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { applyPatch, type ReadFile, type WritePlan } from '../../../../lib/node/pi/apply-patch/apply.ts';
import { parsePatch } from '../../../../lib/node/pi/apply-patch/parse.ts';
import { atomicWriteFile } from '../../../../lib/node/pi/atomic-write.ts';

// ──────────────────────────────────────────────────────────────────────
// Inline mirror of the extension's execute pipeline.
// ──────────────────────────────────────────────────────────────────────
//
// The real extension also runs a filesystem-policy gate per write —
// covered by `filesystem.spec.ts` against the same library helpers —
// and we skip it here so the test focuses on the parse → apply → commit
// path. If the extension's pipeline grows new branches, mirror them
// here so the spec stays representative.

interface TextPart {
  type: 'text';
  text: string;
}

interface ToolResult {
  content: TextPart[];
  isError?: boolean;
}

function buildReadFile(cwd: string): ReadFile {
  return (path) => {
    const absolute = path.startsWith('/') ? path : join(cwd, path);
    try {
      return readFileSync(absolute, 'utf8');
    } catch {
      return null;
    }
  };
}

function commitPlan(cwd: string, plan: WritePlan): void {
  for (const fromPath of plan.moves.keys()) {
    const absolute = fromPath.startsWith('/') ? fromPath : join(cwd, fromPath);
    rmSync(absolute, { force: true });
  }
  for (const [path, content] of plan.writes) {
    const absolute = path.startsWith('/') ? path : join(cwd, path);
    atomicWriteFile(absolute, content);
  }
  for (const path of plan.deletes) {
    const absolute = path.startsWith('/') ? path : join(cwd, path);
    rmSync(absolute, { force: true });
  }
}

function executeApplyPatchMirror(cwd: string, patchInput: string): ToolResult {
  const parsed = parsePatch(patchInput);
  if ('error' in parsed) {
    return {
      content: [
        { type: 'text', text: `apply_patch: parse error at line ${parsed.error.line}: ${parsed.error.message}` },
      ],
      isError: true,
    };
  }
  const result = applyPatch(parsed.patch, buildReadFile(cwd));
  if ('errors' in result) {
    const summary = result.errors.map((e) => `  • op[${e.opIndex}]: ${e.message}`).join('\n');
    const recoveryBlocks = result.errors.flatMap((e) => (e.recovery ? [e.recovery] : []));
    const errorText = `apply_patch: ${result.errors.length} op error(s):\n${summary}`;
    const content: TextPart[] = [{ type: 'text', text: errorText }];
    if (recoveryBlocks.length > 0) content.push({ type: 'text', text: `\n${recoveryBlocks.join('\n\n')}` });
    return { content, isError: true };
  }
  commitPlan(cwd, result.plan);
  return {
    content: [{ type: 'text', text: `apply_patch: applied ${parsed.patch.ops.length} op(s)` }],
  };
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

describe('apply-patch extension shell', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi-apply-patch-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('happy path: multi-op patch (Add + Update) lands on disk', () => {
    // Seed an existing file to update.
    mkdirSync(join(cwd, 'src'), { recursive: true });
    const original = ['export function greet(name: string): string {', '  return `Hello, ${name}!`;', '}', ''].join(
      '\n',
    );
    writeFileSync(join(cwd, 'src', 'greet.ts'), original, 'utf8');

    const patch = [
      '*** Begin Patch',
      '*** Add File: src/lib.ts',
      "+export const VERSION = '1.0.0';",
      '+',
      '*** Update File: src/greet.ts',
      '@@',
      ' export function greet(name: string): string {',
      '-  return `Hello, ${name}!`;',
      '+  return `Hi, ${name}!`;',
      ' }',
      '*** End Patch',
    ].join('\n');

    const result = executeApplyPatchMirror(cwd, patch);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('applied 2 op(s)');

    // Add: new file matches the +-prefixed lines, joined with \n.
    const added = readFileSync(join(cwd, 'src', 'lib.ts'), 'utf8');
    expect(added).toBe("export const VERSION = '1.0.0';\n");

    // Update: greet.ts replaced "Hello" with "Hi".
    const updated = readFileSync(join(cwd, 'src', 'greet.ts'), 'utf8');
    expect(updated).toBe(
      ['export function greet(name: string): string {', '  return `Hi, ${name}!`;', '}', ''].join('\n'),
    );
  });

  test('hunk-mismatch: returns isError + recovery block as second text part; writes nothing', () => {
    writeFileSync(join(cwd, 'foo.ts'), ['const x = 1;', 'const y = 2;', ''].join('\n'), 'utf8');

    // Patch's context line `const ZZZ = 99;` does not appear in foo.ts,
    // so the hunk locator returns no-match.
    const patch = [
      '*** Begin Patch',
      '*** Update File: foo.ts',
      '@@',
      ' const ZZZ = 99;',
      '-const y = 2;',
      '+const y = 3;',
      '*** End Patch',
    ].join('\n');

    const result = executeApplyPatchMirror(cwd, patch);

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(2);
    expect(result.content[0]?.text).toContain('apply_patch: 1 op error(s)');
    expect(result.content[0]?.text).toContain('hunk[0]');

    // Recovery block is the second text part; format-recovery emits
    // the `apply-patch op[i] (Update File: …), hunk[j]` heading.
    const recovery = result.content[1]?.text ?? '';
    expect(recovery).toContain('apply-patch op[0] (Update File: foo.ts), hunk[0]');
    expect(recovery).toMatch(/foo\.ts/);

    // Nothing on disk changed.
    expect(readFileSync(join(cwd, 'foo.ts'), 'utf8')).toBe(['const x = 1;', 'const y = 2;', ''].join('\n'));
  });

  test('atomicity: a multi-op patch with one bad hunk leaves the good op unwritten', () => {
    writeFileSync(join(cwd, 'foo.ts'), ['existing\n'].join('\n'), 'utf8');

    // Add bar.ts (would succeed alone) + Update foo.ts with bad hunk.
    const patch = [
      '*** Begin Patch',
      '*** Add File: bar.ts',
      '+export const bar = true;',
      '*** Update File: foo.ts',
      '@@',
      ' nonexistent context line',
      '-existing',
      '+modified',
      '*** End Patch',
    ].join('\n');

    const result = executeApplyPatchMirror(cwd, patch);

    expect(result.isError).toBe(true);
    // The good op did NOT land on disk — that's the atomicity guarantee.
    expect(() => readFileSync(join(cwd, 'bar.ts'), 'utf8')).toThrow(/ENOENT/);
    expect(readFileSync(join(cwd, 'foo.ts'), 'utf8')).toBe('existing\n');
  });
});
