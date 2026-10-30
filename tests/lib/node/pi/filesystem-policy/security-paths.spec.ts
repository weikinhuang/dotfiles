import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  pathSpellings,
  protectedSecurityPolicyPath,
  securityPolicyPaths,
  type SecurityPathsOptions,
} from '../../../../../lib/node/pi/filesystem-policy/security-paths.ts';

let root: string;
let cwd: string;
let home: string;
let options: SecurityPathsOptions;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-security-paths-'));
  cwd = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(cwd);
  mkdirSync(home);
  options = { env: {}, homeDir: home };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('securityPolicyPaths', () => {
  test('protects all user and project policies before config directories exist', () => {
    const paths = securityPolicyPaths(cwd, options);
    for (const name of ['sandbox.json', 'filesystem.json', 'bash-permissions.json']) {
      expect(paths).toContain(join(home, '.pi/agent', name));
      expect(paths).toContain(join(cwd, '.pi', name));
    }
    expect(paths).not.toContain(join(home, '.pi/agent/sessions'));
  });

  test('honors PI_CODING_AGENT_DIR and an explicitly injected agent dir', () => {
    const agentDir = join(root, 'custom-agent');
    const overridden = { ...options, env: { PI_CODING_AGENT_DIR: agentDir } };
    expect(securityPolicyPaths(cwd, overridden)).toContain(join(agentDir, 'sandbox.json'));
    expect(securityPolicyPaths(cwd, overridden)).not.toContain(join(home, '.pi/agent/sandbox.json'));
    expect(securityPolicyPaths(cwd, { ...overridden, agentDir: join(root, 'explicit') })).toContain(
      join(root, 'explicit/sandbox.json'),
    );
  });

  test('includes lexical and real paths through a symlinked agent directory with absent configs', () => {
    const target = join(root, 'target');
    mkdirSync(target);
    const alias = join(root, 'alias');
    symlinkSync(target, alias);
    const injected = { ...options, agentDir: join(alias, 'not-yet/agent') };
    const paths = securityPolicyPaths(cwd, injected);
    expect(paths).toContain(join(alias, 'not-yet/agent/filesystem.json'));
    expect(paths).toContain(join(realpathSync(target), 'not-yet/agent/filesystem.json'));
    expect(protectedSecurityPolicyPath(join(target, 'not-yet/agent/filesystem.json'), cwd, injected)).toBeDefined();
  });

  test('protects config targets reached by symlinks, including dangling file links', () => {
    mkdirSync(join(cwd, '.pi'));
    const target = join(root, 'actual-policy');
    writeFileSync(target, '{}');
    symlinkSync(target, join(cwd, '.pi/sandbox.json'));
    const alias = join(root, 'other-alias');
    symlinkSync(target, alias);
    expect(securityPolicyPaths(cwd, options)).toContain(realpathSync(target));
    expect(protectedSecurityPolicyPath(alias, cwd, options)).toBeDefined();
    expect(protectedSecurityPolicyPath(target, cwd, options)).toBeDefined();

    const missing = join(root, 'missing/permissions');
    symlinkSync(missing, join(cwd, '.pi/bash-permissions.json'));
    expect(securityPolicyPaths(cwd, options)).toContain(join(realpathSync(root), 'missing/permissions'));
    expect(protectedSecurityPolicyPath(missing, cwd, options)).toBeDefined();
  });

  test('matches descendants and ancestor replacement, not siblings or ordinary state', () => {
    for (const path of ['.pi', '.pi/filesystem.json', '.pi/filesystem.json/child']) {
      expect(protectedSecurityPolicyPath(join(cwd, path), cwd, options)).toBeDefined();
    }
    for (const path of ['.pi/sessions/a.jsonl', '.pi/todo.json', '.pi/filesystem.json.bak', 'src/sandbox.json']) {
      expect(protectedSecurityPolicyPath(join(cwd, path), cwd, options)).toBeUndefined();
    }
    expect(protectedSecurityPolicyPath(join(home, '.pi/agent/sessions/a.jsonl'), cwd, options)).toBeUndefined();
  });

  test('paths containing glob syntax are literal names, not patterns', () => {
    const agentDir = join(root, 'agent[*]?');
    const injected = { ...options, agentDir };
    expect(protectedSecurityPolicyPath(join(agentDir, 'sandbox.json'), cwd, injected)).toBeDefined();
    expect(protectedSecurityPolicyPath(join(root, 'agentX/sandbox.json'), cwd, injected)).toBeUndefined();
  });

  test('pathSpellings deduplicates canonical concrete names', () => {
    const physical = realpathSync(root);
    expect(pathSpellings(physical)).toEqual([physical]);
  });
});
