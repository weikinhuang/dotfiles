/**
 * Tests for lib/node/pi/waveform-indicator/thinking-pulse.ts.
 *
 * Pure config parser - the env map is injected so no `process.env`
 * mutation is needed.
 */

import { describe, expect, test } from 'vitest';

import { resolveThinkingPulseConfig } from '../../../../../lib/node/pi/waveform-indicator/thinking-pulse.ts';

describe('resolveThinkingPulseConfig', () => {
  test('defaults to enabled with no explicit hz when the env is empty', () => {
    expect(resolveThinkingPulseConfig({})).toEqual({ enabled: true, hz: undefined });
  });

  test('PI_WAVEFORM_THINKING_PULSE=off disables the pulse (case-insensitive)', () => {
    expect(resolveThinkingPulseConfig({ PI_WAVEFORM_THINKING_PULSE: 'off' })).toEqual({
      enabled: false,
      hz: undefined,
    });
    expect(resolveThinkingPulseConfig({ PI_WAVEFORM_THINKING_PULSE: 'OFF' })).toEqual({
      enabled: false,
      hz: undefined,
    });
  });

  test('any non-off value keeps the pulse on', () => {
    expect(resolveThinkingPulseConfig({ PI_WAVEFORM_THINKING_PULSE: 'on' })).toEqual({
      enabled: true,
      hz: undefined,
    });
  });

  test('an empty hz string is treated as unset', () => {
    expect(resolveThinkingPulseConfig({ PI_WAVEFORM_THINKING_PULSE_HZ: '' })).toEqual({
      enabled: true,
      hz: undefined,
    });
  });

  test('a valid positive hz is parsed through', () => {
    expect(resolveThinkingPulseConfig({ PI_WAVEFORM_THINKING_PULSE_HZ: '0.75' })).toEqual({
      enabled: true,
      hz: 0.75,
    });
  });

  test('a non-finite or <= 0 hz disables the pulse', () => {
    expect(resolveThinkingPulseConfig({ PI_WAVEFORM_THINKING_PULSE_HZ: '0' })).toEqual({
      enabled: false,
      hz: undefined,
    });
    expect(resolveThinkingPulseConfig({ PI_WAVEFORM_THINKING_PULSE_HZ: '-1' })).toEqual({
      enabled: false,
      hz: undefined,
    });
    expect(resolveThinkingPulseConfig({ PI_WAVEFORM_THINKING_PULSE_HZ: 'abc' })).toEqual({
      enabled: false,
      hz: undefined,
    });
  });

  test('off wins even when a valid hz is also set', () => {
    expect(
      resolveThinkingPulseConfig({ PI_WAVEFORM_THINKING_PULSE: 'off', PI_WAVEFORM_THINKING_PULSE_HZ: '2' }),
    ).toEqual({ enabled: false, hz: undefined });
  });
});
