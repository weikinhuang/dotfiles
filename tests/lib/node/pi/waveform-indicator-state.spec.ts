/**
 * Tests for lib/node/pi/waveform-indicator-state.ts.
 *
 * Each test gets a freshly-mkdtemp'd directory so file-touching tests
 * never share state. Pure helpers, no pi runtime mocks needed.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  VALID_WAVEFORM_MODES,
  clearWaveformState,
  isWaveformMode,
  readWaveformState,
  resolveInitialWaveformMode,
  writeWaveformState,
} from '../../../../lib/node/pi/waveform-indicator-state.ts';

let workdir: string;
let statePath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'pi-waveform-state-'));
  statePath = join(workdir, 'sub', 'waveform-indicator.json');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// isWaveformMode
// ──────────────────────────────────────────────────────────────────────

describe('isWaveformMode', () => {
  test('accepts every value in VALID_WAVEFORM_MODES', () => {
    for (const m of VALID_WAVEFORM_MODES) {
      expect(isWaveformMode(m)).toBe(true);
    }
  });

  test('rejects unknown strings, numbers, null, undefined, objects', () => {
    expect(isWaveformMode('rainbow')).toBe(false);
    expect(isWaveformMode('')).toBe(false);
    expect(isWaveformMode(0)).toBe(false);
    expect(isWaveformMode(null)).toBe(false);
    expect(isWaveformMode(undefined)).toBe(false);
    expect(isWaveformMode({ mode: 'scroll' })).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// readWaveformState
// ──────────────────────────────────────────────────────────────────────

describe('readWaveformState', () => {
  test('returns undefined when file is missing', () => {
    expect(readWaveformState(statePath)).toBeUndefined();
  });

  test('returns undefined for malformed JSON', () => {
    writeWaveformState(statePath, 'scroll');
    writeFileSync(statePath, '{ not: json', 'utf8');

    expect(readWaveformState(statePath)).toBeUndefined();
  });

  test('returns undefined when mode field is missing', () => {
    writeWaveformState(statePath, 'scroll');
    writeFileSync(statePath, '{ "other": "scroll" }\n', 'utf8');

    expect(readWaveformState(statePath)).toBeUndefined();
  });

  test('returns undefined when mode is unknown', () => {
    writeWaveformState(statePath, 'scroll');
    writeFileSync(statePath, '{ "mode": "rainbow" }\n', 'utf8');

    expect(readWaveformState(statePath)).toBeUndefined();
  });

  test('round-trips every valid mode', () => {
    for (const m of VALID_WAVEFORM_MODES) {
      writeWaveformState(statePath, m);

      expect(readWaveformState(statePath)).toBe(m);
    }
  });

  test("'tokenrate' is recognized as a valid mode", () => {
    // Sanity-check the union/parser landed for the new tokenrate mode so a
    // forward-compat file written by a new binary loads cleanly.
    writeWaveformState(statePath, 'tokenrate');

    expect(readWaveformState(statePath)).toBe('tokenrate');
  });

  test('downgrade: a future unknown mode falls through to undefined without corrupting', () => {
    // Simulates the downgrade case the plan calls out: an older binary
    // encounters a mode it doesn't know about. The file is left alone, the
    // reader returns undefined, and a re-run of the new binary picks the
    // value back up - here we just assert the read-side falls through.
    writeWaveformState(statePath, 'scroll');
    writeFileSync(statePath, '{ "mode": "futurewave" }\n', 'utf8');

    expect(readWaveformState(statePath)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// writeWaveformState
// ──────────────────────────────────────────────────────────────────────

describe('writeWaveformState', () => {
  test('creates the parent directory when missing', () => {
    expect(existsSync(join(workdir, 'sub'))).toBe(false);

    writeWaveformState(statePath, 'spectrum');

    expect(existsSync(statePath)).toBe(true);
  });

  test('writes a stable JSON shape with trailing newline', () => {
    writeWaveformState(statePath, 'spectrum');

    expect(readFileSync(statePath, 'utf8')).toBe('{\n  "mode": "spectrum"\n}\n');
  });

  test('overwrites an existing file', () => {
    writeWaveformState(statePath, 'scroll');
    writeWaveformState(statePath, 'off');

    expect(readWaveformState(statePath)).toBe('off');
  });
});

// ──────────────────────────────────────────────────────────────────────
// clearWaveformState
// ──────────────────────────────────────────────────────────────────────

describe('clearWaveformState', () => {
  test('removes an existing file', () => {
    writeWaveformState(statePath, 'spectrum');
    clearWaveformState(statePath);

    expect(existsSync(statePath)).toBe(false);
  });

  test('is silent when the file is already gone', () => {
    expect(() => clearWaveformState(statePath)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveInitialWaveformMode
// ──────────────────────────────────────────────────────────────────────

describe('resolveInitialWaveformMode', () => {
  test('falls back to "scroll" when env empty AND no file', () => {
    expect(resolveInitialWaveformMode(statePath, {})).toBe('scroll');
  });

  test('reads the file when env is empty', () => {
    writeWaveformState(statePath, 'spectrum');

    expect(resolveInitialWaveformMode(statePath, {})).toBe('spectrum');
  });

  test('env var wins over the file', () => {
    writeWaveformState(statePath, 'scroll');

    expect(resolveInitialWaveformMode(statePath, { PI_WAVEFORM_INDICATOR_MODE: 'spectrum' })).toBe('spectrum');
  });

  test('unknown env value falls through to the file', () => {
    writeWaveformState(statePath, 'spectrum');

    expect(resolveInitialWaveformMode(statePath, { PI_WAVEFORM_INDICATOR_MODE: 'rainbow' })).toBe('spectrum');
  });

  test('unknown env value AND missing file falls back to "scroll"', () => {
    expect(resolveInitialWaveformMode(statePath, { PI_WAVEFORM_INDICATOR_MODE: 'rainbow' })).toBe('scroll');
  });

  test('empty-string env is ignored', () => {
    writeWaveformState(statePath, 'off');

    expect(resolveInitialWaveformMode(statePath, { PI_WAVEFORM_INDICATOR_MODE: '' })).toBe('off');
  });
});
