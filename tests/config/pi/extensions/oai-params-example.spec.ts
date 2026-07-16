/**
 * Validates the bundled `config/pi/oai-params-example.json` parses through
 * `parseVariants` (the same reader the oai-params store uses) with every
 * entry surviving the `ParsedVariant` shape check - i.e. none of the
 * example entries are silently dropped as malformed - and that each entry
 * resolves against `config/pi/models-example.json` via `buildRegistrations`.
 *
 * Lives under `tests/config/pi/extensions/` alongside the other example
 * specs. The parser/builder modules are pure - no pi-runtime imports - so
 * this runs in the same vitest pass as the helper specs.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { buildRegistrations } from '../../../../lib/node/pi/oai-params/build-registration.ts';
import { parseVariants } from '../../../../lib/node/pi/oai-params/config.ts';
import { parseJsonc } from '../../../../lib/node/pi/jsonc.ts';

const EXAMPLE_PATH = resolve(__dirname, '../../../../config/pi/oai-params-example.json');
const MODELS_PATH = resolve(__dirname, '../../../../config/pi/models-example.json');

function readExample(): unknown {
  return parseJsonc(readFileSync(EXAMPLE_PATH, 'utf8'));
}

describe('config/pi/oai-params-example.json', () => {
  test('every example entry survives the shape check', () => {
    const raw = readExample() as Record<string, unknown>;
    const { variants, errors } = parseVariants(raw);
    expect(errors).toEqual([]);
    expect(variants).toHaveLength(Object.keys(raw).length);
  });

  test('each variant carries an explicit provider/id parent', () => {
    const { variants } = parseVariants(readExample());
    for (const v of variants) {
      expect(v.parentProvider).not.toBe('');
      expect(v.parentId).not.toBe('');
    }
  });

  test('every example variant resolves against models-example.json', () => {
    const { variants } = parseVariants(readExample());
    const models = parseJsonc(readFileSync(MODELS_PATH, 'utf8')) as { providers?: Record<string, unknown> };
    const { registrations, errors } = buildRegistrations(variants, models.providers);
    expect(errors).toEqual([]);
    expect(registrations).toHaveLength(variants.length);
  });
});
