/**
 * Tests for lib/node/pi/pi-paths.ts.
 */

import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  cwdSlug,
  piAgentDir,
  piAgentPath,
  piProjectDir,
  piProjectPath,
  slugFromEnv,
} from '../../../../lib/node/pi/pi-paths.ts';

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

describe('cwdSlug', () => {
  test('nested posix path', () => {
    expect(cwdSlug('/mnt/d/whuang/Documents/Projects/github.com/weikinhuang/dotfiles')).toBe(
      '--mnt-d-whuang-Documents-Projects-github.com-weikinhuang-dotfiles--',
    );
  });

  test('/tmp', () => {
    expect(cwdSlug('/tmp')).toBe('--tmp--');
  });

  test('trailing slash is stripped', () => {
    expect(cwdSlug('/tmp/')).toBe('--tmp--');
    expect(cwdSlug('/tmp/pi-test/')).toBe('--tmp-pi-test--');
  });

  test('root slash', () => {
    expect(cwdSlug('/')).toBe('----');
  });

  test('home-style path', () => {
    expect(cwdSlug('/home/whuang/.pi')).toBe('--home-whuang-.pi--');
  });
});

describe('slugFromEnv', () => {
  test('falls back to cwdSlug when the override is undefined/blank', () => {
    expect(slugFromEnv(undefined, '/tmp/pi-test')).toBe('--tmp-pi-test--');
    expect(slugFromEnv('', '/tmp/pi-test')).toBe('--tmp-pi-test--');
    expect(slugFromEnv('   ', '/tmp/pi-test')).toBe('--tmp-pi-test--');
  });

  test('uses a non-empty override verbatim (trimmed), regardless of cwd', () => {
    expect(slugFromEnv('rp', '/tmp/pi-test')).toBe('rp');
    expect(slugFromEnv('  rp  ', '/renamed/elsewhere')).toBe('rp');
  });
});
