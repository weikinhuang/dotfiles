/**
 * Tests for lib/node/pi/tts/status.ts.
 *
 * Pure `/tts status` line formatters - the probe / capability shapes are
 * plain objects so no live server or engine runtime is needed.
 */

import { describe, expect, test } from 'vitest';

import { capHint, reachText } from '../../../../../lib/node/pi/tts/status.ts';
import type { ResolvedVoice } from '../../../../../lib/node/pi/tts/types.ts';

const presetVoice = { kind: 'preset' } as unknown as ResolvedVoice;
const cloneVoice = { kind: 'clone' } as unknown as ResolvedVoice;

describe('reachText', () => {
  test('reports the HTTP status when the server answered', () => {
    expect(reachText({ status: 200, timedOut: false })).toBe('reachable (200)');
    expect(reachText({ status: 503, timedOut: false })).toBe('reachable (503)');
  });

  test('reports a cold-start hint on a timeout', () => {
    expect(reachText({ status: undefined, timedOut: true })).toBe('no response yet (starting / cold?)');
  });

  test('reports UNREACHABLE on connection refusal', () => {
    expect(reachText({ status: undefined, timedOut: false })).toBe('UNREACHABLE');
  });
});

describe('capHint', () => {
  test('no capability info yields no hint', () => {
    expect(capHint(presetVoice, undefined)).toBe('');
  });

  test('warns on a preset voice pointed at a Base model', () => {
    expect(capHint(presetVoice, { modelType: 'base' })).toBe(
      '  ! preset voice on a Base model -> synth will 500; point it at a CustomVoice instance',
    );
  });

  test('warns on a clone voice pointed at a CustomVoice model', () => {
    expect(capHint(cloneVoice, { cloneSupported: false })).toBe(
      '  ! clone voice on a CustomVoice model -> cloning unsupported; point it at a Base instance',
    );
  });

  test('no hint when the voice kind matches the instance', () => {
    expect(capHint(presetVoice, { modelType: 'customvoice' })).toBe('');
    expect(capHint(cloneVoice, { cloneSupported: true })).toBe('');
  });
});
