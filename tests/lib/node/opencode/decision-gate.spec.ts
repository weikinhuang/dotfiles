/**
 * Tests for lib/node/opencode/decision-gate.ts.
 */

import { expect, test } from 'vitest';

import {
  AskTracker,
  askKey,
  CommandStash,
  type EvaluateEventLike,
  replyOutcome,
  resolveDecisionGateConfig,
  shellGateInputFor,
} from '../../../../lib/node/opencode/decision-gate.ts';

function event(over: Partial<EvaluateEventLike> = {}): EvaluateEventLike {
  return { sessionID: 's1', action: 'shell', resources: ['npm test'], effect: 'ask', ...over };
}

test('resolveDecisionGateConfig: defaults under the config dir; env beats options', () => {
  expect(resolveDecisionGateConfig(undefined, {}, '/cfg')).toEqual({
    enabled: true,
    configPath: '/cfg/decision-model.json',
    defaultLogPath: '/cfg/decision-model.jsonl',
    trace: undefined,
  });
  const cfg = resolveDecisionGateConfig(
    { enabled: true, config: '/opt/dm.json' },
    { OPENCODE_DECISION_GATE_ENABLED: '0', OPENCODE_DECISION_GATE_TRACE: '/tmp/t.log' },
    '/cfg',
  );
  expect(cfg).toMatchObject({ enabled: false, configPath: '/opt/dm.json', trace: '/tmp/t.log' });
});

test('shellGateInputFor: only shell asks qualify; explicit allow / deny stand', () => {
  expect(shellGateInputFor(event(), '/repo')).toEqual({
    command: 'npm test',
    unresolved: ['npm test'],
    cwd: '/repo',
    sessionId: 's1',
  });
  expect(shellGateInputFor(event({ effect: 'allow' }), '/repo')).toBeUndefined();
  expect(shellGateInputFor(event({ effect: 'deny' }), '/repo')).toBeUndefined();
  expect(shellGateInputFor(event({ action: 'edit' }), '/repo')).toBeUndefined();
  expect(shellGateInputFor(event({ resources: [] }), '/repo')).toBeUndefined();
});

test('shellGateInputFor: prefers the full command and cwd from metadata', () => {
  const input = shellGateInputFor(
    event({
      resources: ['git add -A', 'git commit -m x'],
      metadata: { command: 'git add -A && git commit -m x', cwd: '/repo/sub' },
    }),
    '/repo',
  );
  expect(input).toMatchObject({ command: 'git add -A && git commit -m x', cwd: '/repo/sub' });
  const joined = shellGateInputFor(event({ resources: ['a', 'b'], metadata: { command: 3 } }), '/repo', undefined);
  expect(joined?.command).toBe('a\nb');
});

test('shellGateInputFor: a stashed call supplies the full command line', () => {
  const input = shellGateInputFor(event({ resources: ['touch a', 'ls a', 'wc -l'] }), '/repo', {
    command: 'touch a && ls a | wc -l',
  });
  expect(input?.command).toBe('touch a && ls a | wc -l');
  expect(input?.unresolved).toEqual(['touch a', 'ls a', 'wc -l']);
});

test('CommandStash: finds the newest call containing every part, per session', () => {
  const stash = new CommandStash();
  stash.record('s1', { command: 'npm   test' });
  stash.record('s1', { command: 'git add -A && git commit -m wip' });
  stash.record('s2', { command: 'rm -rf dist' });
  stash.record('s1', { nope: true });
  stash.record('s1', 'not an object');

  expect(stash.find('s1', ['git add -A', 'git commit -m wip'])?.command).toBe('git add -A && git commit -m wip');
  expect(stash.find('s1', ['npm test'])?.command).toBe('npm   test'); // whitespace-insensitive
  expect(stash.find('s1', ['rm -rf dist'])).toBeUndefined(); // other session
  expect(stash.find('s1', ['git add -A', 'rm -rf dist'])).toBeUndefined(); // parallel call: no mix-up
});

test('CommandStash: keeps only recent calls', () => {
  const stash = new CommandStash();
  for (let i = 0; i < 12; i++) stash.record('s1', { command: `echo ${i}` });
  expect(stash.find('s1', ['echo 0'])).toBeUndefined();
  expect(stash.find('s1', ['echo 11'])?.command).toBe('echo 11');
});

test('replyOutcome: once / always allow, reject denies', () => {
  expect(replyOutcome('once')).toBe('allow');
  expect(replyOutcome('always')).toBe('allow');
  expect(replyOutcome('reject')).toBe('deny');
  expect(replyOutcome('later')).toBeUndefined();
});

test('AskTracker: links evaluate -> asked -> replied exactly once', () => {
  const t = new AskTracker();
  const key = askKey('s1', 'shell', ['rm -rf dist']);
  t.abstained(key, 'd1');
  t.asked(askKey('s2', 'shell', ['rm -rf dist']), 'p0'); // different session: no link
  t.asked(key, 'p1');
  expect(t.replied('p0')).toBeUndefined();
  expect(t.replied('p1')).toBe('d1');
  expect(t.replied('p1')).toBeUndefined();
});

test('AskTracker: bounded, oldest entries drop', () => {
  const t = new AskTracker();
  for (let i = 0; i < 250; i++) t.abstained(`k${i}`, `d${i}`);
  t.asked('k0', 'p0');
  t.asked('k249', 'p249');
  expect(t.replied('p0')).toBeUndefined();
  expect(t.replied('p249')).toBe('d249');
});
