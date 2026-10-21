/**
 * Tests for lib/node/pi/bg-bash/shell.ts.
 */

import { spawnSync } from 'node:child_process';

import { describe, expect, test } from 'vitest';

import {
  bashOnlySyntaxWarning,
  detectBashOnlySyntax,
  shellSpawnArgs,
} from '../../../../../lib/node/pi/bg-bash/shell.ts';

describe('detectBashOnlySyntax', () => {
  test.each([
    ['npm run tsc | tail -5; echo "rc=${PIPESTATUS[0]}"', ['PIPESTATUS', 'arrays']],
    ['[[ -f x ]] && echo y', ['[[ ]]']],
    ['if [[ $a == b ]]; then :; fi', ['[[ ]]']],
    ['diff <(sort a) <(sort b)', ['process substitution']],
    ['tee >(gzip > out.gz)', ['process substitution']],
    ['files=(a b c); echo ${files[0]}', ['arrays']],
    ['declare -a xs', ['arrays']],
    ['make &>/dev/null', ['&> redirection']],
    ['make |& tee log', ['|& pipe']],
    ["printf $'a\\tb'", ["$'...' quoting"]],
    ['for i in {1..5}; do echo $i; done', ['brace range']],
    ['source ./env.sh && run', ['source']],
    ['shopt -s globstar', ['shopt']],
  ])('flags %s', (cmd, expected) => {
    expect(detectBashOnlySyntax(cmd)).toEqual(expected);
  });

  test.each([
    'npm test 2>&1 | tail -5',
    'x=$(git rev-parse HEAD); echo "$x"',
    '[ -f x ] && echo y',
    'git log --format=(%h) -1',
    'cat <<EOF\nhi\nEOF',
    'echo $((1 + 2))',
    'cmd > out.log 2>&1 &',
    '. ./env.sh',
    "jq '.[0].name' file.json",
  ])('does not flag POSIX command %s', (cmd) => {
    expect(detectBashOnlySyntax(cmd)).toEqual([]);
  });
});

describe('bashOnlySyntaxWarning', () => {
  test('warns under sh and names the constructs', () => {
    const w = bashOnlySyntaxWarning('a | b; echo ${PIPESTATUS[0]}; [[ x ]]', 'sh');
    expect(w).toContain('PIPESTATUS, [[ ]]');
    expect(w).toContain('shell: "bash"');
  });

  test('silent under bash or for POSIX commands', () => {
    expect(bashOnlySyntaxWarning('echo ${PIPESTATUS[0]}', 'bash')).toBeUndefined();
    expect(bashOnlySyntaxWarning('echo hi', 'sh')).toBeUndefined();
  });
});

describe('shellSpawnArgs', () => {
  test('maps each shell to its executable', () => {
    expect(shellSpawnArgs('sh', 'echo hi')).toEqual({ file: '/bin/sh', args: ['-c', 'echo hi'] });
    expect(shellSpawnArgs('bash', 'echo hi')).toEqual({ file: 'bash', args: ['-c', 'echo hi'] });
  });

  test('bash runs PIPESTATUS for real', () => {
    const { file, args } = shellSpawnArgs('bash', 'false | true; echo "rc=${PIPESTATUS[0]}"');
    const r = spawnSync(file, args, { encoding: 'utf8' });
    expect(r.stdout).toBe('rc=1\n');
  });
});
