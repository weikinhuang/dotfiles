import { afterEach, describe, expect, test } from 'vitest';

import { clearActivePersona, getActivePersona, setActivePersona } from '../../../../../lib/node/pi/persona/active.ts';

afterEach(() => {
  clearActivePersona();
});

describe('active-persona singleton', () => {
  test('returns undefined before any persona is set', () => {
    expect(getActivePersona()).toBeUndefined();
  });

  test('setActivePersona stores name + writeRoots', () => {
    setActivePersona({ name: 'plan', resolvedWriteRoots: ['/repo/plans/'] });
    const got = getActivePersona();

    expect(got?.name).toBe('plan');
    expect(got?.resolvedWriteRoots).toEqual(['/repo/plans/']);
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

  test('snapshot is defensively copied — mutating caller array does not bleed in', () => {
    const roots = ['/repo/plans/'];
    setActivePersona({ name: 'plan', resolvedWriteRoots: roots });
    roots.push('/repo/other/');

    expect(getActivePersona()?.resolvedWriteRoots).toEqual(['/repo/plans/']);
  });

  test('returned snapshot is frozen — callers cannot mutate it back into the singleton', () => {
    setActivePersona({ name: 'plan', resolvedWriteRoots: ['/repo/plans/'] });
    const snap = getActivePersona();

    expect(snap).toBeDefined();
    expect(() => {
      (snap?.resolvedWriteRoots as string[]).push('/evil/');
    }).toThrow();
    expect(getActivePersona()?.resolvedWriteRoots).toEqual(['/repo/plans/']);
  });

  test('replacing an active snapshot overwrites both name and writeRoots', () => {
    setActivePersona({ name: 'plan', resolvedWriteRoots: ['/repo/plans/'] });
    setActivePersona({ name: 'review', resolvedWriteRoots: ['/repo/reviews/'] });

    expect(getActivePersona()).toEqual({
      name: 'review',
      resolvedWriteRoots: ['/repo/reviews/'],
    });
  });
});
