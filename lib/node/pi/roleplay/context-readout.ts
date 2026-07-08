/**
 * Pure formatter for the `/roleplay context` human-readable readout of the
 * last context-window pass. The extension captures a per-turn snapshot in
 * the `context` hook and owns the config/state reads (recap mode, stride,
 * max-advance, the model window); this module turns that snapshot into the
 * display string so the exact wording is unit-testable. No pi imports.
 */

/** Per-turn snapshot of the rolling context-window pass, captured by the `context` hook. */
export interface ContextWindowReadoutSnapshot {
  ts: number;
  messagesIn: number;
  messagesOut: number;
  natural: number;
  committedCutoff: number;
  recapCutoff: number;
  floorCutoff: number;
  dropCutoff: number;
  frozenFloorCutoff: number;
  recapChars: number;
  recapInFlight: boolean;
  estSystemTokens: number;
  estFullPromptTokens: number;
  estSentPromptTokens: number;
  estSavedTokens: number;
  charsPerToken: number;
  dropMoved: boolean;
  recapChanged: boolean;
}

export interface ContextReadoutOptions {
  /** Bounded recap mode (summarize + context-window both enabled). */
  recapMode: boolean;
  /** Last context-window snapshot, or `null` when windowing has not engaged yet. */
  snapshot: ContextWindowReadoutSnapshot | null;
  /** Roll cadence (aged messages per roll). */
  stride: number;
  /** How far one roll advances coverage (already resolved from config: `recapMaxAdvance || recapChunk`). */
  maxAdvance: number;
  /** The session model's context window in tokens, or `undefined` when unknown. */
  windowTokens: number | undefined;
}

/** Format the `/roleplay context` readout from a captured window snapshot. */
export function formatContextWindowReadout(opts: ContextReadoutOptions): string {
  const { recapMode, snapshot: snap, stride, maxAdvance, windowTokens } = opts;
  if (!recapMode) {
    return 'Roleplay context windowing is OFF (needs both summarize and context-window enabled). Full history is sent every turn; no recap or drop is applied.';
  }
  if (!snap) {
    return 'Roleplay context: window management has not engaged yet this session. The conversation still fits the model window, so nothing is dropped or recapped and pi does not run the context transform. This readout populates once the session grows large enough to window.';
  }
  const lag = Math.max(0, snap.natural - snap.recapCutoff);
  const dropped = snap.messagesIn - snap.messagesOut;
  const floorBinds = snap.floorCutoff >= snap.recapCutoff;
  const busted = snap.dropMoved || snap.recapChanged;
  const winStr = windowTokens ? `${windowTokens}` : '(unknown)';
  const pct = windowTokens ? ` (${Math.round((snap.estSentPromptTokens / windowTokens) * 100)}% of window)` : '';

  // Rough drain estimate: recap advances ~maxAdvance per roll while natural
  // grows ~stride between rolls, so net catch-up is ~(maxAdvance - stride) per
  // roll; a roll fires roughly every stride aged messages (~stride/2 turns).
  let drainLine = 'caught up to the kept window (rolls fire at the stride cadence).';
  if (lag > 0) {
    const net = Math.max(1, maxAdvance - stride);
    const rolls = Math.ceil(lag / net);
    const turns = Math.ceil(rolls * Math.max(1, stride / 2));
    drainLine = `${lag} msgs behind; ~${rolls} rolls (~${turns} turns) to drain  [maxAdvance=${maxAdvance}, stride=${stride}]`;
  }

  const bustWhy =
    snap.dropMoved && snap.recapChanged
      ? 'drop boundary moved + recap changed'
      : snap.dropMoved
        ? 'drop boundary moved'
        : 'recap text changed';

  return [
    'Roleplay context window (snapshot of last turn)',
    `  messages : ${snap.messagesIn} in -> ${snap.messagesOut} sent  (${dropped} dropped)`,
    `  cutoffs  : natural=${snap.natural}  drop=${snap.dropCutoff}  recap=${snap.recapCutoff}  floor=${snap.frozenFloorCutoff}(frozen)  committed=${snap.committedCutoff}`,
    `  binding  : ${floorBinds ? 'safety floor' : 'recap coverage'} sets the drop boundary`,
    `  recap    : ${snap.recapChars} chars${snap.recapInFlight ? '  [async roll in flight]' : ''}`,
    `  tokens   : sent=${snap.estSentPromptTokens}${pct}  system=${snap.estSystemTokens}  full=${snap.estFullPromptTokens}  saved=${snap.estSavedTokens}  window=${winStr}  (~${snap.charsPerToken} ch/tok)`,
    `  cache    : ${busted ? `prefix REPROCESSED last turn (${bustWhy})` : 'prefix reused (drop boundary + recap held) -> cache hit'}`,
    `  drain    : ${drainLine}`,
  ].join('\n');
}
