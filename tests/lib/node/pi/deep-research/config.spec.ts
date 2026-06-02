/**
 * Tests for lib/node/pi/deep-research/config.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  applyDeepResearchDefaults,
  coerceDeepResearchConfigLayer,
  type DeepResearchConfigWarning,
  loadDeepResearchConfig,
  mergeDeepResearchConfigLayers,
} from '../../../../../lib/node/pi/deep-research/config.ts';

describe('coerceDeepResearchConfigLayer', () => {
  test('validates known fields through the tool-override validator', () => {
    const warnings: DeepResearchConfigWarning[] = [];
    const out = coerceDeepResearchConfigLayer(
      { fanoutModel: 'ollama/qwen', fanoutParallel: 1, wallClockSec: 7200, fanoutMaxTurns: 30 },
      'x.json',
      warnings,
    );
    expect(warnings).toEqual([]);
    expect(out).toEqual({ fanoutModel: 'ollama/qwen', fanoutParallel: 1, wallClockSec: 7200, fanoutMaxTurns: 30 });
  });

  test('a malformed field warns and drops the whole layer', () => {
    const warnings: DeepResearchConfigWarning[] = [];
    const out = coerceDeepResearchConfigLayer({ fanoutModel: 'no-slash' }, 'x.json', warnings);
    expect(out).toEqual({});
    expect(warnings.length).toBe(1);
    expect(warnings[0].path).toBe('x.json');
  });

  test('undefined layer is empty with no warning; non-object warns', () => {
    const w1: DeepResearchConfigWarning[] = [];
    expect(coerceDeepResearchConfigLayer(undefined, 'x.json', w1)).toEqual({});
    expect(w1).toEqual([]);

    const w2: DeepResearchConfigWarning[] = [];
    expect(coerceDeepResearchConfigLayer('nope', 'x.json', w2)).toEqual({});
    expect(w2.length).toBe(1);
  });
});

describe('mergeDeepResearchConfigLayers / applyDeepResearchDefaults', () => {
  test('higher layers override lower ones field by field', () => {
    const out = mergeDeepResearchConfigLayers({ model: 'a/x', fanoutMaxTurns: 10 }, { model: 'b/y' });
    expect(out.model).toBe('b/y');
    expect(out.fanoutMaxTurns).toBe(10);
  });

  test('per-call override wins over the config default', () => {
    const out = applyDeepResearchDefaults({ fanoutModel: 'cfg/m', wallClockSec: 100 }, { fanoutModel: 'call/m' });
    expect(out.fanoutModel).toBe('call/m');
    expect(out.wallClockSec).toBe(100);
  });
});

describe('loadDeepResearchConfig', () => {
  let agentDir: string;
  let cwd: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'dr-agent-'));
    cwd = mkdtempSync(join(tmpdir(), 'dr-cwd-'));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const writeUser = (config: unknown): void =>
    writeFileSync(join(agentDir, 'deep-research.json'), JSON.stringify(config));
  const writeProject = (config: unknown): void => {
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'deep-research.json'), JSON.stringify(config));
  };

  test('with no files returns empty defaults', () => {
    expect(loadDeepResearchConfig(cwd)).toEqual({ defaults: {}, warnings: [] });
  });

  test('project config layers over user config', () => {
    writeUser({ fanoutModel: 'user/m', wallClockSec: 100 });
    writeProject({ fanoutModel: 'project/m' });
    const { defaults, warnings } = loadDeepResearchConfig(cwd);
    expect(warnings).toEqual([]);
    expect(defaults.fanoutModel).toBe('project/m');
    expect(defaults.wallClockSec).toBe(100);
  });

  test('malformed JSON degrades to empty defaults without throwing', () => {
    writeFileSync(join(agentDir, 'deep-research.json'), '{ not json');
    expect(loadDeepResearchConfig(cwd).defaults).toEqual({});
  });

  test('a bad field surfaces a warning', () => {
    writeProject({ fanoutParallel: -3 });
    const { defaults, warnings } = loadDeepResearchConfig(cwd);
    expect(defaults).toEqual({});
    expect(warnings.length).toBe(1);
  });
});
