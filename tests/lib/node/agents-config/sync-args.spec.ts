import { describe, expect, test } from 'vitest';

import { HARNESS_NAMES, parseSyncArgs } from '../../../../lib/node/agents-config/sync-args.ts';

const ALL = [...HARNESS_NAMES];

describe('parseSyncArgs', () => {
  test.each([
    [['generate'], { command: 'generate', check: false }],
    [['generate', '--check'], { command: 'generate', check: true }],
    [['--check', 'generate'], { command: 'generate', check: true }],
    [['-h'], { command: 'help' }],
    [['generate', '--help'], { command: 'help' }],
    [[], { command: 'diff', harnesses: ALL, force: false }],
    [['diff'], { command: 'diff', harnesses: ALL, force: false }],
    [['apply', '--force'], { command: 'apply', harnesses: ALL, force: true }],
    [['--harness', 'pi'], { command: 'diff', harnesses: ['pi'], force: false }],
    [
      ['apply', '--harness=codex,claude', '--harness', 'codex'],
      { command: 'apply', harnesses: ['codex', 'claude'], force: false },
    ],
    [['diff', '--harness', 'skills'], { command: 'diff', harnesses: ['skills'], force: false }],
  ])('%j', (argv, expected) => {
    expect(parseSyncArgs(argv)).toEqual(expected);
  });

  test.each([
    [['sync'], 'Unknown command: sync'],
    [['generate', '--force'], '--force only applies to diff / apply'],
    [['generate', '--harness', 'pi'], '--harness only applies to diff / apply'],
    [['diff', '--check'], '--check only applies to generate'],
    [['diff', '--harness'], 'Missing value for --harness'],
    [['diff', '--harness', 'vim'], 'Unknown harness: vim'],
    [['diff', '--bogus'], 'Unknown option: --bogus'],
    [['generate', 'extra'], 'Unexpected argument: extra'],
  ])('%j throws %s', (argv, message) => {
    expect(() => parseSyncArgs(argv)).toThrow(message);
  });
});
