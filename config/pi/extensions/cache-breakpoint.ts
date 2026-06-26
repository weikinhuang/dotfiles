/**
 * cache-breakpoint - relocate the conversation prompt-cache breakpoint off
 * volatile, reminder-bearing tail messages on anthropic-style providers.
 *
 * Why
 * ───
 * Pi caches conversation history with a SINGLE `cache_control` /
 * `cachePoint` breakpoint on the last user/toolResult message
 * (`packages/ai/src/api/anthropic-messages.ts`,
 * `packages/ai/src/api/bedrock-converse-stream.ts`). Several extensions
 * (todo, scratchpad, bg-bash, context-budget, roleplay) splice an
 * ephemeral `<system-reminder>` onto that same last message every turn
 * via `context-reminder.ts`. Because the reminder is regenerated fresh
 * each request and never persisted, the cached prefix always ends with
 * content the next turn no longer reproduces, so the conversation cache
 * never gets a read hit: `cacheRead` collapses to system+tools and the
 * whole conversation re-writes at the 1.25x cache-write rate every turn.
 * A real session blew up to ~$32, 90% of it cache-write. See
 * `extensions/AGENTS.md` ("Auto-injecting state every turn") for the
 * documented trap this extension closes.
 *
 * What
 * ────
 * On `before_provider_request`, when the tail message carries a reminder,
 * move the breakpoint onto the PREVIOUS user message (which is always
 * reminder-free and byte-stable across turns) so the bulk of the
 * conversation caches again. All logic lives in the pure helper
 * `lib/node/pi/cache-breakpoint.ts`; this shell only wires it to the hook.
 *
 * Scope
 * ─────
 * Only anthropic-style payloads (a `cachePoint` block for Bedrock
 * Converse, or a `cache_control` attribute for direct Anthropic) are
 * touched. OpenAI-compatible payloads (e.g. a local llama.cpp server)
 * carry neither marker, so the helper no-ops and they are left untouched.
 *
 * Config
 * ──────
 *   PI_CACHE_BREAKPOINT_DISABLED=1   skip the extension entirely
 *   PI_CACHE_BREAKPOINT_TRACE=<path> append a per-request decision line
 *
 * See cache-breakpoint.md for the full reference.
 */

import { appendFileSync } from 'node:fs';

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { relocateTailCacheBreakpoint } from '../../../lib/node/pi/cache-breakpoint.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

export default function cacheBreakpointExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_CACHE_BREAKPOINT_DISABLED)) return;

  const tracePath = process.env.PI_CACHE_BREAKPOINT_TRACE;
  const trace = (msg: string): void => {
    if (!tracePath) return;
    try {
      appendFileSync(tracePath, `[cache-breakpoint] ${msg}\n`, 'utf8');
    } catch {}
  };

  pi.on('before_provider_request', (event) => {
    const result = relocateTailCacheBreakpoint(event.payload);
    trace(`${result.changed ? 'changed' : 'no-op'} style=${result.style ?? 'none'} reason=${result.reason}`);
    // Mutated in place; return it only when we actually changed something
    // so a no-op never alters the request pi would otherwise send.
    return result.changed ? event.payload : undefined;
  });
}
