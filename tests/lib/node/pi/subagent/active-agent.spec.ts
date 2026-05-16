/**
 * Tests for `lib/node/pi/subagent/active-agent.ts` - globalThis-anchored
 * cross-extension singleton tracking the currently-running child agent.
 */

import { afterEach, describe, expect, test } from 'vitest';

import { clearActiveAgent, getActiveAgent, setActiveAgent } from '../../../../../lib/node/pi/subagent/active-agent.ts';

afterEach(() => {
  clearActiveAgent();
});

describe('active-agent singleton', () => {
  test('returns undefined before any agent is set', () => {
    expect(getActiveAgent()).toBeUndefined();
  });

  test('setActiveAgent stores name + writeRoots + bash lists + requestOptions', () => {
    setActiveAgent({
      name: 'plan',
      resolvedWriteRoots: ['/repo/plans/'],
      bashAllow: ['rg *'],
      bashDeny: ['curl *'],
      requestOptions: { temperature: 0.7 },
    });
    const got = getActiveAgent();

    expect(got?.name).toBe('plan');
    expect(got?.resolvedWriteRoots).toEqual(['/repo/plans/']);
    expect(got?.bashAllow).toEqual(['rg *']);
    expect(got?.bashDeny).toEqual(['curl *']);
    expect(got?.requestOptions).toEqual({ temperature: 0.7 });
  });

  test('list fields default to empty arrays when omitted; requestOptions stays undefined', () => {
    setActiveAgent({ name: 'plan', resolvedWriteRoots: [] });
    const got = getActiveAgent();

    expect(got?.bashAllow).toEqual([]);
    expect(got?.bashDeny).toEqual([]);
    expect(got?.requestOptions).toBeUndefined();
  });

  test('clearActiveAgent / passing undefined → singleton goes away', () => {
    setActiveAgent({ name: 'plan', resolvedWriteRoots: [] });
    clearActiveAgent();

    expect(getActiveAgent()).toBeUndefined();

    setActiveAgent({ name: 'plan', resolvedWriteRoots: [] });
    setActiveAgent(undefined);

    expect(getActiveAgent()).toBeUndefined();
  });

  test('list fields are defensively copied + frozen', () => {
    const allow = ['rg *'];
    const deny = ['curl *'];
    const roots = ['/repo/plans/'];
    setActiveAgent({ name: 'plan', resolvedWriteRoots: roots, bashAllow: allow, bashDeny: deny });
    allow.push('ls *');
    roots.push('/tmp/');
    deny.push('node *');

    expect(getActiveAgent()?.bashAllow).toEqual(['rg *']);
    expect(getActiveAgent()?.resolvedWriteRoots).toEqual(['/repo/plans/']);
    expect(getActiveAgent()?.bashDeny).toEqual(['curl *']);

    expect(() => {
      (getActiveAgent()?.bashAllow as string[]).push('evil');
    }).toThrow();
  });

  test('replacing an active snapshot overwrites every field', () => {
    setActiveAgent({
      name: 'plan',
      resolvedWriteRoots: ['/repo/plans/'],
      bashAllow: ['rg *'],
      bashDeny: ['curl *'],
      requestOptions: { temperature: 0.7 },
    });
    setActiveAgent({ name: 'review', resolvedWriteRoots: ['/repo/reviews/'] });

    expect(getActiveAgent()).toEqual({
      name: 'review',
      resolvedWriteRoots: ['/repo/reviews/'],
      bashAllow: [],
      bashDeny: [],
      requestOptions: undefined,
    });
  });
});
