/**
 * tts - two-mode, dotfiles-portable TTS narration extension for pi.
 *
 * Speaks finalized assistant output aloud after each turn, without blocking the
 * turn. Two modes share one player handle, OOC pause flag, and barge-in:
 *
 *  - RP mode (this phase): gated on `PI_RP_TTS` (or `/tts on`) AND an active
 *    `roleplay: true` persona. Speaks quoted dialogue only, in the configured
 *    `rpVoice` (a clone voice with emote-selected reference clips). RP wins when
 *    both gates are somehow active (more specific gate).
 *  - Narration mode: gated on `PI_TTS_NARRATE` / `/tts narrate on` in a non-RP
 *    session. Narrates assistant prose in the separately-configured
 *    `narrationVoice` through a chunk/queue pipeline (synth N+1 while N plays).
 *
 * Engine + config + text live in pure modules under `tts/`; this shell is just
 * the pi glue: event wiring, the `/tts` command, the detached player, and the
 * cross-reload shared state. Never load-bearing: any failure (server down, no
 * player, synth error) degrades to a silent no-op and the turn always
 * completes.
 *
 * Config layers (lowest -> highest): shipped defaults -> <piAgentDir>/tts.json
 * -> <cwd>/.pi/tts.json (project layer only when the project is trusted).
 *
 * Environment:
 *   PI_RP_TTS=1        enable RP dialogue narration (also `/tts on`)
 *   PI_TTS_NARRATE=1   enable agent-output narration (also `/tts narrate on`)
 *   PI_TTS_URL=...     override the configured baseUrl
 *   PI_TTS_DISABLED=1  skip the whole extension (no event wiring, no `/tts`)
 *   PI_TTS_TRACE=<path> append one line per event to <path> for diagnostics
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { unlinkSync } from 'node:fs';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { loadTtsConfig, resolveVoice, resolveVoiceBaseUrl } from '../../../lib/node/pi/tts/config.ts';
import {
  setGptSovitsWeights,
  synthesize,
  probeReachable,
  probeCapabilities,
  type ProbeResult,
  type CloneCapabilities,
} from '../../../lib/node/pi/tts/engine.ts';
import {
  detectOoc,
  extractDialogue,
  extractProse,
  chunkProse,
  extractSegments,
  planSegmentRuns,
} from '../../../lib/node/pi/tts/text.ts';
import type { ResolvedVoice, TtsConfig } from '../../../lib/node/pi/tts/types.ts';
import { TTS_USAGE } from '../../../lib/node/pi/tts/usage.ts';

import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { makeDiagnostics } from '../../../lib/node/pi/recovery-diagnostics.ts';

// ──────────────────────────────────────────────────────────────────────
// Env + cross-extension bus reads (live runtime state, not pure logic)
// ──────────────────────────────────────────────────────────────────────

/**
 * Per-event diagnostic trace, written one line at a time to the file named by
 * `PI_TTS_TRACE` (the standard `_TRACE=<path>` convention). No-op - and never
 * throws - when the env is unset, so a silent-TTS session stays diagnosable
 * without a UI while tracing costs nothing by default.
 */
const { trace: dlog } = makeDiagnostics({
  label: 'tts',
  tracePath: process.env.PI_TTS_TRACE,
  debug: false,
});

/**
 * Persona gate: true only when an active persona declares `roleplay: true`.
 * Reads the shared globalThis slot the dotfiles persona extension publishes,
 * mirroring how avatar.ts gates its `[emote:]` addendum. If the persona
 * extension is not loaded the slot is absent and this returns false.
 */
export function isRoleplayActive(): boolean {
  try {
    const slot = (globalThis as Record<symbol, unknown>)[Symbol.for('@dotfiles/pi/persona/active')] as
      | { active?: { roleplay?: boolean } }
      | undefined;
    return Boolean(slot?.active?.roleplay);
  } catch {
    return false;
  }
}

/** Read the avatar's most recent emote signal off the shared globalThis bus. */
export function getLastEmote(): { emote: string; at: number } | undefined {
  try {
    const bus = (globalThis as Record<symbol, unknown>)[Symbol.for('@dotfiles/pi/avatar/emote-events')] as
      | { last?: { emote?: unknown; at?: unknown } }
      | undefined;
    const last = bus?.last;
    if (last && typeof last.emote === 'string' && typeof last.at === 'number') {
      return { emote: last.emote, at: last.at };
    }
  } catch {
    /* avatar not loaded -> no emote */
  }
  return undefined;
}

function joinText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => (p as { type?: string }).type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('\n');
}

/**
 * Render a reachability probe for `/tts status`: the HTTP status when the
 * server answered, a "starting / cold?" hint when the probe timed out (a
 * scale-to-zero or model-loading instance that synth's long timeout would
 * still ride out), or UNREACHABLE on outright connection refusal.
 */
function reachText(probe: ProbeResult): string {
  if (probe.status !== undefined) return `reachable (${probe.status})`;
  return probe.timedOut ? 'no response yet (starting / cold?)' : 'UNREACHABLE';
}

/**
 * Warn when a voice's kind does not match the instance it is pointed at, which
 * would otherwise 500 silently at synth time: a `preset` voice on a Base model,
 * or a `clone` voice on a CustomVoice model. Empty string = no mismatch / unknown.
 */
function capHint(resolved: ResolvedVoice, cap: CloneCapabilities | undefined): string {
  if (!cap) return '';
  if (resolved.kind === 'preset' && cap.modelType === 'base') {
    return '  ! preset voice on a Base model -> synth will 500; point it at a CustomVoice instance';
  }
  if (resolved.kind === 'clone' && cap.cloneSupported === false) {
    return '  ! clone voice on a CustomVoice model -> cloning unsupported; point it at a Base instance';
  }
  return '';
}

// ──────────────────────────────────────────────────────────────────────
// Cross-reload shared state
// ──────────────────────────────────────────────────────────────────────

interface TtsState {
  player: ChildProcess | null;
  paused: boolean;
  rpEnabled: boolean;
  narrateEnabled: boolean;
  rpVoiceOverride: string | undefined;
  narrationVoiceOverride: string | undefined;
  /** gpt-sovits: roster name whose weights are loaded on the server (legacy). */
  weightsSetFor: string | null;
  /** `at` of the last emote signal we consumed (de-dupe). */
  lastEmoteAt: number;
  /** Monotonic generation id; bumped on every barge-in to drop stale synths. */
  genId: number;
}

const SLOT = '__ttsState';

function state(): TtsState {
  const g = globalThis as unknown as Record<string, TtsState | undefined>;
  g[SLOT] ??= {
    player: null,
    paused: false,
    rpEnabled: envTruthy(process.env.PI_RP_TTS),
    narrateEnabled: envTruthy(process.env.PI_TTS_NARRATE),
    rpVoiceOverride: undefined,
    narrationVoiceOverride: undefined,
    weightsSetFor: null,
    lastEmoteAt: 0,
    genId: 0,
  };
  return g[SLOT];
}

function killPlayer(st: TtsState): void {
  if (st.player?.exitCode === null && st.player.signalCode === null) {
    try {
      st.player.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  st.player = null;
}

/** Bump the generation id and stop any in-flight playback (barge-in). */
function bargeIn(st: TtsState): number {
  st.genId += 1;
  killPlayer(st);
  return st.genId;
}

// ──────────────────────────────────────────────────────────────────────
// Config loading (honors project trust)
// ──────────────────────────────────────────────────────────────────────

function loadConfig(ctx: ExtensionContext | undefined): TtsConfig {
  const cwd = ctx?.cwd ?? process.cwd();
  let trusted = true;
  try {
    if (ctx && typeof ctx.isProjectTrusted === 'function') trusted = ctx.isProjectTrusted();
  } catch {
    trusted = false;
  }
  return loadTtsConfig(cwd, trusted);
}

// ──────────────────────────────────────────────────────────────────────
// Synth + ordered play pipeline (fire-and-forget; never awaited on the turn)
// ──────────────────────────────────────────────────────────────────────

/** Remove a temp file best-effort. */
function safeUnlink(file: string | null | undefined): void {
  if (!file) return;
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** One unit of speech: text spoken in a specific voice, with an optional emote. */
interface Cue {
  resolved: ResolvedVoice;
  text: string;
  emote?: string;
}

/**
 * Synthesize one cue; returns the temp file path, or null on failure. For the
 * gpt-sovits legacy engine it lazily re-points the server at the cue's voice
 * weights when they differ from the last set (so a mixed-voice sequence still
 * works); the openai engine has no such call.
 */
async function synthCue(st: TtsState, cfg: TtsConfig, cue: Cue): Promise<string | null> {
  try {
    if (cfg.api === 'gpt-sovits' && st.weightsSetFor !== cue.resolved.name) {
      await setGptSovitsWeights(cfg, cue.resolved.voice);
      st.weightsSetFor = cue.resolved.name;
    }
    return await synthesize(cfg, cue.resolved, cue.text, cue.emote);
  } catch (e) {
    // Server down / synth error / weights miss -> reset so we retry next time.
    st.weightsSetFor = null;
    dlog(`synth FAILED voice=${cue.resolved.name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Build the cue list for "narrated roleplay": segment the reply in reading
 * order and route quoted dialogue to the rp clone voice (carrying the turn
 * emote) and narration prose to the narrator voice. {@link planSegmentRuns}
 * coalesces consecutive same-voice segments into one run first, so when the rp
 * and narration voices are the SAME the whole reply collapses into continuous
 * prose (one synth call per chunk, natural prosody) instead of a request per
 * segment. Long runs are chunked and the total is capped at `maxCues`. If no
 * narration voice resolves, narration is skipped (degrades to dialogue-only).
 */
function buildSegmentCues(
  raw: string,
  rpResolved: ResolvedVoice,
  narrResolved: ResolvedVoice | undefined,
  emote: string | undefined,
  maxChunkChars: number,
  maxCues: number,
  splitByKind: boolean,
): Cue[] {
  const runs = planSegmentRuns(extractSegments(raw), rpResolved.name, narrResolved?.name ?? null, splitByKind);
  const cues: Cue[] = [];
  for (const run of runs) {
    const resolved = run.voice === rpResolved.name ? rpResolved : (narrResolved ?? rpResolved);
    const runEmote = run.hasDialogue ? emote : undefined;
    for (const piece of chunkProse(run.text, maxChunkChars, maxCues)) {
      cues.push({ resolved, text: piece, emote: runEmote });
      if (cues.length >= maxCues) return cues;
    }
  }
  return cues;
}

/** Play one file detached; resolve when the player exits (or fails to spawn). */
function playFile(st: TtsState, cfg: TtsConfig, file: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(cfg.player, [file], { detached: true, stdio: 'ignore' });
    st.player = child;
    child.on('exit', () => resolve());
    child.on('error', () => resolve()); // player missing -> silent no-op
  });
}

/**
 * Synthesize `cues` in order and play them sequentially, overlapping the synth
 * of cue N+1 with the playback of cue N (one synth in flight + the single
 * shared player). Each cue carries its own voice + emote, so a mixed-voice
 * sequence (narrated roleplay: dialogue in the clone voice, narration in the
 * narrator voice, possibly on different instances) interleaves in reading
 * order. A barge-in (genId bump) or pause flushes the queue and the in-flight
 * synth file, deleting temp files as it goes. RP-only and narration are the
 * single-voice cases of this one path.
 */
async function playSequence(st: TtsState, cfg: TtsConfig, cues: Cue[], genId: number): Promise<void> {
  if (cues.length === 0) return;
  const stale = (): boolean => genId !== st.genId;
  const drain = async (p: Promise<string | null>): Promise<void> => safeUnlink(await p.catch(() => null));
  if (stale()) return;

  // Synth the first cue, then keep exactly one synth in flight ahead of the
  // player: start cue N+1's synth before awaiting cue N's playback.
  let pending = synthCue(st, cfg, cues[0]);
  // oxlint-disable no-await-in-loop -- ordered playback: each cue must finish before the next plays
  for (let i = 0; i < cues.length; i++) {
    const file = await pending;
    pending = i + 1 < cues.length ? synthCue(st, cfg, cues[i + 1]) : Promise.resolve(null);
    dlog(
      `playSeq cue ${i}/${cues.length} voice=${cues[i].resolved.name} synth=${file ? 'ok' : 'NULL'} stale=${stale()} paused=${st.paused}`,
    );

    if (stale() || st.paused) {
      safeUnlink(file);
      await drain(pending);
      return;
    }
    if (file) {
      killPlayer(st);
      dlog(`playSeq playing cue ${i} via ${cfg.player}`);
      await playFile(st, cfg, file);
      safeUnlink(file);
    }
    if (stale()) {
      await drain(pending);
      return;
    }
  }
  // oxlint-enable no-await-in-loop
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function ttsExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_TTS_DISABLED)) return;

  const st = state();

  // Registration-time seed; re-pointed to the real session cwd on
  // `session_start`. The `/tts` completion resolver closes over this (pi
  // gives completions no `ctx`), so it must track the session's project dir.
  let sessionCwd = process.cwd();

  /** Roster voice names for completion (best-effort; completions get no ctx). */
  const voiceCandidates = (): { label: string }[] => {
    try {
      return Object.keys(loadTtsConfig(sessionCwd, true).voices).map((label) => ({ label }));
    } catch {
      return [];
    }
  };

  // Speak finalized assistant replies; track OOC pause state on every message.
  pi.on('message_end', (event, ctx) => {
    const msg = (event as { message?: { role?: string; content?: unknown } }).message;
    if (!msg) return undefined;
    const text = joinText(msg.content);

    // OOC pause/resume can appear in either role; update the flag first.
    const ooc = detectOoc(text);
    if (ooc === 'pause') st.paused = true;
    else if (ooc === 'resume') st.paused = false;

    if (msg.role !== 'assistant') return undefined;
    if (st.paused) return undefined;

    const cfg = loadConfig(ctx);
    const roleplay = isRoleplayActive();
    dlog(
      `message_end role=${msg.role} textLen=${text.length} rpEnabled=${st.rpEnabled} narrate=${st.narrateEnabled} roleplay=${roleplay} paused=${st.paused}`,
    );

    // RP mode wins when both gates are active (more specific gate).
    if (st.rpEnabled && roleplay) {
      const rpResolved = resolveVoice(cfg, st.rpVoiceOverride ?? cfg.rpVoice);
      dlog(`RP branch: rpVoice=${rpResolved ? `${rpResolved.name}/${rpResolved.kind}` : 'NONE'}`);
      if (!rpResolved) return undefined; // no usable RP voice configured

      // Emotion: consume this turn's avatar emote (avatar runs first, being a
      // global extension). De-dupe by signal `at` so a stale emote never bleeds.
      let emote: string | undefined;
      const sig = getLastEmote();
      if (sig && sig.at > st.lastEmoteAt) {
        emote = sig.emote;
        st.lastEmoteAt = sig.at;
      }

      // Narrated roleplay: when narration is ALSO enabled, voice the quoted
      // dialogue in the rp clone voice and the surrounding action/narration
      // prose in the narrator voice, interleaved in reading order. Otherwise
      // (RP-only, the common case) speak the quoted dialogue as a single cue.
      let cues: Cue[];
      if (st.narrateEnabled) {
        const narrResolved = resolveVoice(cfg, st.narrationVoiceOverride ?? cfg.narrationVoice);
        cues = buildSegmentCues(
          text,
          rpResolved,
          narrResolved,
          emote,
          cfg.maxChunkChars,
          cfg.maxNarrationChunks,
          cfg.splitSpeakerNarration,
        );
        dlog(`RP+narrate branch: narrVoice=${narrResolved?.name ?? 'NONE'} cues=${cues.length}`);
      } else {
        const dialogue = extractDialogue(text);
        dlog(`RP branch: dialogueLen=${dialogue.length} sample=${JSON.stringify(dialogue.slice(0, 80))}`);
        cues = dialogue ? [{ resolved: rpResolved, text: dialogue, emote }] : [];
      }
      if (cues.length === 0) return undefined; // pure-action / no-dialogue turn -> silent

      const gen = bargeIn(st);
      dlog(`RP branch: speaking gen=${gen} cues=${cues.length} emote=${emote ?? '(none)'}`);
      void playSequence(st, cfg, cues, gen);
      return undefined;
    }

    // Narration mode: narrate assistant prose in a non-RP session. Strip the
    // reply to speakable prose, chunk it on sentence/paragraph boundaries, and
    // run it through the same queue pipeline RP uses (no emote).
    if (st.narrateEnabled && !roleplay) {
      const prose = extractProse(text);
      if (!prose) return undefined; // nothing speakable (pure code / tool output)
      const resolved = resolveVoice(cfg, st.narrationVoiceOverride ?? cfg.narrationVoice);
      if (!resolved) return undefined; // no usable narration voice configured
      const chunks = chunkProse(prose, cfg.maxChunkChars, cfg.maxNarrationChunks);
      if (chunks.length === 0) return undefined;
      const gen = bargeIn(st);
      void playSequence(
        st,
        cfg,
        chunks.map((t) => ({ resolved, text: t })),
        gen,
      );
      return undefined;
    }

    return undefined;
  });

  // Barge-in on a fresh user message: stop the in-flight line immediately.
  pi.on('input', (event) => {
    if ((event as { source?: string }).source === 'extension') return { action: 'continue' as const };
    bargeIn(st);
    return { action: 'continue' as const };
  });

  pi.on('session_start', (_event, ctx) => {
    sessionCwd = ctx.cwd;
  });

  pi.on('session_shutdown', () => {
    killPlayer(st);
  });

  // ── /tts command ──────────────────────────────────────────────────
  pi.registerCommand('tts', {
    description: 'Control TTS narration (on|off|narrate on|off|voice <name>|narration-voice <name>|say <text>|status)',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(prefix, {
        on: { description: 'Enable RP dialogue narration' },
        off: { description: 'Disable RP dialogue narration' },
        narrate: { description: 'Toggle agent-output narration', args: ['on', 'off'] },
        voice: { description: 'Set the RP voice', args: () => voiceCandidates() },
        'narration-voice': { description: 'Set the narration voice', args: () => voiceCandidates() },
        say: { description: 'Speak literal text now (debug; uses the RP voice, bypasses gating)' },
        status: { description: 'Show modes, engine, resolved voices, reachability', args: () => voiceCandidates() },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(TTS_USAGE, 'info');
        return;
      }
      const cfg = loadConfig(ctx);
      const argStr = (args ?? '').trim();
      const tokens = argStr ? argStr.split(/\s+/) : [];
      const [sub, ...rest] = tokens;

      switch (sub) {
        case 'on':
          st.rpEnabled = true;
          ctx.ui.notify('TTS RP narration on', 'info');
          break;
        case 'off':
          st.rpEnabled = false;
          killPlayer(st);
          ctx.ui.notify('TTS RP narration off', 'info');
          break;
        case 'narrate': {
          const v = (rest[0] ?? '').toLowerCase();
          if (v === 'on') {
            st.narrateEnabled = true;
            ctx.ui.notify('TTS agent-output narration on (synthesis lands in Phase 3)', 'info');
          } else if (v === 'off') {
            st.narrateEnabled = false;
            killPlayer(st);
            ctx.ui.notify('TTS agent-output narration off', 'info');
          } else {
            ctx.ui.notify('Usage: /tts narrate on|off', 'warning');
          }
          break;
        }
        case 'voice': {
          const name = rest.join(' ').trim();
          if (name && resolveVoice(cfg, name)) {
            st.rpVoiceOverride = name;
            st.weightsSetFor = null; // force gpt-sovits re-point on next line
            ctx.ui.notify(`TTS RP voice -> ${name}`, 'info');
          } else {
            ctx.ui.notify(`Unknown voice. Known: ${Object.keys(cfg.voices).join(', ') || '(none)'}`, 'warning');
          }
          break;
        }
        case 'narration-voice': {
          const name = rest.join(' ').trim();
          if (name && resolveVoice(cfg, name)) {
            st.narrationVoiceOverride = name;
            ctx.ui.notify(`TTS narration voice -> ${name}`, 'info');
          } else {
            ctx.ui.notify(`Unknown voice. Known: ${Object.keys(cfg.voices).join(', ') || '(none)'}`, 'warning');
          }
          break;
        }
        case 'say': {
          const text = rest.join(' ').trim();
          if (!text) {
            ctx.ui.notify('Usage: /tts say <text>', 'warning');
            break;
          }
          const resolved = resolveVoice(cfg, st.rpVoiceOverride ?? cfg.rpVoice);
          if (!resolved) {
            ctx.ui.notify(
              `No usable RP voice configured. Known: ${Object.keys(cfg.voices).join(', ') || '(none)'}`,
              'warning',
            );
            break;
          }
          // Debug path: synth + play the literal text on demand via the RP
          // synth pipeline, bypassing the persona/dialogue/pause gating so a
          // single command exercises the engine end to end.
          st.paused = false;
          ctx.ui.notify(`TTS say -> ${resolved.name} (${resolved.kind})`, 'info');
          const gen = bargeIn(st);
          void playSequence(st, cfg, [{ resolved, text }], gen);
          break;
        }
        case 'status':
        default: {
          const persona = isRoleplayActive() ? 'roleplay-active' : 'inactive';
          const target = sub === 'status' ? rest.join(' ').trim() : '';

          // /tts status <voice>: show + probe one configured voice's endpoint.
          if (target) {
            const rv = resolveVoice(cfg, target);
            if (!rv) {
              ctx.ui.notify(
                `Unknown voice "${target}". Known: ${Object.keys(cfg.voices).join(', ') || '(none)'}`,
                'warning',
              );
              break;
            }
            const url = resolveVoiceBaseUrl(cfg, rv.voice);
            const source = rv.voice.baseUrl ? 'voice override' : 'inherited fallback';
            const auth = rv.voice.authHeader
              ? `override (${rv.voice.authHeader.name})`
              : cfg.authHeader
                ? `inherited (${cfg.authHeader.name})`
                : 'off';
            const status = await probeReachable(cfg, rv.voice);
            const reach = reachText(status);
            const cap = status.status === undefined ? undefined : await probeCapabilities(cfg, rv.voice);
            const hint = capHint(rv, cap);
            ctx.ui.notify(
              [
                `voice ${rv.name} (${rv.kind})`,
                `url: ${url} [${reach}] (${source})`,
                `auth: ${auth}`,
                ...(hint ? [hint] : []),
              ].join('\n'),
              status.status === undefined || hint ? 'warning' : 'info',
            );
            break;
          }

          // General status: probe the resolved rp + narration voices, which may
          // live on two different instances.
          const rpName = st.rpVoiceOverride ?? cfg.rpVoice;
          const narrName = st.narrationVoiceOverride ?? cfg.narrationVoice;
          const rpResolved = resolveVoice(cfg, rpName);
          const narrResolved = resolveVoice(cfg, narrName);
          const rpStatus = rpResolved ? await probeReachable(cfg, rpResolved.voice) : undefined;
          const narrStatus = narrResolved ? await probeReachable(cfg, narrResolved.voice) : undefined;
          const rpCap =
            rpResolved && rpStatus?.status !== undefined ? await probeCapabilities(cfg, rpResolved.voice) : undefined;
          const narrCap =
            narrResolved && narrStatus?.status !== undefined
              ? await probeCapabilities(cfg, narrResolved.voice)
              : undefined;
          const voiceLine = (
            label: string,
            name: string,
            resolved: ResolvedVoice | undefined,
            status: ProbeResult | undefined,
            cap: CloneCapabilities | undefined,
          ): string => {
            if (!name) return `${label}: (unset)`;
            if (!resolved) return `${label}: ${name} (unresolved)`;
            const url = resolveVoiceBaseUrl(cfg, resolved.voice);
            const hint = capHint(resolved, cap);
            return `${label}: ${name} (${resolved.kind}) @ ${url} [${status ? reachText(status) : 'UNREACHABLE'}]${hint ? `\n${hint}` : ''}`;
          };
          const anyDown =
            (rpResolved !== undefined && rpStatus?.status === undefined) ||
            (narrResolved !== undefined && narrStatus?.status === undefined);
          const anyMismatch =
            (rpResolved !== undefined && capHint(rpResolved, rpCap) !== '') ||
            (narrResolved !== undefined && capHint(narrResolved, narrCap) !== '');
          ctx.ui.notify(
            [
              `tts: rp=${st.rpEnabled ? 'on' : 'off'} narrate=${st.narrateEnabled ? 'on' : 'off'}${st.paused ? ' (paused)' : ''}`,
              `persona: ${persona}`,
              `engine: ${cfg.api} (fallback url ${cfg.baseUrl})`,
              voiceLine('rpVoice', rpName, rpResolved, rpStatus, rpCap),
              voiceLine('narrationVoice', narrName, narrResolved, narrStatus, narrCap),
            ].join('\n'),
            anyDown || anyMismatch ? 'warning' : 'info',
          );
          break;
        }
      }
    },
  });
}
