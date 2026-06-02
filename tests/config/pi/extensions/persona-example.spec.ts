/**
 * Validates the bundled `config/pi/persona-example.json` parses through
 * the same `loadPersonaSettings` loader the `persona` extension uses,
 * with no warnings, and that the resolved settings round-trip the
 * documented `writeRoots` / `default` / `disabled` keys.
 *
 * Lives under `tests/config/pi/extensions/` alongside the other example
 * specs (`filesystem-example`, `sandbox-example`). The code under test
 * is pure - no pi-runtime imports - so it runs in the same vitest pass
 * as the helper specs.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { loadPersonaSettings } from '../../../../lib/node/pi/persona/settings.ts';

const EXAMPLE_PATH = resolve(__dirname, '../../../../config/pi/persona-example.json');

function loadExample(): ReturnType<typeof loadPersonaSettings> {
  const raw = readFileSync(EXAMPLE_PATH, 'utf8');
  return loadPersonaSettings([{ source: 'example', raw }]);
}

describe('config/pi/persona-example.json', () => {
  test('JSONC parses with no warnings', () => {
    const { warnings } = loadExample();
    expect(warnings).toEqual([]);
  });

  test('writeRoots overrides are keyed by persona name', () => {
    const { merged } = loadExample();
    expect(merged.writeRoots.plan).toEqual(['docs/plans/', 'plans/']);
    expect(merged.writeRoots.journal).toEqual(['~/journal/{projectSlug}/']);
  });

  test('default and disabled round-trip', () => {
    const { merged } = loadExample();
    expect(merged.default).toBe('plan');
    expect(merged.disabled).toEqual(['roleplay']);
  });
});
