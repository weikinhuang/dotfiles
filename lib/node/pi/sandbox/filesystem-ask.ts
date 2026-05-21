/**
 * Sandbox filesystem-permission ask-callback dialog.
 *
 * The companion to `network-ask.ts`, but reactive instead of
 * preventive: ASRT does not expose a filesystem ask-callback, so we
 * can't intercept a write before it hits the kernel. Instead, after a
 * sandboxed bash has already failed and pi's `tool_result` hook
 * detects one or more EACCES / EPERM paths via {@link
 * ../sandbox/fs-failures.ts}, we surface this dialog to let the user
 * widen `write.allow` and have the model retry on its next turn.
 *
 * Five options:
 *
 *   1. Allow once (this session)        in-memory `sessionWriteAllow`
 *                                        set; cleared at session end.
 *   2. Always allow `<commonParent>`     writes to project `.pi/
 *      (project)                          filesystem.json` or `~/.pi/`
 *                                        when no project file exists.
 *   3. Always allow `<commonParent>`     writes to `~/.pi/filesystem.json`.
 *      (user)
 *   4. Deny                              keep the failure splice; the
 *                                        model sees the existing
 *                                        annotated stderr.
 *   5. Deny with feedback…               captures text via `ui.input`
 *                                        and surfaces it as a notify
 *                                        plus a model-visible hint.
 *
 * Option 2 may collapse to option 3 (project file unavailable);
 * options 2 and 3 are both hidden when the proposed common parent
 * would climb above safe scopes - see {@link clampCommonParent}.
 *
 * Pure logic. The extension shell wires up persistence callbacks and
 * the reconfigure trigger; the dialog itself is unit-testable without
 * spawning ASRT or pi's runtime.
 */

import { homedir } from 'node:os';

import { getInteractiveActiveUI, type UIBridge } from '../active-ui.ts';

import { greatestCommonParent } from './fs-failures.ts';

export type FsAskOutcome =
  | { kind: 'allow'; scope: 'session' | 'project' | 'user'; allowedPath: string; savedPath?: string }
  | { kind: 'deny'; feedback?: string }
  | { kind: 'no-ui' };

export interface FsAskDeps {
  /** Session-only allow set, mutated when the user picks "Allow
   *  once". Subsequent prompts with overlapping paths still re-prompt
   *  by default - this set only suppresses the kernel sandbox once
   *  the next reconfigure picks up the new write.allow entry. */
  sessionWriteAllow: Set<string>;
  /** Called after an "Always allow" write so the live SandboxManager
   *  picks up the new config without waiting for the next bash. */
  triggerReconfigure: () => Promise<void>;
  /** Persist `path` to project-scope `filesystem.json`'s
   *  `write.allow.paths`. Returns the resolved file path so the
   *  dialog can echo it in the confirm notify. May throw on a
   *  malformed existing file - the dialog catches and surfaces. */
  saveProjectWriteAllow: (path: string) => string;
  /** Persist `path` to user-scope `~/.pi/filesystem.json`. */
  saveUserWriteAllow: (path: string) => string;
  /** Working directory of the original tool_call - used to validate
   *  the proposed common parent against {@link clampCommonParent}. */
  cwd: string;
}

interface AskParams {
  /** Absolute paths the sandbox refused to write, parsed from stderr. */
  paths: string[];
  /** The original bash command; surfaced in the dialog so the user
   *  knows which run triggered the prompt. */
  command: string;
}

/**
 * Constrain the proposed common parent so an `Always allow` choice
 * can't accidentally widen the policy to a dangerous scope.
 *
 * Returns the parent when it is at or below the cwd, or is a
 * one-segment-deep directory under `$HOME` (e.g. `~/.npm`, `~/.cache`).
 * Returns undefined when the parent climbs above those bounds
 * (`/`, `/Users`, `/Users/u`, `/etc`, etc.), in which case the
 * dialog should hide the "Always allow" options entirely and let
 * the user fall back to "Allow once" or "Deny".
 */
export function clampCommonParent(parent: string, cwd: string, home: string): string | undefined {
  if (!parent || !parent.startsWith('/')) return undefined;
  if (parent === '/') return undefined;

  const normalize = (p: string): string => (p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p);
  const np = normalize(parent);
  const nCwd = normalize(cwd);
  const nHome = normalize(home);

  // Allow when parent is cwd itself or strictly inside cwd.
  if (np === nCwd || np.startsWith(nCwd + '/')) return np;

  // Allow when parent is a one-segment-deep directory under $HOME
  // (e.g. /Users/u/.cache, /home/u/.npm) - common for tools that
  // refuse to use a project-local store.
  if (nHome && (np === nHome || np.startsWith(nHome + '/'))) {
    const rest = np === nHome ? '' : np.slice(nHome.length + 1);
    if (rest.length > 0 && !rest.includes('/')) return np;
  }

  return undefined;
}

function truncateCommand(command: string, limit = 120): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= limit) return oneLine;
  return oneLine.slice(0, limit - 1) + '…';
}

async function runDialog(ui: UIBridge, params: AskParams, deps: FsAskDeps): Promise<FsAskOutcome> {
  const home = homedir();
  const parent = greatestCommonParent(params.paths);
  const safeParent = clampCommonParent(parent, deps.cwd, home);
  const firstPath = params.paths[0];

  const optAllowOnce = 'Allow once (this session)';
  const optAllowProject = safeParent ? `Always allow ${safeParent} (project)` : undefined;
  const optAllowUser = safeParent ? `Always allow ${safeParent} (user)` : undefined;
  const optDeny = 'Deny';
  const optDenyFeedback = 'Deny with feedback…';

  const options: string[] = [optAllowOnce];
  if (optAllowProject) options.push(optAllowProject);
  if (optAllowUser) options.push(optAllowUser);
  options.push(optDeny, optDenyFeedback);

  const lines = [
    '⚠️  Sandboxed bash failed because of a write deny.',
    '',
    `  command:  ${truncateCommand(params.command)}`,
    `  path${params.paths.length > 1 ? 's' : ''}:`,
  ];
  for (const p of params.paths.slice(0, 5)) lines.push(`    ${p}`);
  if (params.paths.length > 5) lines.push(`    … (+${params.paths.length - 5} more)`);
  if (safeParent && params.paths.length > 1 && safeParent !== firstPath) {
    lines.push('');
    lines.push(`  common parent: ${safeParent}`);
  }
  lines.push('');
  lines.push('How should pi proceed?');

  const choice = await ui.select(lines.join('\n'), options);

  if (!choice || choice === optDeny) return { kind: 'deny' };

  if (choice === optDenyFeedback) {
    const feedback = await ui.input('Tell the assistant why:', 'e.g. write to /tmp instead');
    const trimmed = feedback?.trim();
    if (trimmed) ui.notify(`sandbox: blocked write - ${trimmed}`, 'warning');
    return { kind: 'deny', feedback: trimmed };
  }

  if (choice === optAllowOnce) {
    deps.sessionWriteAllow.add(safeParent ?? firstPath);
    await deps.triggerReconfigure();
    return { kind: 'allow', scope: 'session', allowedPath: safeParent ?? firstPath };
  }

  if (optAllowProject && choice === optAllowProject && safeParent) {
    let savedPath: string;
    try {
      savedPath = deps.saveProjectWriteAllow(safeParent);
    } catch (e) {
      ui.notify(`sandbox: ${e instanceof Error ? e.message : String(e)}`, 'error');
      return { kind: 'deny' };
    }
    ui.notify(`Added write.allow.paths "${safeParent}" → ${savedPath}`, 'info');
    await deps.triggerReconfigure();
    return { kind: 'allow', scope: 'project', allowedPath: safeParent, savedPath };
  }

  if (optAllowUser && choice === optAllowUser && safeParent) {
    let savedPath: string;
    try {
      savedPath = deps.saveUserWriteAllow(safeParent);
    } catch (e) {
      ui.notify(`sandbox: ${e instanceof Error ? e.message : String(e)}`, 'error');
      return { kind: 'deny' };
    }
    ui.notify(`Added write.allow.paths "${safeParent}" → ${savedPath}`, 'info');
    await deps.triggerReconfigure();
    return { kind: 'allow', scope: 'user', allowedPath: safeParent, savedPath };
  }

  return { kind: 'deny' };
}

/**
 * Build the reactive filesystem-ask dialog.
 *
 * The returned function:
 *
 *   - Returns `{ kind: 'no-ui' }` when no interactive parent UI has
 *     been published (the caller should keep the existing failure
 *     splice and surface nothing extra to the user).
 *   - Otherwise runs the five-option dialog and returns the user's
 *     choice. Side-effects (config writes, session-set mutations,
 *     reconfigure) happen via the `deps` callbacks - the caller
 *     decides how to splice the outcome into the model-visible
 *     tool_result content.
 *
 * Mirrors `buildNetworkAskCallback` so the two prompts feel consistent.
 */
export function buildFilesystemAskDialog(deps: FsAskDeps): (params: AskParams) => Promise<FsAskOutcome> {
  return async (params) => {
    if (params.paths.length === 0) return { kind: 'deny' };
    const ui = getInteractiveActiveUI();
    if (!ui) return { kind: 'no-ui' };
    return runDialog(ui, params, deps);
  };
}
