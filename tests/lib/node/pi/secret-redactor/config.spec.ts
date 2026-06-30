/**
 * Tests for lib/node/pi/secret-redactor/config.ts.
 *
 * Touches disk (temp dirs only); agentDir + cwd are injected so the host
 * environment is never read.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { loadRedactorConfig } from '../../../../../lib/node/pi/secret-redactor/config.ts';

let root: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  root = join(tmpdir(), `secret-redactor-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  agentDir = join(root, 'agent');
  cwd = join(root, 'proj');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, '.pi'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const writeGlobal = (obj: unknown): void => writeFileSync(join(agentDir, 'secret-redactor.json'), JSON.stringify(obj));
const writeProject = (obj: unknown): void =>
  writeFileSync(join(cwd, '.pi', 'secret-redactor.json'), JSON.stringify(obj));

describe('loadRedactorConfig', () => {
  test('returns defaults when no config files exist', () => {
    const { config, warnings } = loadRedactorConfig(cwd, agentDir);
    expect(warnings).toEqual([]);
    expect(config.layers).toEqual({ prefixed: true, keyword: true });
    expect(config.keywordMinLength).toBe(8);
    expect(config.customRules).toEqual([]);
  });

  test('project layer overrides global', () => {
    writeGlobal({ layers: { keyword: false }, keywordMinLength: 12 });
    writeProject({ layers: { keyword: true } });
    const { config } = loadRedactorConfig(cwd, agentDir);

    expect(config.layers.keyword).toBe(true); // project wins
    expect(config.keywordMinLength).toBe(12); // global value retained
  });

  test('compiles a group-less custom rule as prefixed', () => {
    writeProject({ rules: [{ id: 'acme', pattern: 'ACME-[0-9a-f]{8}' }] });
    const { config } = loadRedactorConfig(cwd, agentDir);

    expect(config.customRules).toHaveLength(1);
    expect(config.customRules[0].kind).toBe('prefixed');
    expect(config.customRules[0].group).toBe(0);
    expect(config.customRules[0].re.flags).toContain('d');
  });

  test('compiles a captured custom rule as keyword (value-only)', () => {
    writeProject({ rules: [{ id: 'kv', pattern: 'mytok=([a-z0-9]{10,})' }] });
    const { config } = loadRedactorConfig(cwd, agentDir);

    expect(config.customRules[0].kind).toBe('keyword');
    expect(config.customRules[0].group).toBe(1);
  });

  test('warns and skips a rule with invalid regex', () => {
    writeProject({ rules: [{ id: 'bad', pattern: '([' }] });
    const { config, warnings } = loadRedactorConfig(cwd, agentDir);

    expect(config.customRules).toHaveLength(0);
    expect(warnings.some((w) => w.error.includes('invalid regex'))).toBe(true);
  });

  test('warns on a rule missing id / pattern', () => {
    writeProject({ rules: [{ pattern: 'abc' }, { id: 'x' }] });
    const { warnings } = loadRedactorConfig(cwd, agentDir);

    expect(warnings.some((w) => w.error.includes('missing a non-empty `id`'))).toBe(true);
    expect(warnings.some((w) => w.error.includes('missing a non-empty `pattern`'))).toBe(true);
  });

  test('compiles allowlist patterns and warns on a bad one', () => {
    writeProject({ allowlist: ['^OK-', '(['] });
    const { config, warnings } = loadRedactorConfig(cwd, agentDir);

    expect(config.allowlist).toHaveLength(1);
    expect(warnings.some((w) => w.error.includes('allowlist pattern'))).toBe(true);
  });

  test('warns when rules is not an array', () => {
    writeProject({ rules: 'nope' });
    const { warnings } = loadRedactorConfig(cwd, agentDir);
    expect(warnings.some((w) => w.error.includes('`rules` must be an array'))).toBe(true);
  });
});
