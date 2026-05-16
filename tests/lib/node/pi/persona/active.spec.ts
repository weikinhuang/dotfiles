import { afterEach, describe, expect, test } from 'vitest';

import { clearActivePersona, getActivePersona, setActivePersona } from '../../../../../lib/node/pi/persona/active.ts';

afterEach(() => {
  clearActivePersona();
});

describe('active-persona singleton', () => {
  test('returns undefined before any persona is set', () => {
    expect(getActivePersona()).toBeUndefined();
  });

  test('setActivePersona stores name + writeRoots + bash lists', () => {
    setActivePersona({
      name: 'plan',
      resolvedWriteRoots: ['/repo/plans/'],
      bashAllow: ['rg *'],
      bashDeny: ['curl *'],
    });
    const got = getActivePersona();

    expect(got?.name).toBe('plan');
    expect(got?.resolvedWriteRoots).toEqual(['/repo/plans/']);
    expect(got?.bashAllow).toEqual(['rg *']);
    expect(got?.bashDeny).toEqual(['curl *']);
  });

  test('bash lists default to empty arrays when omitted', () => {
    setActivePersona({ name: 'plan', resolvedWriteRoots: ['/repo/plans/'] });
    const got = getActivePersona();

    expect(got?.bashAllow).toEqual([]);
    expect(got?.bashDeny).toEqual([]);
  });

  test('clearActivePersona resets to undefined', () => {
    setActivePersona({ name: 'plan', resolvedWriteRoots: ['/repo/plans/'] });
    clearActivePersona();

    expect(getActivePersona()).toBeUndefined();
  });

  test('passing undefined is the same as clear', () => {
    setActivePersona({ name: 'plan', resolvedWriteRoots: ['/repo/plans/'] });
    setActivePersona(undefined);

    expect(getActivePersona()).toBeUndefined();
  });

  test('snapshot is defensively copied - mutating caller arrays does not bleed in', () => {
    const roots = ['/repo/plans/'];
    const allow = ['rg *'];
    const deny = ['curl *'];
    setActivePersona({ name: 'plan', resolvedWriteRoots: roots, bashAllow: allow, bashDeny: deny });
    roots.push('/repo/other/');
    allow.push('ai-fetch-web *');
    deny.push('npm *');

    expect(getActivePersona()?.resolvedWriteRoots).toEqual(['/repo/plans/']);
    expect(getActivePersona()?.bashAllow).toEqual(['rg *']);
    expect(getActivePersona()?.bashDeny).toEqual(['curl *']);
  });

  test('returned snapshot is frozen - callers cannot mutate it back into the singleton', () => {
    setActivePersona({
      name: 'plan',
      resolvedWriteRoots: ['/repo/plans/'],
      bashAllow: ['rg *'],
      bashDeny: ['curl *'],
    });
    const snap = getActivePersona();

    expect(snap).toBeDefined();
    expect(() => {
      (snap?.resolvedWriteRoots as string[]).push('/evil/');
    }).toThrow();
    expect(() => {
      (snap?.bashAllow as string[]).push('curl *');
    }).toThrow();
    expect(() => {
      (snap?.bashDeny as string[]).pop();
    }).toThrow();
    expect(getActivePersona()?.resolvedWriteRoots).toEqual(['/repo/plans/']);
    expect(getActivePersona()?.bashAllow).toEqual(['rg *']);
    expect(getActivePersona()?.bashDeny).toEqual(['curl *']);
  });

  test('replacing an active snapshot overwrites every field', () => {
    setActivePersona({
      name: 'plan',
      resolvedWriteRoots: ['/repo/plans/'],
      bashAllow: ['rg *'],
      bashDeny: ['curl *'],
    });
    setActivePersona({ name: 'review', resolvedWriteRoots: ['/repo/reviews/'] });

    expect(getActivePersona()).toEqual({
      name: 'review',
      resolvedWriteRoots: ['/repo/reviews/'],
      bashAllow: [],
      bashDeny: [],
    });
  });
});
