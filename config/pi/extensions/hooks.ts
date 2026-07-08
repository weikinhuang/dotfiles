/**
 * User-configurable hook system for pi - modelled on Claude Code's
 * `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` /
 * `SessionStart` hooks.
 *
 * Hooks are user-trusted shell scripts (the user authored / installed
 * the entry, not the model) wired in via two JSONC config files:
 *
 *   1. Project rules:  `.pi/hooks.json` inside ctx.cwd
 *   2. User rules:     `<piAgentDir>/hooks.json` (default `~/.pi/agent/hooks.json`)
 *
 * Both files are re-read on every event so an edit takes effect on the
 * next tool call without needing `/reload`. A third "session" layer
 * lives in-memory on the extension closure (currently empty - reserved
 * for a future `/hook-add` slash command) and short-circuits before
 * project/user layers, matching `bash-permissions`'s layer ordering.
 *
 * Composition with the built-in gates: hooks fire AFTER
 * `bash-permissions`, `filesystem`, and `sandbox` have approved the
 * call. A bash command denied by the bash gate never reaches a
 * `PreToolUse` hook (D3 in `plans/pi-cc-parity.md`). Hooks themselves
 * run OUTSIDE the kernel sandbox by default - they're user code, not
 * model-emitted bash. Per-hook opt-in via `"sandboxed": true`
 * delegates the wrap to `lib/node/pi/sandbox/wrapper-slot.ts` (v1
 * leaves the actual wrap to the runner; the field is plumbed end-to-
 * end so a follow-up commit can flip it on without a schema bump).
 *
 * Event → pi-event wiring:
 *
 *   - `PreToolUse`       → `tool_call`              (first `block` short-circuits)
 *   - `PostToolUse`      → `tool_result`            (`block` illegal; appends additionalContext)
 *   - `UserPromptSubmit` → `before_agent_start`     (`block` cancels the turn; appends to systemPrompt)
 *   - `SessionStart`     → `session_start`          (fire-and-forget)
 *   - `Stop`             → `session_shutdown`       (fire-and-forget)
 *
 * Decision protocol per event (see `lib/node/pi/hooks/runner.ts` for
 * how stdout is parsed into a {@link HookResult}):
 *
 *   - `block`     PreToolUse → tool error with `reason`.
 *                 UserPromptSubmit → cancels the turn with `reason`.
 *                 PostToolUse / Stop / SessionStart → illegal; logged
 *                 once and treated as `continue`.
 *   - `allow`     Skip remaining hooks for this event; let the tool /
 *                 prompt proceed. No-op outside PreToolUse.
 *   - `continue`  Run the next hook in this event, then the tool /
 *                 prompt. Default when stdout is empty or unparseable.
 *
 * `additionalContext` placement:
 *
 *   - PreToolUse  ignored (no tool result yet to attach to).
 *   - PostToolUse appended as a second text part on the tool result
 *                 (composes cleanly with `tool-output-condenser` and
 *                 `edit-recovery`, which run alphabetically later).
 *   - UserPromptSubmit appended to `event.systemPrompt` so the model
 *                 sees the extra context before the turn.
 *   - Stop / SessionStart ignored.
 *
 * Commands:
 *   /hooks       List active hooks grouped by source (session / project /
 *                user) and event - mirrors `/bash-permissions`'s output.
 *
 * Environment:
 *   PI_HOOKS_DISABLED=1          skip the extension entirely
 *   PI_HOOKS_TIMEOUT_MS=<n>      default per-hook timeout (default 60000)
 *   PI_HOOKS_DEBUG=1             ctx.ui.notify each fired hook
 *   PI_HOOKS_TRACE=<path>        append one line per fired hook to <path>
 *
 * Pure helpers (`loadHooks`, `matchesMatcher`, `runHook`, …) live
 * under `lib/node/pi/hooks/` so they can be unit-tested under vitest
 * without pulling in the pi runtime.
 */

import { homedir } from 'node:os';

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  type Hook,
  type HookEvent,
  HOOK_EVENTS,
  loadHooks,
  projectHooksPath,
  userHooksPath,
} from '../../../lib/node/pi/hooks/config.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { resolveCommand } from '../../../lib/node/pi/hooks/command.ts';
import { formatHooksList } from '../../../lib/node/pi/hooks/list.ts';
import { matchesMatcher } from '../../../lib/node/pi/hooks/matcher.ts';
import { appendSystemPromptContext, appendToolResultContext } from '../../../lib/node/pi/hooks/reduce.ts';
import { HOOKS_USAGE } from '../../../lib/node/pi/hooks/usage.ts';
import { type HookResult, nodeChildProcessSpawn, runHook } from '../../../lib/node/pi/hooks/runner.ts';
import { envTruthy, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';
import { makeDiagnostics } from '../../../lib/node/pi/recovery-diagnostics.ts';

const DEFAULT_TIMEOUT_MS = 60000;

interface BasePayload {
  event: HookEvent;
  cwd: string;
  session_id: string;
}

interface ToolPayload extends BasePayload {
  tool: string;
  input: unknown;
}

interface PromptPayload extends BasePayload {
  prompt: string;
}

type HookPayload = BasePayload | ToolPayload | PromptPayload;

function getSessionId(ctx: ExtensionContext): string {
  // pi's ExtensionContext exposes `session.id`; defensively widen so a
  // missing field surfaces as the empty string rather than a TypeError.
  const session = (ctx as unknown as { session?: { id?: unknown } }).session;
  return typeof session?.id === 'string' ? session.id : '';
}

export default function hooks(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_HOOKS_DISABLED)) return;

  const defaultTimeoutMs = parsePositiveInt(process.env.PI_HOOKS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const { trace, notify } = makeDiagnostics({
    label: 'hooks',
    tracePath: process.env.PI_HOOKS_TRACE,
    debug: envTruthy(process.env.PI_HOOKS_DEBUG),
  });

  /** Session-layer hooks supplied at runtime. Reserved for a future
   *  `/hook-add` command; today this stays empty so the layer slot is
   *  wired without ceremony. Lives in the closure so it survives
   *  across tool calls within one session and clears on shutdown. */
  const sessionHooks: Partial<Record<HookEvent, Hook[]>> = {};

  const loadEvent = (cwd: string, event: HookEvent): Hook[] => {
    return loadHooks({ cwd, sessionHooks })[event];
  };

  /** Run one hook end-to-end. Wraps `runHook` with the abort signal,
   *  resolved command, and shared spawn implementation. */
  const fire = async (hook: Hook, payload: HookPayload, ctx: ExtensionContext): Promise<HookResult> => {
    const controller = new AbortController();
    const resolved: Hook = { ...hook, command: resolveCommand(hook.command, ctx.cwd, homedir()) };
    try {
      return await runHook({
        hook: resolved,
        payload,
        signal: controller.signal,
        cwd: ctx.cwd,
        spawnFn: nodeChildProcessSpawn,
        defaultTimeoutMs,
      });
    } finally {
      controller.abort();
    }
  };

  // ──────────────────────────────────────────────────────────────────
  // PreToolUse → tool_call
  // ──────────────────────────────────────────────────────────────────

  pi.on('tool_call', async (event, ctx) => {
    const toolName = (event as { toolName?: unknown }).toolName;
    if (typeof toolName !== 'string') return undefined;
    const candidates = loadEvent(ctx.cwd, 'PreToolUse').filter((h) => matchesMatcher(h.matcher, toolName));
    if (candidates.length === 0) return undefined;

    for (const hook of candidates) {
      const payload: ToolPayload = {
        event: 'PreToolUse',
        tool: toolName,
        input: (event as { input?: unknown }).input,
        cwd: ctx.cwd,
        session_id: getSessionId(ctx),
      };
      // oxlint-disable-next-line no-await-in-loop -- hooks fire sequentially so the first `block` can short-circuit the remainder
      const result = await fire(hook, payload, ctx);
      trace(`PreToolUse ${hook.scope}:${hook.command} → ${result.decision}`);
      notify(ctx, `hooks: PreToolUse(${toolName}) → ${result.decision} via ${hook.command}`, 'info');

      if (result.decision === 'block') {
        return { block: true, reason: result.reason ?? `Blocked by PreToolUse hook ${hook.command}` };
      }
      if (result.decision === 'allow') return undefined;
      // continue → next hook
    }
    return undefined;
  });

  // ──────────────────────────────────────────────────────────────────
  // PostToolUse → tool_result
  // ──────────────────────────────────────────────────────────────────

  pi.on('tool_result', async (event, ctx) => {
    const toolName = (event as { toolName?: unknown }).toolName;
    if (typeof toolName !== 'string') return undefined;
    const candidates = loadEvent(ctx.cwd, 'PostToolUse').filter((h) => matchesMatcher(h.matcher, toolName));
    if (candidates.length === 0) return undefined;

    const content = (event as { content?: unknown }).content;
    const appended: string[] = [];
    for (const hook of candidates) {
      const payload: ToolPayload = {
        event: 'PostToolUse',
        tool: toolName,
        input: (event as { input?: unknown }).input,
        cwd: ctx.cwd,
        session_id: getSessionId(ctx),
      };
      // oxlint-disable-next-line no-await-in-loop -- hooks fire sequentially so an `allow` decision can short-circuit later hooks for the same tool_result
      const result = await fire(hook, payload, ctx);
      trace(`PostToolUse ${hook.scope}:${hook.command} → ${result.decision}`);
      notify(ctx, `hooks: PostToolUse(${toolName}) → ${result.decision} via ${hook.command}`, 'info');

      if (result.decision === 'block') {
        // `block` is illegal on PostToolUse - the tool already ran, so
        // there's nothing to block. Log once per (scope, command) and
        // treat the hook as `continue` so the pipeline keeps moving.
        console.warn(
          `[hooks] PostToolUse hook ${JSON.stringify(hook.command)} returned decision="block"; ` +
            'PostToolUse cannot block (the tool already ran). Treating as continue.',
        );
      }
      if (result.additionalContext) appended.push(result.additionalContext);
      if (result.decision === 'allow') break;
    }

    if (appended.length === 0) return undefined;

    return { content: appendToolResultContext(content, appended) as never };
  });

  // ──────────────────────────────────────────────────────────────────
  // UserPromptSubmit → before_agent_start
  // ──────────────────────────────────────────────────────────────────

  pi.on('before_agent_start', async (event, ctx) => {
    const candidates = loadEvent(ctx.cwd, 'UserPromptSubmit');
    if (candidates.length === 0) return undefined;

    const prompt = (() => {
      const raw =
        (event as { userPrompt?: unknown; prompt?: unknown }).userPrompt ?? (event as { prompt?: unknown }).prompt;
      return typeof raw === 'string' ? raw : '';
    })();
    const systemPrompt = (() => {
      const raw = (event as { systemPrompt?: unknown }).systemPrompt;
      return typeof raw === 'string' ? raw : '';
    })();
    const appended: string[] = [];
    for (const hook of candidates) {
      const payload: PromptPayload = {
        event: 'UserPromptSubmit',
        prompt,
        cwd: ctx.cwd,
        session_id: getSessionId(ctx),
      };
      // oxlint-disable-next-line no-await-in-loop -- hooks fire sequentially so the first `block` can cancel the turn before later hooks run
      const result = await fire(hook, payload, ctx);
      trace(`UserPromptSubmit ${hook.scope}:${hook.command} → ${result.decision}`);
      notify(ctx, `hooks: UserPromptSubmit → ${result.decision} via ${hook.command}`, 'info');

      if (result.decision === 'block') {
        // Cancel the turn. pi treats a thrown error from this event as
        // a turn cancellation; without a runtime-typed cancel hook the
        // best signal we have is to throw with the user's reason.
        const reason = result.reason ?? `Cancelled by UserPromptSubmit hook ${hook.command}`;
        throw new Error(`hooks: ${reason}`);
      }
      if (result.additionalContext) appended.push(result.additionalContext);
      if (result.decision === 'allow') break;
    }

    if (appended.length === 0) return undefined;
    return { systemPrompt: appendSystemPromptContext(systemPrompt, appended) };
  });

  // ──────────────────────────────────────────────────────────────────
  // SessionStart / Stop → fire-and-forget
  // ──────────────────────────────────────────────────────────────────

  const fireAndForget = (eventName: HookEvent, ctx: ExtensionContext): void => {
    const candidates = loadEvent(ctx.cwd, eventName);
    if (candidates.length === 0) return;
    const session_id = getSessionId(ctx);
    for (const hook of candidates) {
      const payload: BasePayload = { event: eventName, cwd: ctx.cwd, session_id };
      // Intentional fire-and-forget: we don't await, and we swallow
      // rejections so a misbehaving SessionStart / Stop hook can't
      // crash the session or block shutdown.
      fire(hook, payload, ctx)
        .then((result) => {
          trace(`${eventName} ${hook.scope}:${hook.command} → ${result.decision}`);
          notify(ctx, `hooks: ${eventName} → ${result.decision} via ${hook.command}`, 'info');
        })
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(`[hooks] ${eventName} hook ${JSON.stringify(hook.command)} failed: ${reason}`);
        });
    }
  };

  pi.on('session_start', (_event, ctx) => {
    fireAndForget('SessionStart', ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    fireAndForget('Stop', ctx);
    for (const event of HOOK_EVENTS) delete sessionHooks[event];
  });

  // ──────────────────────────────────────────────────────────────────
  // /hooks command
  // ──────────────────────────────────────────────────────────────────

  pi.registerCommand('hooks', {
    description: 'Show all registered hooks (session / project / user) grouped by event',
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(HOOKS_USAGE, 'info');
        return;
      }
      const merged = loadHooks({ cwd: ctx.cwd, sessionHooks });
      const sources: { scope: 'session' | 'project' | 'user'; where: string }[] = [
        { scope: 'session', where: '(in-memory)' },
        { scope: 'project', where: projectHooksPath(ctx.cwd) },
        { scope: 'user', where: userHooksPath() },
      ];
      ctx.ui.notify(formatHooksList(merged, sources, HOOK_EVENTS), 'info');
    },
  });
}
