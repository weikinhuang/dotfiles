/**
 * Sandbox network-permission ask-callback dialog.
 *
 * `@anthropic-ai/sandbox-runtime` lets us register a callback that
 * fires whenever sandboxed bash hits a non-allowlisted domain. The
 * callback resolves to `true` (allow), `false` (deny), or - on ASRT >=
 * 0.0.80 - `{ allow: false, reason }`, whose reason the sandboxed client
 * reads as the status phrase of its refused CONNECT.
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
 *                                       when .pi/ exists, else
 *                                       <piAgentDir>/sandbox.json)
 *   4. Always allow `*.<parent>` (user) (writes to
 *                                       <piAgentDir>/sandbox.json;
 *                                       omitted when no sensible parent)
 *   5. Deny
 *   6. Deny with feedback…              (captures text via ui.input,
 *                                       surfaces it as a notify, and
 *                                       returns it as the deny reason
 *                                       so the model sees it)
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
  /** True when the live ASRT accepts `{ allow: false, reason }` from the
   *  ask callback (`SandboxManager.askCallbackDenyReason`, ASRT >=
   *  0.0.80). The reason then reaches the sandboxed client as the 403
   *  status phrase of its refused CONNECT, so the model sees WHY. Older
   *  releases read any truthy answer as an allow, so without this flag
   *  denials stay a plain `false`. */
  supportsDenyReason?: boolean;
}

/** What the callback resolves to: ASRT's `SandboxAskCallback` answer. */
export type NetworkAskAnswer = boolean | { allow: false; reason: string };

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

export function buildNetworkAskPrompt(
  host: string,
  labelTarget: string,
): {
  parent: string | undefined;
  title: string;
  options: string[];
  labels: {
    allowOnce: string;
    allowSession: string;
    allowProject: string;
    allowParentUser: string | undefined;
    deny: string;
    denyFeedback: string;
  };
} {
  const parent = parentDomainGlob(host);
  const labels = {
    allowOnce: 'Allow once',
    allowSession: `Allow ${host} for this session`,
    allowProject: `Always allow ${host} (project)`,
    allowParentUser: parent ? `Always allow ${parent} (user)` : undefined,
    deny: 'Deny',
    denyFeedback: 'Deny with feedback…',
  };
  const options = [labels.allowOnce, labels.allowSession, labels.allowProject];
  if (labels.allowParentUser) options.push(labels.allowParentUser);
  options.push(labels.deny, labels.denyFeedback);
  return {
    parent,
    title: `⚠️  Sandboxed bash wants to connect to:\n\n  ${labelTarget}\n\nHow should pi proceed?`,
    options,
    labels,
  };
}

/** A denial: `{ allow: false, reason }` when supported, else `false`. */
function deny(deps: NetworkAskDeps, reason: string | undefined): NetworkAskAnswer {
  const trimmed = reason?.replace(/\s+/g, ' ').trim();
  return deps.supportsDenyReason && trimmed ? { allow: false, reason: trimmed } : false;
}

async function runDialog(
  ui: UIBridge,
  host: string,
  labelTarget: string,
  deps: NetworkAskDeps,
): Promise<NetworkAskAnswer> {
  const prompt = buildNetworkAskPrompt(host, labelTarget);
  const choice = await ui.select(prompt.title, prompt.options);

  if (!choice || choice === prompt.labels.deny) return false;
  if (choice === prompt.labels.denyFeedback) {
    const feedback = await ui.input('Tell the assistant why:', 'e.g. use the staging mirror instead');
    const trimmed = feedback?.trim();
    if (trimmed) ui.notify(`sandbox: blocked ${labelTarget} - ${trimmed}`, 'warning');
    return deny(deps, trimmed ? `user denied: ${trimmed}` : undefined);
  }
  if (choice === prompt.labels.allowOnce) return true;
  if (choice === prompt.labels.allowSession) {
    deps.sessionAllowedDomains.add(host);
    return true;
  }
  if (choice === prompt.labels.allowProject) {
    let savedPath: string;
    try {
      savedPath = deps.saveProjectAllow(host);
    } catch (e) {
      // `addNetworkRule` throws when the existing config file is
      // unparseable. Surface that instead of overwriting the user's file.
      ui.notify(`sandbox: ${e instanceof Error ? e.message : String(e)}`, 'error');
      return false;
    }
    ui.notify(`Added network.allow "${host}" → ${savedPath}`, 'info');
    await deps.triggerReconfigure();
    return true;
  }
  if (prompt.labels.allowParentUser && choice === prompt.labels.allowParentUser && prompt.parent) {
    let savedPath: string;
    try {
      savedPath = deps.saveUserAllowParent(prompt.parent);
    } catch (e) {
      ui.notify(`sandbox: ${e instanceof Error ? e.message : String(e)}`, 'error');
      return false;
    }
    ui.notify(`Added network.allow "${prompt.parent}" → ${savedPath}`, 'info');
    await deps.triggerReconfigure();
    return true;
  }
  return false;
}

/**
 * Build the SandboxAskCallback (ASRT's `Promise<boolean | { allow:
 * false, reason }>` shape).
 *
 * Test-friendly: callers inject their UI via the active-ui slot
 * (`publishActiveUI`) and inject persistence behavior via `deps`.
 * The callback itself reads `getInteractiveActiveUI()` so subagent
 * sessions that share the parent's `globalThis` also get the
 * parent's UI surface for free.
 *
 * Concurrent asks for the same host share one dialog: ASRT calls the
 * callback once per refused connection, so a command that opens
 * several connections at once (`npm install`, a parallel downloader)
 * would otherwise stack identical prompts. Every waiter gets the same
 * answer; "Allow once" therefore covers the burst that triggered it.
 */
export function buildNetworkAskCallback(deps: NetworkAskDeps): (params: AskParams) => Promise<NetworkAskAnswer> {
  const inflight = new Map<string, Promise<NetworkAskAnswer>>();
  return async (params) => {
    const host = params.host;
    const labelTarget = params.port !== undefined ? `${host}:${params.port}` : host;

    if (deps.sessionAllowedDomains.has(host)) return true;

    const ui = getInteractiveActiveUI();
    if (!ui) {
      if (deps.envNetworkDefault() === 'allow') return true;
      return deny(
        deps,
        `${host} is not on the sandbox allow list and pi has no interactive UI to ask ` +
          '(PI_SANDBOX_NETWORK_DEFAULT=deny); add it to network.allow in sandbox.json',
      );
    }

    const pending = inflight.get(host);
    if (pending) return pending;
    const answer = runDialog(ui, host, labelTarget, deps).finally(() => {
      inflight.delete(host);
    });
    inflight.set(host, answer);
    return answer;
  };
}
