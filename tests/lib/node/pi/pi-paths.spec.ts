/**
 * Tests for lib/node/pi/pi-paths.ts.
 */

import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { piAgentDir, piAgentPath, piProjectDir, piProjectPath } from '../../../../lib/node/pi/pi-paths.ts';

describe('piAgentDir', () => {
  test('defaults to <home>/.pi/agent', () => {
    expect(piAgentDir({}, '/home/u')).toBe('/home/u/.pi/agent');
  });

  test('honors PI_CODING_AGENT_DIR', () => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: '/custom/dir' }, '/home/u')).toBe('/custom/dir');
  });

  test('trims whitespace from the override', () => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: '  /custom/dir  ' }, '/home/u')).toBe('/custom/dir');
  });

  test('falls back to default when override is empty/whitespace', () => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: '' }, '/home/u')).toBe('/home/u/.pi/agent');
    expect(piAgentDir({ PI_CODING_AGENT_DIR: '   ' }, '/home/u')).toBe('/home/u/.pi/agent');
  });

  test('reads from process.env when no env arg is supplied', () => {
    const original = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = '/from-process-env';
      expect(piAgentDir()).toBe('/from-process-env');
    } finally {
      if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = original;
    }
  });
});

describe('piAgentPath', () => {
  test('joins segments under the agent dir', () => {
    const original = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = '/agent';
      expect(piAgentPath('foo.json')).toBe('/agent/foo.json');
      expect(piAgentPath('agents', 'plan.md')).toBe('/agent/agents/plan.md');
      expect(piAgentPath()).toBe('/agent');
    } finally {
      if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = original;
    }
  });
});

describe('piProjectDir', () => {
  test('returns <cwd>/.pi', () => {
    expect(piProjectDir('/repo')).toBe('/repo/.pi');
    expect(piProjectDir('/repo/sub')).toBe('/repo/sub/.pi');
  });
});

describe('piProjectPath', () => {
  test('joins segments under the project pi dir', () => {
    expect(piProjectPath('/repo', 'foo.json')).toBe(join('/repo', '.pi', 'foo.json'));
    expect(piProjectPath('/repo', 'agents', 'plan.md')).toBe(join('/repo', '.pi', 'agents', 'plan.md'));
    expect(piProjectPath('/repo')).toBe('/repo/.pi');
  });
});
