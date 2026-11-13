/**
 * Contract tests for `config/agents/shell-permissions.jsonc`, the canonical
 * shell allowlist:
 *
 *   1. The committed per-harness files equal the generator output, so
 *      `config/agents/sync.ts generate` has been run after every edit.
 *   2. pi parity: pi's hand-written `config/pi/bash-permissions-example.json`
 *      is not generated, so every `shared` entry must be allowed there by
 *      pi's own matcher, and every `except` glob must not be.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { generateShellPermissionFiles, staleFiles } from '../../../lib/node/agents-config/generate.ts';
import { parseShellPermissions } from '../../../lib/node/agents-config/shell-permissions.ts';
import { matchesPattern } from '../../../lib/node/pi/bash/match.ts';
import { parseJsonc } from '../../../lib/node/pi/jsonc.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function readRepoFile(path: string): string | undefined {
  const abs = join(REPO_ROOT, path);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
}

const list = parseShellPermissions(readRepoFile('config/agents/shell-permissions.jsonc') ?? '');
const pi = parseJsonc<{ allow: string[]; deny: string[] }>(
  readRepoFile('config/pi/bash-permissions-example.json') ?? '',
);

function piAllows(command: string): boolean {
  return !pi.deny.some((p) => matchesPattern(command, p)) && pi.allow.some((p) => matchesPattern(command, p));
}

/**
 * Representative commands for a glob: a standalone `*` token becomes an
 * argument (`x`) and a glued `*` is dropped, plus the bare command for a
 * trailing ` *` (`git status *` -> `git status x`, `git status`).
 */
function samples(glob: string): string[] {
  const words = glob.split(' ').map((w) => (w === '*' ? 'x' : w.replaceAll('*', '')));
  const out = [words.join(' ')];
  if (glob.endsWith(' *')) out.push(words.slice(0, -1).join(' '));
  return out;
}

describe('shell-permissions: generated files', () => {
  test('committed files match `config/agents/sync.ts generate`', () => {
    const stale = staleFiles(generateShellPermissionFiles(readRepoFile)).map((f) => f.path);
    expect(stale, 'run: config/agents/sync.ts generate').toEqual([]);
  });
});

describe('shell-permissions: pi parity', () => {
  const shared = list.entries.filter((e) => e.tier === 'shared');

  test('the list has shared entries', () => {
    expect(shared.length).toBeGreaterThan(100);
  });

  test.each(shared.flatMap((e) => samples(e.pattern).map((cmd) => [e.pattern, cmd])))(
    '%s: pi allows `%s`',
    (_pattern, cmd) => {
      expect(piAllows(cmd)).toBe(true);
    },
  );

  test.each(shared.flatMap((e) => (e.except ?? []).flatMap((x) => samples(x).map((cmd) => [x, cmd]))))(
    'except %s: pi does not allow `%s`',
    (_glob, cmd) => {
      expect(piAllows(cmd)).toBe(false);
    },
  );
});
