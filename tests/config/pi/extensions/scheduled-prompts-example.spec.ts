/**
 * Validates the bundled `config/pi/scheduled-prompts-example.json`
 * parses through `parseScheduleFile` (the same tolerant reader the
 * scheduled-prompts store uses) with every entry surviving the
 * `Schedule` shape check - i.e. none of the example entries are
 * silently dropped as malformed.
 *
 * Lives under `tests/config/pi/extensions/` alongside the other example
 * specs. The store module is pure - no pi-runtime imports - so it runs
 * in the same vitest pass as the helper specs.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { parseScheduleFile } from '../../../../lib/node/pi/scheduled-prompts/store.ts';

const EXAMPLE_PATH = resolve(__dirname, '../../../../config/pi/scheduled-prompts-example.json');

function rawExample(): string {
  return readFileSync(EXAMPLE_PATH, 'utf8');
}

describe('config/pi/scheduled-prompts-example.json', () => {
  test('is a versioned file with a schedules array', () => {
    const parsed = JSON.parse(rawExample()) as { version: number; schedules: unknown[] };
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.schedules)).toBe(true);
  });

  test('every example schedule survives the shape check', () => {
    const parsed = JSON.parse(rawExample()) as { schedules: unknown[] };
    const kept = parseScheduleFile(rawExample());
    // parseScheduleFile drops shape-mismatched entries; equal lengths
    // means the example file is internally valid.
    expect(kept).toHaveLength(parsed.schedules.length);
  });

  test('illustrates cron, interval, and after triggers', () => {
    const kept = parseScheduleFile(rawExample());
    const kinds = kept.map((s) => s.trigger.kind).sort();
    expect(kinds).toEqual(['after', 'cron', 'interval']);
  });
});
