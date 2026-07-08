/**
 * Config parsing for the waveform-indicator's thinking-effort "breathing
 * pulse" - the cosine-driven dim/brighten animation on the thinking
 * segment of the dim suffix.
 *
 * Reads `PI_WAVEFORM_THINKING_PULSE` + `PI_WAVEFORM_THINKING_PULSE_HZ`
 * and resolves them into the `{ enabled, hz }` shape `formatSuffix`
 * consumes:
 *
 *   - `PI_WAVEFORM_THINKING_PULSE=off` is the only opt-out; any other
 *     value (including unset) leaves the pulse on.
 *   - A non-finite or `<= 0` Hz value flips `enabled` to false here so
 *     the caller never calls `formatSuffix` with `tick` set in a way
 *     that would land on the static-peak `cos(0) = 1` frame.
 *
 * Pure module - no pi imports. `env` defaults to `process.env`; tests
 * inject an explicit map.
 */

export interface ThinkingPulseConfig {
  enabled: boolean;
  hz: number | undefined;
}

export function resolveThinkingPulseConfig(env: NodeJS.ProcessEnv = process.env): ThinkingPulseConfig {
  const rawDisable = env.PI_WAVEFORM_THINKING_PULSE;
  if (typeof rawDisable === 'string' && rawDisable.toLowerCase() === 'off') {
    return { enabled: false, hz: undefined };
  }
  const rawHz = env.PI_WAVEFORM_THINKING_PULSE_HZ;
  if (rawHz === undefined || rawHz === '') {
    return { enabled: true, hz: undefined };
  }
  const parsed = Number(rawHz);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { enabled: false, hz: undefined };
  }
  return { enabled: true, hz: parsed };
}
