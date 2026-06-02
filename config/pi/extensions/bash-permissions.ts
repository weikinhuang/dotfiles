/**
 * Bash permission gate for pi - Claude Code–style approval flow.
 *
 * Intercepts every `bash` tool call and matches the command against
 * allow/deny rule sets loaded from three layers (deny beats allow, most
 * specific layer wins for reporting):
 *
 *   1. Project rules:  `.pi/bash-permissions.json` inside ctx.cwd
 *   2. User rules:     `<piAgentDir>/bash-permissions.json` (default `~/.pi/agent/bash-permissions.json`)
 *   3. Session rules:  in-memory, cleared on session_shutdown
 *
 * In addition, when a `persona` is active, sub-commands matching the
 * persona's `bashAllow` are treated as session-allowed by the
 * user-author of the persona file (allow wins over the persona's own
 * `bashDeny` on overlap, mirroring `evaluateBashPolicy`). This vouch
 * is session-scoped only - nothing is written to any
 * `bash-permissions.json` on disk - and it is NOT applied to the
 * always-prompt list (sudo / doas / pkexec / …), which still requires
 * an explicit dialog. See `lib/node/pi/persona/bash-vouch.ts` and
 * `lib/node/pi/persona/active.ts` for the singleton plumbing.
 *
 * Rule files are JSONC - `//` line comments and C-style block comments
 * are allowed so you can annotate why a rule exists. Trailing commas are
 * not supported. Malformed files log one `console.warn` per unique
 * path+error (re-checked each tool call) and are otherwise ignored;
 * missing files are silent.
 *
 * In addition, a short HARDCODED_DENY list of "never auto-run" patterns
 * (rm -rf /, fork bomb, dd to raw disk, mkfs, pipe-to-shell from the
 * network, …) is checked FIRST. These block even if the user has a broad
 * allow rule above them. Set PI_BASH_PERMISSIONS_NO_HARDCODED_DENY=1 to
 * disable (not recommended).
 *
 * An ALWAYS_PROMPT list (sudo, doas, run0, pkexec, gosu, su) forces a
 * prompt even when `/bash-auto` is on - privilege escalation is the one
 * case where silent auto-run is never appropriate. An explicit allow
 * rule still bypasses the prompt for users who want a specific command
 * like `sudo apt-get install -y -qq foo` to auto-run. Set
 * PI_BASH_PERMISSIONS_NO_ALWAYS_PROMPT=1 to disable.
 *
 * Rule syntax (per entry):
 *   "npm test"       → exact match
 *   "git log*"       → token-aware prefix match (`git log*` matches `git log`
 *                     and `git log -1` but NOT `git logs`)
 *   "re:^pattern$"   → JS regex (no flags). Config-file only; use anchors if
 *                     you want whole-command matches.
 *   "/pattern/flags" → JS regex with flags (`[gimsuy]*`). Config-file only.
 *
 * Regex rules are intended for hand-edited config files - the approval
 * dialog's "save rule" options only produce exact / prefix strings.
 *
 * Compound commands joined by `&&`, `||`, or `;` are split and every
 * sub-command must pass independently. Pipes (`|`) are intentionally
 * left intact - piping is usually benign and splitting them produces
 * too many spurious prompts.
 *
 * When a command isn't covered by any rule, the user is asked:
 *   1. Allow once
 *   2. Allow "<exact>" for this session
 *   3. Always allow "<exact>" (project scope)
 *   4. Always allow "<tok1> <tok2>*" (project scope) - only if a sensible
 *      second token exists
 *   5. Always allow "<tok1>*" (user scope)
 *   6. Deny
 *   7. Deny with feedback…
 *
 * In non-interactive mode (print / JSON / RPC without UI), unknown
 * commands are blocked by default so the model can retry differently.
 *
 * Commands:
 *   /bash-allow <pattern>   add an allow rule (project if `.pi/` exists, else user)
 *   /bash-deny  <pattern>   add a deny rule (same scoping)
 *   /bash-permissions       list all rules grouped by source
 *   /bash-auto [on|off|status]
 *                           toggle auto-allow for the current session.
 *                           Hardcoded deny and explicit deny rules still
 *                           block; the `filesystem` gate (env /
 *                           outside-workspace / node_modules) is
 *                           unaffected since it's a separate extension.
 *
 * Environment:
 *   PI_BASH_PERMISSIONS_DISABLED=1            skip the gate entirely
 *   PI_BASH_PERMISSIONS_DEFAULT=allow|deny    default action when no UI
 *                                             (default: deny)
 *   PI_BASH_PERMISSIONS_NO_HARDCODED_DENY=1   disable the built-in denylist
 *   PI_BASH_PERMISSIONS_NO_ALWAYS_PROMPT=1    disable the always-prompt list
 *                                             (sudo etc. auto-allowed
 *                                             under /bash-auto - risky)
 *
 * Pure helpers (splitCompound, matchesPattern, checkHardcodedDeny, …)
 * live in ./lib/bash-match.ts so they can be unit-tested under
 * `vitest` without pulling in the pi runtime.
 */

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';

import {
  type BashGateContext,
  type BashGateDecision,
  installBashGate,
  requestBashApproval,
  uninstallBashGate,
} from '../../../lib/node/pi/bash/gate.ts';
import {
  allSubcommands,
  type BashDecision,
  decideSubcommand,
  type LoadedRules,
  type RuleFile,
  type Scope,
} from '../../../lib/node/pi/bash/match.ts';
import { extractBashCommand } from '../../../lib/node/pi/bash/hook.ts';
import {
  BASH_ALLOW_USAGE,
  BASH_AUTO_USAGE,
  BASH_DENY_USAGE,
  BASH_PERMISSIONS_USAGE,
} from '../../../lib/node/pi/bash-permissions/usage.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { askForPermission, askForPermissionBatch } from '../../../lib/node/pi/bash/permission-prompts.ts';
import { writeJsonFile } from '../../../lib/node/pi/atomic-write.ts';
import { loadJsoncConfigOrFallback } from '../../../lib/node/pi/jsonc.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { piAgentPath, piProjectPath } from '../../../lib/node/pi/pi-paths.ts';
import { pickScopeFile } from '../../../lib/node/pi/scope-pick.ts';
import { getActivePersona } from '../../../lib/node/pi/persona/active.ts';
import { personaVouchBash } from '../../../lib/node/pi/persona/bash-vouch.ts';
import { setBashAutoEnabled } from '../../../lib/node/pi/session-flags.ts';
import { registerSubagentInjection } from '../../../lib/node/pi/subagent/extension-injection.ts';

// ──────────────────────────────────────────────────────────────────────
// Rule storage
// ──────────────────────────────────────────────────────────────────────

const USER_RULES_PATH = piAgentPath('bash-permissions.json');

function projectRulesPath(cwd: string): string {
  return piProjectPath(cwd, 'bash-permissions.json');
}

function readRules(path: string): LoadedRules {
  const parsed = loadJsoncConfigOrFallback<RuleFile>('bash-permissions', path, () => ({}));
  return {
    allow: Array.isArray(parsed.allow) ? parsed.allow.map(String) : [],
    deny: Array.isArray(parsed.deny) ? parsed.deny.map(String) : [],
  };
}

function writeRules(path: string, rules: LoadedRules): void {
  // Dedup + sort for stable diffs.
  const clean: RuleFile = {
    allow: Array.from(new Set(rules.allow)).sort(),
    deny: Array.from(new Set(rules.deny)).sort(),
  };
  writeJsonFile(path, clean);
}

function addRule(path: string, kind: 'allow' | 'deny', pattern: string): void {
  const current = readRules(path);
  const bucket = current[kind];
  if (!bucket.includes(pattern)) bucket.push(pattern);
  writeRules(path, current);
}

function pickScopePath(cwd: string): string {
  return pickScopeFile({ cwd, projectFile: projectRulesPath(cwd), userFile: USER_RULES_PATH });
}

// ──────────────────────────────────────────────────────────────────────
// Subagent injection: hook-only factory
// ──────────────────────────────────────────────────────────────────────

/**
 * Hook-only `ExtensionFactory` installed inside spawned subagent
 * sessions via `lib/node/pi/subagent/extension-injection.ts`. Registers
 * ONLY a `tool_call` handler - no slash-command surface, no statusline
 * glue - so the child stays minimal while still routing its `bash`
 * tool calls through the parent's installed `bash-gate.ts` slot.
 *
 * Because the gate function itself is a closure inside `bashPermissions`
 * (below) - capturing the parent's session rules, persona vouch,
 * `sessionAuto` flag, and `defaultFallback` - the child's bash calls
 * automatically inherit the parent's policy without re-loading any
 * config files inside the child. Subagent UIs are non-interactive
 * (`hasUI: false`), so unknown commands fall through to
 * `PI_BASH_PERMISSIONS_DEFAULT` (default deny) just like a `pi -p` run.
 *
 * Exported as a stable function value so re-registering across
 * `/reload` cycles is idempotent (the registry replaces by id).
 */
export function bashPermissionsFactoryHookOnly(pi: ExtensionAPI): void {
  pi.on('tool_call', async (event, ctx) => {
    const command = extractBashCommand(event)?.trim();
    if (!command) return undefined;
    const decision = await requestBashApproval(command, ctx);
    if (decision.allowed) return undefined;
    return { block: true, reason: decision.reason };
  });
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function bashPermissions(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_BASH_PERMISSIONS_DISABLED)) return;

  // Register the hook-only factory once per extension load so spawned
  // subagents (deep-research / iteration-loop / `subagent`) re-apply
  // the parent's bash gate against their own `tool_call` events. The
  // factory is a static value - the gate function itself lives in the
  // bash-gate slot installed by `installBashGate(...)` below, so the
  // parent's session rules / persona vouch / hardcoded denylist all
  // apply to children automatically. Re-registering replaces the prior
  // entry, so a `/reload` doesn't accumulate stale factories.
  registerSubagentInjection('bash-permissions', bashPermissionsFactoryHookOnly);

  const sessionRules: LoadedRules = { allow: [], deny: [] };

  // Auto mode: auto-allow every bash sub-command that gets past the
  // hardcoded denylist and explicit deny rules, for the remainder of the
  // current session. Cleared on session_shutdown so a reload / new session
  // forces re-opt-in. Toggled via `/bash-auto`.
  let sessionAuto = false;

  const defaultFallback = process.env.PI_BASH_PERMISSIONS_DEFAULT === 'allow' ? 'allow' : 'deny';

  const loadLayers = (cwd: string): { scope: Scope; rules: LoadedRules }[] => [
    { scope: 'session' as const, rules: sessionRules },
    { scope: 'project' as const, rules: readRules(projectRulesPath(cwd)) },
    { scope: 'user' as const, rules: readRules(USER_RULES_PATH) },
  ];

  pi.on('session_shutdown', () => {
    sessionRules.allow.length = 0;
    sessionRules.deny.length = 0;
    sessionAuto = false;
    setBashAutoEnabled(false);
    uninstallBashGate();
  });

  /**
   * Core gate function: apply the full allow/deny/hardcoded-deny/
   * session-auto pipeline to `command` and return an allow/deny
   * decision. Shared between:
   *
   *   - pi's built-in `bash` tool (via the `tool_call` handler below
   *     which translates the result into `{ block, reason }`), and
   *   - the `bg_bash` extension (which imports this via
   *     `lib/node/pi/bash/gate.ts` → `requestBashApproval`).
   *
   * Session-level "allow this for the rest of the session" decisions
   * made here automatically apply to both callers because `sessionRules`
   * lives in this closure and both paths funnel through the same
   * `gateBashCommand` invocation.
   *
   * `ctx` is typed structurally (not as `ExtensionContext`) so bg-bash,
   * which imports via its own module copy under jiti, doesn't need to
   * share a type symbol.
   */
  const gateBashCommand = async (command: string, ctx: BashGateContext): Promise<BashGateDecision> => {
    const trimmed = command.trim();
    if (!trimmed) return { allowed: true };

    const layers = loadLayers(ctx.cwd);
    // Enumerate every sub-command the shell would actually execute -
    // top-level `&&` / `||` / `;` / newline splits AND anything hidden
    // inside `$(…)` / `` `…` `` / `<(…)` / `>(…)` substitutions. Each
    // independently runs through the precedence ladder below, so a
    // `rm -rf /` smuggled into a command-substitution argument is
    // caught by the hardcoded denylist just as it would be if typed
    // plainly.
    const subcommands = allSubcommands(trimmed);

    // Single pass: apply the full precedence ladder per sub-command.
    // decideSubcommand enforces the invariant that auto mode NEVER beats
    // the hardcoded denylist, explicit deny rules, or the always-prompt
    // list - that's the "except for risky actions" carve-out. When a
    // prompt is required because of always-prompt, the decision's reason
    // flags that so the dialog can tell the user why.
    const unknown: string[] = [];
    const alwaysPromptReasons = new Map<string, string>();
    // Cross-extension vouch: when the active persona declares the
    // command in its `bashAllow`, treat it as session-allowed by the
    // user-author of the persona file. Mirrors the writeRoots vouch in
    // `filesystem.ts`. Persona's `bashAllow` wins over its own
    // `bashDeny` on overlap (see `evaluateBashPolicy`), so the vouch
    // does too. Skipped for the always-prompt carve-out (sudo / doas /
    // pkexec / …) - privilege escalation must always show the dialog
    // regardless of who vouched.
    const activePersona = getActivePersona();
    for (const sub of subcommands) {
      const decision: BashDecision = decideSubcommand(sub, layers, { auto: sessionAuto });
      if (decision.kind === 'block') {
        return { allowed: false, reason: `Blocked by ${decision.reason} (matched "${sub}")` };
      }
      if (decision.kind === 'prompt') {
        if (!decision.reason) {
          const vouch = personaVouchBash({ command: sub, active: activePersona });
          if (vouch.vouched) continue;
        }
        unknown.push(sub);
        if (decision.reason) alwaysPromptReasons.set(sub, decision.reason);
      }
    }
    if (unknown.length === 0) return { allowed: true };

    if (!ctx.hasUI) {
      if (defaultFallback === 'allow') return { allowed: true };
      return {
        allowed: false,
        reason:
          `No UI available for approval. Unknown command(s):\n  ${unknown.join('\n  ')}\n` +
          `Add a rule via /bash-allow or by editing ${USER_RULES_PATH}, ` +
          'or set PI_BASH_PERMISSIONS_DEFAULT=allow.',
      };
    }

    // ≥2 unknowns → one coalesced prompt for the whole batch.
    if (unknown.length >= 2) {
      const batch = await askForPermissionBatch(ctx, trimmed, unknown, {
        auto: sessionAuto,
        alwaysPromptReasons,
      });
      if (batch.kind === 'deny') {
        return { allowed: false, reason: batch.feedback ?? 'Blocked by user' };
      }
      if (batch.kind === 'allow-all-session') {
        for (const sub of unknown) sessionRules.allow.push(sub);
      }
      // allow-all-once: no persistence.
      return { allowed: true };
    }

    // Exactly one unknown → rich dialog with save-rule options.
    const sub = unknown[0];
    const decision = await askForPermission(ctx, sub, {
      auto: sessionAuto,
      alwaysPromptReason: alwaysPromptReasons.get(sub),
    });
    if (decision.kind === 'deny') {
      return { allowed: false, reason: decision.feedback ?? 'Blocked by user' };
    }
    switch (decision.kind) {
      case 'allow-once':
        break;
      case 'allow-session-exact':
        sessionRules.allow.push(sub);
        break;
      case 'allow-project-exact':
        addRule(projectRulesPath(ctx.cwd), 'allow', sub);
        ctx.ui.notify(`Saved allow rule "${sub}" → ${projectRulesPath(ctx.cwd)}`, 'info');
        break;
      case 'allow-project-two-token':
        addRule(projectRulesPath(ctx.cwd), 'allow', decision.pattern);
        ctx.ui.notify(`Saved allow rule "${decision.pattern}" → ${projectRulesPath(ctx.cwd)}`, 'info');
        break;
      case 'allow-user-prefix':
        addRule(USER_RULES_PATH, 'allow', decision.pattern);
        ctx.ui.notify(`Saved allow rule "${decision.pattern}" → ${USER_RULES_PATH}`, 'info');
        break;
    }
    return { allowed: true };
  };

  // Publish the gate so sibling extensions (e.g. bg-bash) can route
  // their own bash-equivalent payloads through the same approval
  // pipeline. The slot lives on `globalThis`, see `lib/node/pi/bash/gate.ts`.
  installBashGate(gateBashCommand);

  pi.on('tool_call', async (event, ctx) => {
    const command = extractBashCommand(event)?.trim();
    if (!command) return undefined;

    const decision = await gateBashCommand(command, ctx);
    if (decision.allowed) return undefined;
    return { block: true, reason: decision.reason };
  });

  // ────────────────────────────────────────────────────────────────────
  // Commands
  // ────────────────────────────────────────────────────────────────────

  pi.registerCommand('bash-allow', {
    description: 'Add an allow rule for bash commands (pattern or exact)',
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(BASH_ALLOW_USAGE, 'info');
        return;
      }
      const pattern = args.trim();
      if (!pattern) {
        ctx.ui.notify(BASH_ALLOW_USAGE, 'warning');
        return;
      }
      const path = pickScopePath(ctx.cwd);
      addRule(path, 'allow', pattern);
      ctx.ui.notify(`Added allow "${pattern}" → ${path}`, 'info');
    },
  });

  pi.registerCommand('bash-deny', {
    description: 'Add a deny rule for bash commands (pattern or exact)',
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(BASH_DENY_USAGE, 'info');
        return;
      }
      const pattern = args.trim();
      if (!pattern) {
        ctx.ui.notify(BASH_DENY_USAGE, 'warning');
        return;
      }
      const path = pickScopePath(ctx.cwd);
      addRule(path, 'deny', pattern);
      ctx.ui.notify(`Added deny "${pattern}" → ${path}`, 'info');
    },
  });

  pi.registerCommand('bash-permissions', {
    description: 'Show all bash permission rules (session / project / user)',
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(BASH_PERMISSIONS_USAGE, 'info');
        return;
      }
      const layers = loadLayers(ctx.cwd);
      const lines: string[] = [];
      for (const layer of layers) {
        const where =
          layer.scope === 'session'
            ? '(in-memory)'
            : layer.scope === 'project'
              ? projectRulesPath(ctx.cwd)
              : USER_RULES_PATH;
        lines.push(`[${layer.scope}] ${where}`);
        if (layer.rules.allow.length === 0 && layer.rules.deny.length === 0) {
          lines.push('  (empty)');
          continue;
        }
        for (const p of layer.rules.allow) lines.push(`  allow: ${p}`);
        for (const p of layer.rules.deny) lines.push(`  deny:  ${p}`);
      }
      lines.push('');
      lines.push(`Auto mode: ${sessionAuto ? 'ON ⚡ (auto-allow this session)' : 'OFF'}`);
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  pi.registerCommand('bash-auto', {
    description: 'Toggle auto-allow for bash commands this session (hardcoded deny + explicit deny still block)',
    getArgumentCompletions: (prefix) => {
      const opts = ['on', 'off', 'status'];
      const items = opts.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(BASH_AUTO_USAGE, 'info');
        return;
      }
      const arg = args.trim().toLowerCase();
      let next: boolean;
      if (arg === 'on' || arg === 'enable' || arg === '1') next = true;
      else if (arg === 'off' || arg === 'disable' || arg === '0') next = false;
      else if (arg === 'status' || arg === '?') {
        ctx.ui.notify(
          sessionAuto
            ? '⚡ Auto mode ON - bash commands auto-run except hardcoded deny / explicit deny rules.'
            : '✅ Auto mode OFF - bash commands require approval.',
          'info',
        );
        return;
      } else if (arg === '') next = !sessionAuto;
      else {
        ctx.ui.notify(`Usage: /bash-auto [on|off|status]`, 'warning');
        return;
      }

      if (next === sessionAuto) {
        ctx.ui.notify(`Auto mode is already ${next ? 'ON' : 'OFF'}.`, 'info');
        return;
      }
      sessionAuto = next;
      setBashAutoEnabled(sessionAuto);
      if (sessionAuto) {
        ctx.ui.setStatus('bash-auto', '⚡ auto');
        ctx.ui.notify(
          '⚡ Auto mode ON - bash commands will auto-run this session.\n' +
            'Hardcoded deny (rm -rf /, mkfs, …) and explicit deny rules still block.\n' +
            'filesystem gate is unaffected (writes to .env / outside-workspace still prompt).\n' +
            'Run /bash-auto off to turn it back off.',
          'warning',
        );
      } else {
        ctx.ui.setStatus('bash-auto', undefined);
        ctx.ui.notify('✅ Auto mode OFF - bash commands require approval again.', 'info');
      }
    },
  });
}
