/**
 * Covers resolveCwd (lib/node/pi/bg-bash/resolve-cwd.ts) - the `start`
 * action's working-directory resolver, including the leading-`~`
 * expansion that used to be a hand-rolled homedir() join.
 */

import { expect, test } from 'vitest';

import { resolveCwd } from '../../../../../lib/node/pi/bg-bash/resolve-cwd.ts';

const HOME = '/home/dev';
const AGENT = '/work/proj';

test('resolveCwd: no supplied cwd returns the agent cwd', () => {
  expect(resolveCwd(AGENT, undefined, HOME)).toBe(AGENT);
  expect(resolveCwd(AGENT, '', HOME)).toBe(AGENT);
});

test('resolveCwd: absolute path is returned verbatim', () => {
  expect(resolveCwd(AGENT, '/etc/nginx', HOME)).toBe('/etc/nginx');
});

test('resolveCwd: bare tilde expands to home', () => {
  expect(resolveCwd(AGENT, '~', HOME)).toBe(HOME);
});

test('resolveCwd: ~/sub expands against home and normalizes', () => {
  expect(resolveCwd(AGENT, '~/src/app', HOME)).toBe('/home/dev/src/app');
  expect(resolveCwd(AGENT, '~/a/../b', HOME)).toBe('/home/dev/b');
});

test('resolveCwd: relative path joins onto the agent cwd', () => {
  expect(resolveCwd(AGENT, 'sub/dir', HOME)).toBe('/work/proj/sub/dir');
  expect(resolveCwd(AGENT, '../sibling', HOME)).toBe('/work/sibling');
});

test('resolveCwd: ~user form is not expanded (falls through to relative join)', () => {
  expect(resolveCwd(AGENT, '~bob/x', HOME)).toBe('/work/proj/~bob/x');
});
