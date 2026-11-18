/**
 * Pure status-line formatters for the `tts` extension's `/tts status`
 * command.
 *
 * The extension shell runs the live reachability + voice-library probes and
 * reads reference clip headers; these helpers turn the results into the
 * human-readable strings the command prints, so the exact wording is
 * unit-testable without the pi runtime or a live server.
 *
 * No pi imports. Probe/voice shapes are pulled in as type-only imports
 * so this module carries no runtime dependency on the network-touching
 * engine.
 */

import type { ProbeResult, VoiceLibrary } from './engine.ts';
import type { ResolvedVoice, VoiceConfig } from './types.ts';
import { ICL_MAX_REF_SECONDS } from './wav.ts';

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
 * Find the library entry a server voice name resolves to: an exact or
 * case-insensitive match on an `id` or one of its `aliases`.
 */
function findLibraryVoice(library: VoiceLibrary, name: string): string | undefined {
  const lower = name.toLowerCase();
  const hit = library.voices.find(
    (v) => v.id.toLowerCase() === lower || v.aliases.some((a) => a.toLowerCase() === lower),
  );
  return hit?.id;
}

/**
 * Warn when a preset voice names something the server library does not
 * contain: the server silently falls back to its default voice, which is easy
 * to miss by ear. Empty string = clone voice, a library hit, or no library.
 */
export function libraryHint(resolved: ResolvedVoice, library: VoiceLibrary | undefined): string {
  if (!library || resolved.kind !== 'preset') return '';
  const name = resolved.voice.preset ?? resolved.name;
  if (findLibraryVoice(library, name) !== undefined) return '';
  const fallback = library.default ? `the default "${library.default}"` : 'the server default';
  return `  ! preset "${name}" is not in the server voice library; it falls back to ${fallback}`;
}

/**
 * Render the server voice library as one line per voice: `id (lang,
 * transcript) aliases: a, b`, with the default voice marked.
 */
export function libraryLines(library: VoiceLibrary | undefined): string[] {
  if (!library) return ['server voices: (unavailable)'];
  if (library.voices.length === 0) return ['server voices: (none)'];
  return [
    'server voices:',
    ...library.voices.map((v) => {
      const tags = [v.lang, v.hasTranscript === false ? 'no transcript' : undefined].filter(Boolean).join(', ');
      const mark = v.id === library.default ? ' [default]' : '';
      const aliases = v.aliases.length > 0 ? ` aliases: ${v.aliases.join(', ')}` : '';
      return `  ${v.id}${mark}${tags ? ` (${tags})` : ''}${aliases}`;
    }),
  ];
}

/**
 * Result of inspecting one reference clip: its duration in seconds, `missing`
 * when it cannot be read, or undefined when the duration is unknown (non-WAV).
 */
export type ClipDuration = number | 'missing' | undefined;

/**
 * Warn about a clone voice's reference clips (the default plus each emote
 * clip): a clip the client cannot read fails every synth, and a clip longer
 * than {@link ICL_MAX_REF_SECONDS} silently falls back to the speaker
 * embedding once ICL is enabled server-side. `durationOf` is injected so the
 * shell owns the file reads.
 */
export function refClipHints(voice: VoiceConfig, durationOf: (path: string) => ClipDuration): string[] {
  const paths = [voice.refAudio, ...(voice.emotes ?? []).map((e) => e.refAudio)].filter(
    (p): p is string => p !== undefined,
  );
  const hints: string[] = [];
  for (const path of new Set(paths)) {
    const d = durationOf(path);
    if (d === 'missing') hints.push(`  ! reference clip ${path} is unreadable; clone synth will fail`);
    else if (d !== undefined && d > ICL_MAX_REF_SECONDS) {
      hints.push(
        `  ! reference clip ${path} is ${d.toFixed(1)} s; ICL needs <= ${ICL_MAX_REF_SECONDS} s (falls back to the speaker embedding)`,
      );
    }
  }
  return hints;
}
