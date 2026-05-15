/**
 * Inline `ExtensionFactory` installed inside a spawned subagent's child
 * session to enforce the agent's frontmatter-declared
 * `bashAllow` / `bashDeny` / `writeRoots` / `requestOptions`.
 *
 * Pi's extension loader supports passing inline factories via
 * `DefaultResourceLoader.extensionFactories`, which works even when the
 * resource loader is built with `noExtensions: true` (the layered-on-disk
 * extensions are skipped, but inline factories still load). That is the
 * mechanism `subagent.ts` uses to enforce per-agent gates inside the
 * child without dragging the whole bash-permissions / protected-paths /
 * persona stack into the subagent process.
 *
 * The factory closes over the agent's resolved configuration and
 * registers two handlers on the child's `ExtensionAPI`:
 *
 *   - `tool_call`: enforces `bashAllow` / `bashDeny` against `bash`
 *     calls (using the same `evaluateBashPolicy` persona uses), and
 *     `writeRoots` against `write` / `edit` calls (using the same
 *     `decideWriteGate` helper).
 *   - `before_provider_request`: deep-merges `requestOptions` into the
 *     outgoing payload via `applyRequestOptions`.
 *
 * Pure module — no pi imports. The runtime types pi expects
 * (`ExtensionAPI`, `ToolCallEvent`) are described loosely here so the
 * factory stays unit-testable under vitest. The runtime caller in
 * `subagent.ts` casts the result to pi's `ExtensionFactory`.
 *
 * NOTE: child sessions run with `hasUI: false`, so the write gate's
 * "prompt the user" branch never fires. This factory therefore treats
 * an outside-writeRoots write as a **block** in the child's context
 * (producing a tool-result error string the model can react to).
 */

import { evaluateBashPolicy } from '../persona/bash-policy.ts';
import { isInsideWriteRoots } from '../persona/match.ts';
import { applyRequestOptions, type RequestOptionsConfig } from '../request-options.ts';

// ──────────────────────────────────────────────────────────────────────
// Loose runtime shapes — pi's actual types are pulled in by the caller.
// ──────────────────────────────────────────────────────────────────────

export interface AgentGateConfig {
  /** Agent name — surfaced in block reason strings. */
  name: string;
  /** bashAllow / bashDeny patterns (same matcher as persona). */
  bashAllow: readonly string[];
  bashDeny: readonly string[];
  /** Already-resolved absolute writeRoots. */
  resolvedWriteRoots: readonly string[];
  /** Optional requestOptions block. */
  requestOptions?: RequestOptionsConfig;
}

/** Subset of pi's `ExtensionContext` we read inside the handlers. */
export interface AgentGateContext {
  cwd: string;
  model?: { api?: string };
}

/** Subset of pi's `ToolCallEvent` we react to. */
export interface AgentGateToolCallEvent {
  toolName: string;
  input?: { command?: unknown; path?: unknown } & Record<string, unknown>;
}

export interface AgentGateBeforeProviderRequestEvent {
  payload: unknown;
}

/**
 * Tool-call handler return shape — matches pi's
 * `ExtensionHandlerResult<ToolCallEvent>`. Returning `undefined` lets
 * the call proceed; `{ block: true, reason }` denies the call with the
 * given message surfaced to the model.
 */
export type AgentGateToolCallResult = undefined | { block: true; reason: string };

/** Subset of pi's `ExtensionAPI` the factory uses. */
export interface AgentGateExtensionAPI {
  on(
    event: 'tool_call',
    handler: (event: AgentGateToolCallEvent, ctx: AgentGateContext) => AgentGateToolCallResult,
  ): void;
  on(
    event: 'before_provider_request',
    handler: (event: AgentGateBeforeProviderRequestEvent, ctx: AgentGateContext) => unknown,
  ): void;
}

// ──────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a `tool_call` event into a gate decision. Pure — extracted
 * from `createAgentGateFactory` so the decision matrix is unit-testable
 * without driving an `ExtensionAPI` mock.
 *
 * Decision matrix:
 *   - `subagent` / `subagent_send` tool calls are NEVER gated (matches
 *     `persona.ts` behaviour — children chain freely).
 *   - `bash` runs `evaluateBashPolicy` against the agent's allow/deny
 *     lists. A non-allow decision blocks the call with the policy's
 *     reason string.
 *   - `write` / `edit` resolve the path against `cwd` and check
 *     `isInsideWriteRoots`. `resolvedWriteRoots` empty + the agent
 *     having declared the field at all (caller's invariant: pass
 *     `enforceWriteRoots: true` only when the frontmatter actually had
 *     a `writeRoots:` block) blocks every write. Outside the roots →
 *     block. Inside or unconstrained → allow.
 *   - Every other tool name passes through.
 */
export interface DecideAgentGateOptions {
  event: AgentGateToolCallEvent;
  config: AgentGateConfig;
  cwd: string;
  /** Path resolver injected so this stays a pure module under vitest. */
  resolveAbsolute: (cwd: string, inputPath: string) => string;
  /**
   * Whether `writeRoots` is a binding allowlist for the agent. Caller
   * sets this to `true` when the frontmatter literally had a
   * `writeRoots:` block (even if empty), `false` when omitted entirely.
   * Empty-list-with-binding means "no writes allowed".
   */
  enforceWriteRoots: boolean;
}

export function decideAgentGate(opts: DecideAgentGateOptions): AgentGateToolCallResult {
  const { event, config, cwd, resolveAbsolute, enforceWriteRoots } = opts;

  // Subagent dispatch is never gated — chain freely (matches persona.ts).
  if (event.toolName === 'subagent' || event.toolName === 'subagent_send') return undefined;

  if (event.toolName === 'bash') {
    const rawCommand: unknown = event.input?.command ?? '';
    const command = typeof rawCommand === 'string' ? rawCommand : '';
    if (!command.trim()) return undefined;
    if (config.bashAllow.length === 0 && config.bashDeny.length === 0) return undefined;
    const policy = evaluateBashPolicy({
      command,
      bashAllow: config.bashAllow,
      bashDeny: config.bashDeny,
      // bash-policy formats the reason as `persona "<name>" denies…`. Pass
      // a name like `agent <name>` so the resulting string reads
      // `persona "agent <name>" denies…` — ugly with the leading
      // "persona" but readable; renaming the param is left for a
      // follow-up that touches both consumers in lockstep.
      personaName: `agent ${config.name}`,
    });
    if (policy.kind === 'block') {
      return { block: true, reason: policy.reason };
    }
    return undefined;
  }

  if (event.toolName === 'write' || event.toolName === 'edit') {
    if (!enforceWriteRoots) return undefined;
    const rawPath: unknown = event.input?.path ?? '';
    const inputPath = (typeof rawPath === 'string' ? rawPath : '').trim();
    if (!inputPath) return undefined;
    const absolute = resolveAbsolute(cwd, inputPath);
    if (config.resolvedWriteRoots.length === 0) {
      return {
        block: true,
        reason: `agent "${config.name}" declares no writeRoots; ${event.toolName} of "${inputPath}" denied`,
      };
    }
    if (isInsideWriteRoots(absolute, config.resolvedWriteRoots)) return undefined;
    return {
      block: true,
      reason:
        `agent "${config.name}" allows writes only inside: ${config.resolvedWriteRoots.join(', ')} — ` +
        `"${inputPath}" is outside`,
    };
  }

  return undefined;
}

export interface CreateAgentGateFactoryOptions {
  config: AgentGateConfig;
  enforceWriteRoots: boolean;
  /**
   * Path resolver — the runtime caller passes Node's `path.resolve`.
   * Keeping it injectable lets tests drive the factory without touching
   * the filesystem.
   */
  resolveAbsolute: (cwd: string, inputPath: string) => string;
}

/**
 * Build a pi-compatible `ExtensionFactory` (typed loosely here as
 * `(pi: AgentGateExtensionAPI) => void`) that installs the agent gate
 * inside the child session. The runtime caller in `subagent.ts` casts
 * the result to pi's actual `ExtensionFactory` shape.
 */
export function createAgentGateFactory(options: CreateAgentGateFactoryOptions): (pi: AgentGateExtensionAPI) => void {
  const { config, enforceWriteRoots, resolveAbsolute } = options;

  return (pi: AgentGateExtensionAPI): void => {
    pi.on('tool_call', (event, ctx) =>
      decideAgentGate({ event, config, cwd: ctx.cwd, resolveAbsolute, enforceWriteRoots }),
    );

    if (config.requestOptions) {
      pi.on('before_provider_request', (event, ctx) => {
        const merged = applyRequestOptions({
          payload: event.payload,
          options: config.requestOptions,
          api: ctx.model?.api,
        });
        if (merged === event.payload) return undefined;
        return merged;
      });
    }
  };
}
