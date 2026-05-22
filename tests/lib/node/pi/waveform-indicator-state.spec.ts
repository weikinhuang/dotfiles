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
  DEFAULT_DYNAMIC_LABEL_PERSONA,
  DEFAULT_MAX_CALLS_PER_SESSION,
  VALID_WAVEFORM_MODES,
  clearWaveformState,
  isWaveformMode,
  readDynamicLabelRaw,
  readWaveformState,
  resolveDynamicLabelConfig,
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

// ──────────────────────────────────────────────────────────────────────
// dynamicLabel persistence + resolution
// ──────────────────────────────────────────────────────────────────────

/**
 * Write a file with a `mode` plus an arbitrary `dynamicLabel` block.
 * `writeWaveformState` deliberately only preserves a pre-existing
 * dynamicLabel - it doesn't let callers WRITE one - so we drop the
 * JSON in directly.
 */
function writeFullState(path: string, body: Record<string, unknown>): void {
  // ensure parent dir exists - writeWaveformState would have created
  // it, but our shortcut here uses raw writeFileSync.
  writeWaveformState(path, 'scroll');
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

describe('writeWaveformState preserves dynamicLabel', () => {
  test('a /waveform <mode> update keeps the existing dynamicLabel intact', () => {
    writeFullState(statePath, {
      mode: 'spectrum',
      dynamicLabel: { enabled: true, tinyModel: 'openai/gpt-4o-mini' },
    });
    // Mimic the slash command updating only the mode.
    writeWaveformState(statePath, 'tokenrate');
    const round = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    expect(round.mode).toBe('tokenrate');
    expect(round.dynamicLabel).toEqual({ enabled: true, tinyModel: 'openai/gpt-4o-mini' });
  });
});

describe('readDynamicLabelRaw', () => {
  test('returns undefined for missing file', () => {
    expect(readDynamicLabelRaw(statePath)).toBeUndefined();
  });

  test('returns the raw dynamicLabel object verbatim', () => {
    writeFullState(statePath, { mode: 'scroll', dynamicLabel: { enabled: true, tinyModel: 'foo/bar' } });
    expect(readDynamicLabelRaw(statePath)).toEqual({ enabled: true, tinyModel: 'foo/bar' });
  });

  test('returns undefined when the file has no dynamicLabel block', () => {
    writeWaveformState(statePath, 'scroll');
    expect(readDynamicLabelRaw(statePath)).toBeUndefined();
  });
});

describe('resolveDynamicLabelConfig', () => {
  test('empty file → defaults: enabled=false, tinyModel=null, persona=daemon', () => {
    const r = resolveDynamicLabelConfig(statePath, {});
    expect(r.config.enabled).toBe(false);
    expect(r.config.tinyModel).toBeNull();
    expect(r.config.persona).toBe(DEFAULT_DYNAMIC_LABEL_PERSONA);
    expect(r.config.maxCallsPerSession).toBe(DEFAULT_MAX_CALLS_PER_SESSION);
    expect(r.warnings).toHaveLength(0);
  });

  test('valid file round-trips through resolver', () => {
    writeFullState(statePath, {
      mode: 'scroll',
      dynamicLabel: {
        enabled: true,
        tinyModel: 'openai/gpt-4o-mini',
        persona: 'exusiai-buddy',
        maxCallsPerSession: 50,
      },
    });
    const r = resolveDynamicLabelConfig(statePath, {});
    expect(r.config).toEqual({
      enabled: true,
      tinyModel: 'openai/gpt-4o-mini',
      persona: 'exusiai-buddy',
      maxCallsPerSession: 50,
    });
    expect(r.warnings).toHaveLength(0);
  });

  test('enabled=true + missing tinyModel → silently disabled, no warning', () => {
    writeFullState(statePath, { mode: 'scroll', dynamicLabel: { enabled: true } });
    const r = resolveDynamicLabelConfig(statePath, {});
    expect(r.config.enabled).toBe(false);
    expect(r.config.tinyModel).toBeNull();
    expect(r.warnings).toHaveLength(0);
  });

  test('garbage tinyModel (no slash) → disabled with warning', () => {
    writeFullState(statePath, { mode: 'scroll', dynamicLabel: { enabled: true, tinyModel: 'garbage' } });
    const r = resolveDynamicLabelConfig(statePath, {});
    expect(r.config.enabled).toBe(false);
    expect(r.config.tinyModel).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/tinyModel "garbage"/);
  });

  test('malformed dynamicLabel block (not an object) falls through silently', () => {
    writeFullState(statePath, { mode: 'scroll', dynamicLabel: 'not-an-object' });
    const r = resolveDynamicLabelConfig(statePath, {});
    expect(r.config.enabled).toBe(false);
    expect(r.config.tinyModel).toBeNull();
    expect(r.warnings).toHaveLength(0);
  });

  test('persona: "" opts out (preserved through resolver)', () => {
    writeFullState(statePath, {
      mode: 'scroll',
      dynamicLabel: { enabled: true, tinyModel: 'openai/gpt-4o-mini', persona: '' },
    });
    const r = resolveDynamicLabelConfig(statePath, {});
    expect(r.config.persona).toBe('');
  });

  test('PI_WAVEFORM_DYNAMIC_LABEL=on flips a disabled file', () => {
    writeFullState(statePath, {
      mode: 'scroll',
      dynamicLabel: { enabled: false, tinyModel: 'openai/gpt-4o-mini' },
    });
    const r = resolveDynamicLabelConfig(statePath, { PI_WAVEFORM_DYNAMIC_LABEL: 'on' });
    expect(r.config.enabled).toBe(true);
  });

  test('PI_WAVEFORM_DYNAMIC_LABEL=off flips an enabled file', () => {
    writeFullState(statePath, {
      mode: 'scroll',
      dynamicLabel: { enabled: true, tinyModel: 'openai/gpt-4o-mini' },
    });
    const r = resolveDynamicLabelConfig(statePath, { PI_WAVEFORM_DYNAMIC_LABEL: 'off' });
    expect(r.config.enabled).toBe(false);
  });

  test('PI_WAVEFORM_DYNAMIC_LABEL=on without a valid tinyModel stays disabled', () => {
    // env on, file has no tinyModel - still disabled because the
    // two-stage validation requires SOME parseable model.
    writeFullState(statePath, { mode: 'scroll', dynamicLabel: { enabled: false } });
    const r = resolveDynamicLabelConfig(statePath, { PI_WAVEFORM_DYNAMIC_LABEL: 'on' });
    expect(r.config.enabled).toBe(false);
    expect(r.config.tinyModel).toBeNull();
  });

  test('PI_WAVEFORM_DYNAMIC_LABEL_MODEL overrides a valid file value', () => {
    writeFullState(statePath, {
      mode: 'scroll',
      dynamicLabel: { enabled: true, tinyModel: 'openai/gpt-4o-mini' },
    });
    const r = resolveDynamicLabelConfig(statePath, { PI_WAVEFORM_DYNAMIC_LABEL_MODEL: 'llama-cpp/qwen3-0.6b' });
    expect(r.config.tinyModel).toBe('llama-cpp/qwen3-0.6b');
    expect(r.config.enabled).toBe(true);
  });

  test('malformed PI_WAVEFORM_DYNAMIC_LABEL_MODEL falls back to file value (no silent disable)', () => {
    writeFullState(statePath, {
      mode: 'scroll',
      dynamicLabel: { enabled: true, tinyModel: 'openai/gpt-4o-mini' },
    });
    const r = resolveDynamicLabelConfig(statePath, { PI_WAVEFORM_DYNAMIC_LABEL_MODEL: 'garbage' });
    expect(r.config.tinyModel).toBe('openai/gpt-4o-mini');
    expect(r.config.enabled).toBe(true);
  });

  test('PI_WAVEFORM_DYNAMIC_LABEL with an unknown value is ignored', () => {
    writeFullState(statePath, {
      mode: 'scroll',
      dynamicLabel: { enabled: true, tinyModel: 'openai/gpt-4o-mini' },
    });
    const r = resolveDynamicLabelConfig(statePath, { PI_WAVEFORM_DYNAMIC_LABEL: 'yes' });
    expect(r.config.enabled).toBe(true);
  });

  test('non-positive maxCallsPerSession falls back to default', () => {
    writeFullState(statePath, {
      mode: 'scroll',
      dynamicLabel: { enabled: true, tinyModel: 'openai/gpt-4o-mini', maxCallsPerSession: -5 },
    });
    expect(resolveDynamicLabelConfig(statePath, {}).config.maxCallsPerSession).toBe(DEFAULT_MAX_CALLS_PER_SESSION);
  });
});
