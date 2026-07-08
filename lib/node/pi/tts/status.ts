/**
 * Pure status-line formatters for the `tts` extension's `/tts status`
 * command.
 *
 * The extension shell runs the live reachability + capability probes;
 * these helpers turn the probe results into the human-readable strings
 * the command prints, so the exact wording is unit-testable without the
 * pi runtime or a live server.
 *
 * No pi imports. Probe/voice shapes are pulled in as type-only imports
 * so this module carries no runtime dependency on the network-touching
 * engine.
 */

import type { CloneCapabilities, ProbeResult } from './engine.ts';
import type { ResolvedVoice } from './types.ts';

/**
 * Render a reachability probe for `/tts status`: the HTTP status when the
 * server answered, a "starting / cold?" hint when the probe timed out (a
 * scale-to-zero or model-loading instance that synth's long timeout would
 * still ride out), or UNREACHABLE on outright connection refusal.
 */
export function reachText(probe: ProbeResult): string {
  if (probe.status !== undefined) return `reachable (${probe.status})`;
  return probe.timedOut ? 'no response yet (starting / cold?)' : 'UNREACHABLE';
}

/**
 * Warn when a voice's kind does not match the instance it is pointed at, which
 * would otherwise 500 silently at synth time: a `preset` voice on a Base model,
 * or a `clone` voice on a CustomVoice model. Empty string = no mismatch / unknown.
 */
export function capHint(resolved: ResolvedVoice, cap: CloneCapabilities | undefined): string {
  if (!cap) return '';
  if (resolved.kind === 'preset' && cap.modelType === 'base') {
    return '  ! preset voice on a Base model -> synth will 500; point it at a CustomVoice instance';
  }
  if (resolved.kind === 'clone' && cap.cloneSupported === false) {
    return '  ! clone voice on a CustomVoice model -> cloning unsupported; point it at a Base instance';
  }
  return '';
}
