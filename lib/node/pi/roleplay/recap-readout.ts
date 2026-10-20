/**
 * Pure formatter for the `/roleplay recap` readout (in-memory recap text,
 * coverage, in-flight state, recap model, and the injected timeline block
 * preview) plus the reason a forced roll is unavailable. The extension owns
 * the state + config reads. No pi imports.
 */

export interface RecapAvailability {
  summarizeEnabled: boolean;
  contextWindowEnabled: boolean;
  /** Summarizer resolved (a summarize model + the roleplay-summarizer agent). */
  summarizerReady: boolean;
}

/** Why recap rolls cannot run, or `null` when they can. */
export function recapUnavailableReason(a: RecapAvailability): string | null {
  if (!a.summarizeEnabled) return 'summarize is disabled (PI_ROLEPLAY_DISABLE_SUMMARIZE)';
  if (!a.contextWindowEnabled) return 'the context window is disabled (PI_ROLEPLAY_DISABLE_CONTEXT_WINDOW)';
  if (!a.summarizerReady) return 'no summarize model / roleplay-summarizer agent resolved';
  return null;
}

export interface RecapReadoutOptions {
  /** `null` = recap mode on; otherwise the reason it is off (see {@link recapUnavailableReason}). */
  unavailable: string | null;
  recapText: string;
  recapCutoff: number;
  committedCutoff: number;
  /** Natural cutoff at the last context pass, when a window snapshot exists. */
  natural: number | undefined;
  inFlight: boolean;
  forceArmed: boolean;
  /** Recap model id (`provider/id`), when resolved. */
  model: string | undefined;
  timelineEnabled: boolean;
  /** Rendered injected timeline block (already capped), or `null` when empty. */
  timelineBlock: string | null;
}

/** Format the `/roleplay recap show` readout. */
export function formatRecapReadout(o: RecapReadoutOptions): string {
  const lines = ['Roleplay recap'];
  lines.push(`  mode     : ${o.unavailable ? `OFF (${o.unavailable})` : 'on'}`);
  lines.push(`  model    : ${o.model ?? '(unresolved)'}`);
  const natural = o.natural === undefined ? 'n/a' : String(o.natural);
  lines.push(`  coverage : recap=${o.recapCutoff}  committed=${o.committedCutoff}  natural(last pass)=${natural}`);
  const status: string[] = [];
  if (o.inFlight) status.push('async roll in flight');
  if (o.forceArmed) status.push('forced roll armed for the next pass');
  lines.push(`  status   : ${status.length > 0 ? status.join('; ') : 'idle'}`);
  lines.push('');
  const recap = o.recapText.trim();
  lines.push(recap ? `Recap (${recap.length} chars):\n${recap}` : 'Recap: (empty)');
  lines.push('');
  if (!o.timelineEnabled) lines.push('Timeline: off (config `timeline` / recap mode)');
  else if (!o.timelineBlock) lines.push('Timeline: on, no beats yet');
  else lines.push(`Timeline (injected preview, ${o.timelineBlock.length} chars):\n${o.timelineBlock}`);
  return lines.join('\n');
}
