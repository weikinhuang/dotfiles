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
 * (todo, scratchpad, bg-bash, roleplay) splice an
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
import { randomUUID } from 'node:crypto';

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import { isolateResponsesCacheKey, relocateTailCacheBreakpoint } from '../../../lib/node/pi/cache-breakpoint.ts';
import { cacheTraceConfig, type CacheTraceLevel } from '../../../lib/node/pi/cache-trace-config.ts';
import {
  appendCacheTrace,
  appendCacheTraceRecords,
  cacheResponseTrace,
  createCacheTracer,
} from '../../../lib/node/pi/cache-trace.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

function notifyTrace(ctx: ExtensionContext, message: string): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, 'warning');
    else console.error(`[cache-trace] ${message}`);
  } catch {
    /* Diagnostics must not affect execution. */
  }
}

export default function cacheBreakpointExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_CACHE_BREAKPOINT_DISABLED)) return;

  pi.registerFlag('cache-trace', {
    description: 'Cache trace destination: auto sidecar, off, or a file path',
    type: 'string',
  });
  pi.registerFlag('cache-trace-level', {
    description: 'Cache logging: hash (private), system, or system-tools (sensitive text)',
    type: 'string',
  });

  const tracePath = process.env.PI_CACHE_BREAKPOINT_TRACE;
  const trace = (msg: string): void => {
    if (!tracePath) return;
    try {
      appendFileSync(tracePath, `[cache-breakpoint] ${msg}\n`, 'utf8');
    } catch {}
  };

  let payloadTracePath: string | undefined;
  let level: CacheTraceLevel = 'hash';
  let runId = randomUUID();
  let payloadTracer = createCacheTracer({ runId, level });
  let sequence = 0;
  let loggingFailed = false;
  pi.on('session_start', (_event, ctx) => {
    payloadTracePath = undefined;
    loggingFailed = false;
    try {
      const config = cacheTraceConfig(
        { destination: pi.getFlag('cache-trace'), level: pi.getFlag('cache-trace-level') },
        process.env,
        ctx.sessionManager.getSessionFile(),
        ctx.cwd,
      );
      payloadTracePath = config.path;
      level = config.level;
      if (config.path && level !== 'hash')
        notifyTrace(
          ctx,
          `Cache trace ${level} logging stores sensitive system text${level === 'system-tools' ? ' and tool definitions' : ''} locally at ${config.path}`,
        );
    } catch (error) {
      notifyTrace(ctx, `Cache tracing disabled: ${error instanceof Error ? error.message : 'invalid configuration'}`);
    }
    runId = randomUUID();
    payloadTracer = createCacheTracer({ runId, level });
    sequence = 0;
  });
  pi.on('session_shutdown', () => {
    payloadTracer = createCacheTracer();
    payloadTracePath = undefined;
    sequence = 0;
  });
  pi.on('message_end', (event, ctx) => {
    if (payloadTracePath && sequence > 0 && event.message.role === 'assistant') {
      appendCacheTrace(
        payloadTracePath,
        cacheResponseTrace(sequence, event.message.usage, runId),
        ctx.sessionManager.getSessionFile(),
      );
      sequence = 0;
    }
  });

  pi.on('before_provider_request', (event, ctx) => {
    const result = relocateTailCacheBreakpoint(event.payload);
    const keyResult =
      envTruthy(process.env.PI_CACHE_BREAKPOINT_RESPONSES_KEY) && ctx.model
        ? isolateResponsesCacheKey(event.payload, {
            api: String(ctx.model.api),
            provider: ctx.model.provider,
            model: ctx.model.id,
            sessionId: ctx.sessionManager.getSessionId(),
          })
        : { changed: false };
    trace(`${result.changed ? 'changed' : 'no-op'} style=${result.style ?? 'none'} reason=${result.reason}`);
    if (payloadTracePath) {
      sequence = 0;
      try {
        const record = payloadTracer(event.payload, {
          provider: ctx.model?.provider ?? 'unknown',
          model: ctx.model?.id ?? 'unknown',
        });
        const { snapshots = [], ...metadata } = record;
        const written = appendCacheTraceRecords(
          payloadTracePath,
          [
            ...snapshots,
            { ...metadata, sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() },
          ],
          ctx.sessionManager.getSessionFile(),
        );
        if (written) sequence = record.sequence;
        else {
          sequence = 0;
          // Missing snapshots must not be referenced after a failed append; start a new diagnostic run.
          runId = randomUUID();
          payloadTracer = createCacheTracer({ runId, level });
          if (!loggingFailed)
            notifyTrace(ctx, 'Cache trace could not be written; check path, permissions, and symlinks.');
          loggingFailed = true;
        }
      } catch {
        // Unserializable payloads must not break provider requests.
      }
    }
    // Mutated in place; return it only when we actually changed something
    // so a no-op never alters the request pi would otherwise send.
    return result.changed || keyResult.changed ? event.payload : undefined;
  });
}
