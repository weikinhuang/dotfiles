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
      const s = getActivePersona();
      if (!s) throw new Error('expected active persona');
      (s.resolvedWriteRoots as string[]).push('/evil/');
    }).toThrow(/read.?only|frozen|not extensible|cannot (add|delete|assign)/i);
    expect(() => {
      const s = getActivePersona();
      if (!s) throw new Error('expected active persona');
      (s.bashAllow as string[]).push('curl *');
    }).toThrow(/read.?only|frozen|not extensible|cannot (add|delete|assign)/i);
    expect(() => {
      const s = getActivePersona();
      if (!s) throw new Error('expected active persona');
      (s.bashDeny as string[]).pop();
    }).toThrow(/read.?only|frozen|not extensible|cannot (add|delete|assign)/i);
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
      roleplay: false,
    });
  });

  test('characters / openers are defensively copied and frozen', () => {
    const characters = ['Exusiai', 'Texas'];
    const openers = ['Hi!'];
    setActivePersona({ name: 'exusiai', resolvedWriteRoots: [], roleplay: true, characters, openers });
    // Mutating the caller arrays must not bleed into the stored snapshot.
    characters.push('Lappland');
    openers.push('Yo');
    expect(getActivePersona()?.characters).toEqual(['Exusiai', 'Texas']);
    expect(getActivePersona()?.openers).toEqual(['Hi!']);
    // Stored arrays are frozen - callers cannot mutate them back in.
    expect(() => {
      const s = getActivePersona();
      if (!s?.characters) throw new Error('expected characters');
      (s.characters as string[]).push('evil');
    }).toThrow(/read.?only|frozen|not extensible|cannot (add|delete|assign)/i);
    expect(() => {
      const s = getActivePersona();
      if (!s?.openers) throw new Error('expected openers');
      (s.openers as string[]).push('evil');
    }).toThrow(/read.?only|frozen|not extensible|cannot (add|delete|assign)/i);
  });

  test('copies the roleplay scene fields (cast / avatarSet / characters / pov / openers / authorNote)', () => {
    setActivePersona({
      name: 'exusiai',
      resolvedWriteRoots: [],
      roleplay: true,
      cast: 'penguin-logistics',
      avatarSet: 'exusiai',
      characters: ['Exusiai', 'Texas'],
      pov: 'Doctor',
      openers: ['Hi!'],
      authorNote: 'stay cheerful',
      authorNoteDepth: 2,
    });
    const snap = getActivePersona();
    expect(snap?.roleplay).toBe(true);
    expect(snap?.cast).toBe('penguin-logistics');
    expect(snap?.avatarSet).toBe('exusiai');
    expect(snap?.characters).toEqual(['Exusiai', 'Texas']);
    expect(snap?.pov).toBe('Doctor');
    expect(snap?.openers).toEqual(['Hi!']);
    expect(snap?.authorNote).toBe('stay cheerful');
    expect(snap?.authorNoteDepth).toBe(2);
  });
});
