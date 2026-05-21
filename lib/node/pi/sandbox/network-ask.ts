/**
 * Sandbox network-permission ask-callback dialog.
 *
 * `@anthropic-ai/sandbox-runtime` lets us register a callback that
 * fires whenever sandboxed bash hits a non-allowlisted domain. The
 * callback returns `Promise<boolean>` (true = allow, false = deny).
 *
 * This module builds the six-option dialog described in plan section
 * 7 (mirroring `bash-permissions.ts`'s shape) and routes it through
 * the parent's UI bridge published on `active-ui.ts`. The extension
 * shell wires up the persistence callbacks (project-scope vs
 * user-scope writes); the dialog itself is pure logic that's easy to
 * unit-test without spawning ASRT.
 *
 * Six options:
 *
 *   1. Allow once
 *   2. Allow `<host>` for this session  (in-memory set; not persisted)
 *   3. Always allow `<host>` (project)  (writes to .pi/sandbox.json
 *                                       when .pi/ exists, else ~/.pi/)
 *   4. Always allow `*.<parent>` (user) (writes to ~/.pi/sandbox.json;
 *                                       omitted when no sensible parent)
 *   5. Deny
 *   6. Deny with feedback…              (captures text via ui.input
 *                                       and surfaces it as a notify)
 *
 * Non-UI fallback: when no parent UI has published itself (`pi -p`
 * mode, no extension active yet), the callback falls through to
 * `envNetworkDefault()` which reads `PI_SANDBOX_NETWORK_DEFAULT`.
 */

import { getInteractiveActiveUI, type UIBridge } from '../active-ui.ts';

export interface NetworkAskDeps {
  /** Session-only allow set, mutated when the user picks "Allow ...
   *  for this session". Subsequent prompts for the same host
   *  short-circuit to true without re-prompting. */
  sessionAllowedDomains: Set<string>;
  /** Called after an `Always allow` write so the live SandboxManager
   *  picks up the new config without waiting for the next bash. */
  triggerReconfigure: () => Promise<void>;
  /** Append `host` to `network.allow` at project scope. Returns the
   *  resolved path so the dialog can echo it in the confirm notify. */
  saveProjectAllow: (host: string) => string;
  /** Append `parent` (already shaped as `*.<host>`) to user-scope
   *  `network.allow`. Returns the resolved path. */
  saveUserAllowParent: (parent: string) => string;
  /** Read PI_SANDBOX_NETWORK_DEFAULT - extension-shell wraps the
   *  env-var parse so this module stays env-free. */
  envNetworkDefault: () => 'allow' | 'deny';
}

/**
 * Compute the parent-of-domain glob (`*.<parent>`), or undefined
 * when no sensible parent exists.
 *
 * Heuristic: needs at least three dot-separated segments so the
 * parent itself still has a TLD + SLD. `api.github.com` →
 * `*.github.com`; `github.com` → undefined (allowing `*.com` would
 * be a massive footgun); `a.b.c.d` → `*.b.c.d`. Bare IPv4 / IPv6
 * and single-label hosts (`localhost`) return undefined.
 */
export function parentDomainGlob(host: string): string | undefined {
  if (!host || host.includes('/')) return undefined;
  if (/^\d+(\.\d+){3}$/.test(host)) return undefined; // IPv4
  if (host.includes(':')) return undefined; // IPv6 or host:port
  const segments = host.split('.').filter(Boolean);
  if (segments.length < 3) return undefined;
  return `*.${segments.slice(1).join('.')}`;
}

interface AskParams {
  host: string;
  port: number | undefined;
}

async function runDialog(ui: UIBridge, host: string, labelTarget: string, deps: NetworkAskDeps): Promise<boolean> {
  const parent = parentDomainGlob(host);

  const optAllowOnce = 'Allow once';
  const optAllowSession = `Allow ${host} for this session`;
  const optAllowProject = `Always allow ${host} (project)`;
  const optAllowParentUser = parent ? `Always allow ${parent} (user)` : undefined;
  const optDeny = 'Deny';
  const optDenyFeedback = 'Deny with feedback…';

  const options = [optAllowOnce, optAllowSession, optAllowProject];
  if (optAllowParentUser) options.push(optAllowParentUser);
  options.push(optDeny, optDenyFeedback);

  const choice = await ui.select(
    `⚠️  Sandboxed bash wants to connect to:\n\n  ${labelTarget}\n\nHow should pi proceed?`,
    options,
  );

  if (!choice || choice === optDeny) return false;
  if (choice === optDenyFeedback) {
    const feedback = await ui.input('Tell the assistant why:', 'e.g. use the staging mirror instead');
    const trimmed = feedback?.trim();
    if (trimmed) ui.notify(`sandbox: blocked ${labelTarget} - ${trimmed}`, 'warning');
    return false;
  }
  if (choice === optAllowOnce) return true;
  if (choice === optAllowSession) {
    deps.sessionAllowedDomains.add(host);
    return true;
  }
  if (choice === optAllowProject) {
    const savedPath = deps.saveProjectAllow(host);
    ui.notify(`Added network.allow "${host}" → ${savedPath}`, 'info');
    await deps.triggerReconfigure();
    return true;
  }
  if (optAllowParentUser && choice === optAllowParentUser && parent) {
    const savedPath = deps.saveUserAllowParent(parent);
    ui.notify(`Added network.allow "${parent}" → ${savedPath}`, 'info');
    await deps.triggerReconfigure();
    return true;
  }
  return false;
}

/**
 * Build the SandboxAskCallback (ASRT's `Promise<boolean>` shape).
 *
 * Test-friendly: callers inject their UI via the active-ui slot
 * (`publishActiveUI`) and inject persistence behavior via `deps`.
 * The callback itself reads `getInteractiveActiveUI()` so subagent
 * sessions that share the parent's `globalThis` also get the
 * parent's UI surface for free.
 */
export function buildNetworkAskCallback(deps: NetworkAskDeps): (params: AskParams) => Promise<boolean> {
  return async (params) => {
    const host = params.host;
    const labelTarget = params.port !== undefined ? `${host}:${params.port}` : host;

    if (deps.sessionAllowedDomains.has(host)) return true;

    const ui = getInteractiveActiveUI();
    if (!ui) return deps.envNetworkDefault() === 'allow';

    return runDialog(ui, host, labelTarget, deps);
  };
}
