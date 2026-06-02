/**
 * Tests for lib/node/pi/bg-bash/config.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  bgBashEnvLayer,
  coerceBgBashConfigLayer,
  DEFAULT_BG_BASH_CONFIG,
  loadBgBashConfig,
  mergeBgBashConfigLayers,
} from '../../../../../lib/node/pi/bg-bash/config.ts';

describe('coerceBgBashConfigLayer', () => {
  test('keeps well-typed fields and drops wrong-typed ones', () => {
    const out = coerceBgBashConfigLayer({
      timeoutMs: 30000,
      stream: 'stdout',
      maxBytes: 8192,
      tail: 20,
      maxBufferBytes: 2048,
      killGraceMs: 5000,
      maxInjectedChars: 2000,
      bogus: true,
    });
    expect(out).toEqual({
      timeoutMs: 30000,
      stream: 'stdout',
      maxBytes: 8192,
      tail: 20,
      maxBufferBytes: 2048,
      killGraceMs: 5000,
      maxInjectedChars: 2000,
    });
  });

  test('rejects an unknown stream and out-of-range numbers', () => {
    expect(coerceBgBashConfigLayer({ stream: 'both' }).stream).toBeUndefined();
    expect(coerceBgBashConfigLayer({ maxBytes: 0 }).maxBytes).toBeUndefined();
    expect(coerceBgBashConfigLayer({ maxInjectedChars: 100 }).maxInjectedChars).toBeUndefined();
    // tail and the *Ms knobs allow zero.
    expect(coerceBgBashConfigLayer({ tail: 0, timeoutMs: 0, killGraceMs: 0 })).toEqual({
      tail: 0,
      timeoutMs: 0,
      killGraceMs: 0,
    });
  });

  test('non-object input yields an empty layer', () => {
    expect(coerceBgBashConfigLayer(null)).toEqual({});
    expect(coerceBgBashConfigLayer('str')).toEqual({});
    expect(coerceBgBashConfigLayer([1])).toEqual({});
  });
});

describe('bgBashEnvLayer', () => {
  test('reads the three operational knobs from env', () => {
    const out = bgBashEnvLayer({
      PI_BG_BASH_MAX_BUFFER_BYTES: '4096',
      PI_BG_BASH_KILL_GRACE_MS: '1000',
      PI_BG_BASH_MAX_INJECTED_CHARS: '900',
    });
    expect(out).toEqual({ maxBufferBytes: 4096, killGraceMs: 1000, maxInjectedChars: 900 });
  });

  test('drops invalid / below-floor env values', () => {
    expect(bgBashEnvLayer({ PI_BG_BASH_MAX_INJECTED_CHARS: '100' }).maxInjectedChars).toBeUndefined();
    expect(bgBashEnvLayer({ PI_BG_BASH_KILL_GRACE_MS: 'soon' }).killGraceMs).toBeUndefined();
    expect(bgBashEnvLayer({})).toEqual({});
  });

  test('does not read the per-call defaults from env', () => {
    expect(bgBashEnvLayer({ PI_BG_BASH_TIMEOUT_MS: '1' })).toEqual({});
  });
});

describe('mergeBgBashConfigLayers', () => {
  test('no layers returns the built-in defaults', () => {
    expect(mergeBgBashConfigLayers()).toEqual(DEFAULT_BG_BASH_CONFIG);
  });

  test('higher layers override lower ones field by field', () => {
    const out = mergeBgBashConfigLayers({ timeoutMs: 1000, maxBytes: 100 }, { maxBytes: 200, stream: 'stderr' });
    expect(out.timeoutMs).toBe(1000);
    expect(out.maxBytes).toBe(200);
    expect(out.stream).toBe('stderr');
  });
});

describe('loadBgBashConfig', () => {
  let agentDir: string;
  let cwd: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'bgbash-agent-'));
    cwd = mkdtempSync(join(tmpdir(), 'bgbash-cwd-'));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const writeUser = (config: unknown): void => writeFileSync(join(agentDir, 'bg-bash.json'), JSON.stringify(config));
  const writeProject = (config: unknown): void => {
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'bg-bash.json'), JSON.stringify(config));
  };

  test('with no files and no env returns the built-in defaults', () => {
    expect(loadBgBashConfig(cwd, {})).toEqual(DEFAULT_BG_BASH_CONFIG);
  });

  test('project config beats user config beats env knob beats built-in', () => {
    writeUser({ timeoutMs: 20000, maxBytes: 1000, killGraceMs: 7000 });
    writeProject({ timeoutMs: 30000 });
    const config = loadBgBashConfig(cwd, { PI_BG_BASH_KILL_GRACE_MS: '1111', PI_BG_BASH_MAX_BUFFER_BYTES: '5000' });
    // project wins for timeoutMs
    expect(config.timeoutMs).toBe(30000);
    // user wins for maxBytes (project omits it) and killGraceMs (over env)
    expect(config.maxBytes).toBe(1000);
    expect(config.killGraceMs).toBe(7000);
    // env wins for maxBufferBytes (no file sets it)
    expect(config.maxBufferBytes).toBe(5000);
    // built-in for the rest
    expect(config.stream).toBe(DEFAULT_BG_BASH_CONFIG.stream);
  });

  test('malformed files degrade to env + defaults', () => {
    writeFileSync(join(agentDir, 'bg-bash.json'), '{ not json');
    expect(loadBgBashConfig(cwd, {})).toEqual(DEFAULT_BG_BASH_CONFIG);
  });
});
