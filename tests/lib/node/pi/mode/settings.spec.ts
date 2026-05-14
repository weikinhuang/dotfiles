/**
 * Tests for lib/node/pi/mode/settings.ts.
 */

import { describe, expect, test } from 'vitest';

import { loadModeSettings } from '../../../../../lib/node/pi/mode/settings.ts';

describe('loadModeSettings', () => {
  test('single layer surfaces writeRoots', () => {
    const { merged, warnings } = loadModeSettings([
      { source: '/u/modes.json', raw: JSON.stringify({ writeRoots: { plan: ['docs/plans/'] } }) },
    ]);

    expect(warnings).toEqual([]);
    expect(merged.writeRoots).toEqual({ plan: ['docs/plans/'] });
  });

  test('project layer overrides user per mode-name without clobbering siblings', () => {
    const user = {
      source: '/u/modes.json',
      raw: JSON.stringify({
        writeRoots: { plan: ['old/'], journal: ['journal/'] },
      }),
    };
    const project = {
      source: '/p/modes.json',
      raw: JSON.stringify({ writeRoots: { plan: ['docs/plans/'] } }),
    };

    const { merged, warnings } = loadModeSettings([user, project]);

    expect(warnings).toEqual([]);
    expect(merged.writeRoots.plan).toEqual(['docs/plans/']);
    expect(merged.writeRoots.journal).toEqual(['journal/']);
  });

  test('bad JSON warns with source path; layer skipped; other layers preserved', () => {
    const layers = [
      { source: '/u/modes.json', raw: JSON.stringify({ writeRoots: { plan: ['p/'] } }) },
      { source: '/bad/modes.json', raw: '{ this is not json' },
      { source: '/p/modes.json', raw: JSON.stringify({ default: 'plan' }) },
    ];

    const { merged, warnings } = loadModeSettings(layers);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe('/bad/modes.json');
    expect(warnings[0].reason.length).toBeGreaterThan(0);
    expect(merged.writeRoots.plan).toEqual(['p/']);
    expect(merged.default).toBe('plan');
  });

  test('empty raw is tolerated with no warning', () => {
    const { merged, warnings } = loadModeSettings([
      { source: '/u/modes.json', raw: '' },
      { source: '/u/modes2.json', raw: '   \n  ' },
    ]);

    expect(warnings).toEqual([]);
    expect(merged).toEqual({ writeRoots: {} });
  });

  test('empty layers array → empty merged settings, no warnings', () => {
    const { merged, warnings } = loadModeSettings([]);

    expect(warnings).toEqual([]);
    expect(merged).toEqual({ writeRoots: {} });
  });

  test('unknown top-level keys are silently ignored', () => {
    const { merged, warnings } = loadModeSettings([
      {
        source: '/u/modes.json',
        raw: JSON.stringify({ weirdField: 'x', writeRoots: { plan: ['p/'] } }),
      },
    ]);

    expect(warnings).toEqual([]);
    expect(merged.writeRoots).toEqual({ plan: ['p/'] });
  });

  test('default and disabled are last-wins', () => {
    const a = { source: '/a', raw: JSON.stringify({ default: 'plan', disabled: ['x'] }) };
    const b = { source: '/b', raw: JSON.stringify({ default: 'journal', disabled: ['y', 'z'] }) };

    const { merged, warnings } = loadModeSettings([a, b]);

    expect(warnings).toEqual([]);
    expect(merged.default).toBe('journal');
    expect(merged.disabled).toEqual(['y', 'z']);
  });

  test('writeRoots with non-array value warns and drops just that key', () => {
    const { merged, warnings } = loadModeSettings([
      {
        source: '/u/modes.json',
        raw: JSON.stringify({ writeRoots: { plan: 'not-an-array', journal: ['j/'] } }),
      },
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toMatch(/writeRoots\.plan/);
    expect(merged.writeRoots).toEqual({ journal: ['j/'] });
  });
});
