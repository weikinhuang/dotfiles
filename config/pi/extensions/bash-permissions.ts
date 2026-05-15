/**
 * Bash permission gate for pi — Claude Code–style approval flow.
 *
 * Intercepts every `bash` tool call and matches the command against
 * allow/deny rule sets loaded from three layers (deny beats allow, most
 * specific layer wins for reporting):
 *
 *   1. Project rules:  `.pi/bash-permissions.json` inside ctx.cwd
 *   2. User rules:     `~/.pi/bash-permissions.json`
 *   3. Session rules:  in-memory, cleared on session_shutdown
 *
 * In addition, when a `persona` is active, sub-commands matching the
 * persona's `bashAllow` are treated as session-allowed by the
 * user-author of the persona file (allow wins over the persona's own
 * `bashDeny` on overlap, mirroring `evaluateBashPolicy`). This vouch
 * is session-scoped only — nothing is written to any
 * `bash-permissions.json` on disk — and it is NOT applied to the
 * always-prompt list (sudo / doas / pkexec / …), which still requires
 * an explicit dialog. See `lib/node/pi/persona/bash-vouch.ts` and
 * `lib/node/pi/persona/active.ts` for the singleton plumbing.
 *
 * Rule files are JSONC — `//` line comments and C-style block comments
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
 * prompt even when `/bash-auto` is on — privilege escalation is the one
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
 * Regex rules are intended for hand-edited config files — the approval
 * dialog's "save rule" options only produce exact / prefix strings.
 *
 * Compound commands joined by `&&`, `||`, or `;` are split and every
 * sub-command must pass independently. Pipes (`|`) are intentionally
 * left intact — piping is usually benign and splitting them produces
 * too many spurious prompts.
 *
 * When a command isn't covered by any rule, the user is asked:
 *   1. Allow once
 *   2. Allow "<exact>" for this session
 *   3. Always allow "<exact>" (project scope)
 *   4. Always allow "<tok1> <tok2>*" (project scope) — only if a sensible
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
 *                           block; protected-paths (env / outside-workspace
 *                           / node_modules) is unaffected since it's a
 *                           separate extension.
 *
 * Environment:
 *   PI_BASH_PERMISSIONS_DISABLED=1            skip the gate entirely
 *   PI_BASH_PERMISSIONS_DEFAULT=allow|deny    default action when no UI
 *                                             (default: deny)
 *   PI_BASH_PERMISSIONS_NO_HARDCODED_DENY=1   disable the built-in denylist
 *   PI_BASH_PERMISSIONS_NO_ALWAYS_PROMPT=1    disable the always-prompt list
 *                                             (sudo etc. auto-allowed
 *                                             under /bash-auto — risky)
 *
 * Pure helpers (splitCompound, matchesPattern, checkHardcodedDeny, …)
 * live in ./lib/bash-match.ts so they can be unit-tested under
 * `vitest` without pulling in the pi runtime.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';

import {
  type BashGateContext,
  type BashGateDecision,
  installBashGate,
  uninstallBashGate,
} from '../../../lib/node/pi/bash-gate.ts';
import {
  allSubcommands,
  type BashDecision,
  decideSubcommand,
  type LoadedRules,
  type RuleFile,
  type Scope,
  twoTokenPattern,
} from '../../../lib/node/pi/bash-match.ts';
import { clearConfigWarning, parseJsonc, warnBadConfigFileOnce } from '../../../lib/node/pi/jsonc.ts';
import { getActivePersona } from '../../../lib/node/pi/persona/active.ts';
import { personaVouchBash } from '../../../lib/node/pi/persona/bash-vouch.ts';
import { setBashAutoEnabled } from '../../../lib/node/pi/session-flags.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Rule storage
// ──────────────────────────────────────────────────────────────────────

const USER_RULES_PATH = join(homedir(), '.pi', 'bash-permissions.json');
const PROJECT_RULES_RELATIVE = join('.pi', 'bash-permissions.json');

function projectRulesPath(cwd: string): string {
  return resolve(cwd, PROJECT_RULES_RELATIVE);
}

function readRules(path: string): LoadedRules {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // File missing / unreadable — silent. Missing rule files are the
    // common case (new project with no `.pi/bash-permissions.json`).
    return { allow: [], deny: [] };
  }
  try {
    const parsed = parseJsonc<RuleFile>(raw);
    clearConfigWarning('bash-permissions', path);
    return {
      allow: Array.isArray(parsed.allow) ? parsed.allow.map(String) : [],
      deny: Array.isArray(parsed.deny) ? parsed.deny.map(String) : [],
    };
  } catch (e) {
    warnBadConfigFileOnce('bash-permissions', path, e);
    return { allow: [], deny: [] };
  }
}

function writeRules(path: string, rules: LoadedRules): void {
  mkdirSync(dirname(path), { recursive: true });
  // Dedup + sort for stable diffs.
  const clean: RuleFile = {
    allow: Array.from(new Set(rules.allow)).sort(),
    deny: Array.from(new Set(rules.deny)).sort(),
  };
  writeFileSync(path, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
}

function addRule(path: string, kind: 'allow' | 'deny', pattern: string): void {
  const current = readRules(path);
  const bucket = current[kind];
  if (!bucket.includes(pattern)) bucket.push(pattern);
  writeRules(path, current);
}

// ──────────────────────────────────────────────────────────────────────
// Prompt helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Collapse whitespace (including newlines) to single spaces and truncate.
 *
 * Pi's ExtensionSelectorComponent has no scrolling / height clamp — it
 * renders every child line directly. If the dialog grows taller than the
 * terminal, the terminal itself scrolls and the UI flickers wildly on
 * every repaint. Keeping the rendered command to one short line is the
 * cheapest way to keep the dialog a predictable ~10–12 rows regardless of
 * how long the original bash call was.
 */
function compactForDialog(s: string, maxLen = 160): string {
  return truncate(s.replace(/\s+/g, ' ').trim(), maxLen);
}

/** Pick project scope when a `.pi/` dir exists in cwd, else user scope. */
function pickScopePath(cwd: string): string {
  // Prefer project scope if the rules file or the `.pi/` dir already exists.
  const projectPath = projectRulesPath(cwd);
  try {
    if (statSync(projectPath).isFile()) return projectPath;
  } catch {
    // fall through
  }
  try {
    if (statSync(join(cwd, '.pi')).isDirectory()) return projectPath;
  } catch {
    // fall through
  }
  return USER_RULES_PATH;
}

type Decision =
  | { kind: 'allow-once' }
  | { kind: 'allow-session-exact' }
  | { kind: 'allow-project-exact' }
  | { kind: 'allow-project-two-token'; pattern: string }
  | { kind: 'allow-user-prefix'; pattern: string }
  | { kind: 'deny'; feedback?: string };

interface AskForPermissionContext {
  /** Session auto mode is currently ON. */
  auto?: boolean;
  /** Reason the always-prompt list forced this prompt (e.g. "sudo"). */
  alwaysPromptReason?: string;
}

async function askForPermission(
  ctx: BashGateContext,
  command: string,
  extras: AskForPermissionContext = {},
): Promise<Decision> {
  const trimmed = command.trimStart();
  const firstToken = trimmed.split(/[\s|&;<>()]/)[0] ?? command;
  const twoToken = twoTokenPattern(command);
  const userPrefixPattern = `${firstToken}*`;

  interface Entry {
    label: string;
    decision: Decision | 'deny-feedback';
  }
  const entries: Entry[] = [
    { label: 'Allow once', decision: { kind: 'allow-once' } },
    {
      label: `Allow "${truncate(command, 60)}" for this session`,
      decision: { kind: 'allow-session-exact' },
    },
    {
      label: `Always allow "${truncate(command, 60)}" (project)`,
      decision: { kind: 'allow-project-exact' },
    },
  ];
  if (twoToken) {
    entries.push({
      label: `Always allow "${twoToken}" (project)`,
      decision: { kind: 'allow-project-two-token', pattern: twoToken },
    });
  }
  entries.push({
    label: `Always allow "${userPrefixPattern}" (user, all projects)`,
    decision: { kind: 'allow-user-prefix', pattern: userPrefixPattern },
  });
  entries.push({ label: 'Deny', decision: { kind: 'deny' } });
  entries.push({ label: 'Deny with feedback…', decision: 'deny-feedback' });

  // `command` is shown inline in the dialog title; collapse newlines and
  // cap the length so multi-line heredocs / long scripts don't blow the
  // dialog past the terminal height (see compactForDialog).
  const displayCommand = compactForDialog(command);
  const titleLines: string[] = ['⚠️  Bash tool request:', '', `  ${displayCommand}`];
  if (extras.auto && extras.alwaysPromptReason) {
    titleLines.push('', `⚡ auto mode cannot skip this (${extras.alwaysPromptReason}).`);
  }
  titleLines.push('', 'How should pi proceed?');
  const choice = await ctx.ui.select(
    titleLines.join('\n'),
    entries.map((e) => e.label),
  );

  const picked = entries.find((e) => e.label === choice);
  if (!picked) return { kind: 'deny' };

  if (picked.decision === 'deny-feedback') {
    const feedback = await ctx.ui.input('Tell the assistant why:', 'e.g. use the test script instead');
    return { kind: 'deny', feedback: feedback?.trim() || undefined };
  }
  return picked.decision;
}

type BatchDecision = { kind: 'allow-all-once' } | { kind: 'allow-all-session' } | { kind: 'deny'; feedback?: string };

interface AskForPermissionBatchContext {
  /** Session auto mode is currently ON. */
  auto?: boolean;
  /**
   * Map sub-command → always-prompt reason. Sub-commands that aren't in
   * the map landed in the prompt for the ordinary "unknown command"
   * reason.
   */
  alwaysPromptReasons?: Map<string, string>;
}

/**
 * Coalesced prompt for a compound/multi-line bash call with ≥2 unknown
 * sub-commands. A single decision applies to all of them.
 */
async function askForPermissionBatch(
  ctx: BashGateContext,
  fullCommand: string,
  unknown: string[],
  extras: AskForPermissionBatchContext = {},
): Promise<BatchDecision> {
  interface Entry {
    label: string;
    decision: BatchDecision | 'deny-feedback';
  }
  const entries: Entry[] = [
    { label: `Allow all ${unknown.length} once`, decision: { kind: 'allow-all-once' } },
    { label: `Allow all ${unknown.length} for this session`, decision: { kind: 'allow-all-session' } },
    { label: 'Deny', decision: { kind: 'deny' } },
    { label: 'Deny with feedback…', decision: 'deny-feedback' },
  ];

  // Cap the number of sub-commands rendered inline so the dialog stays
  // within a reasonable height on small terminals; the remainder is
  // summarised as a single "…and N more" line. Each visible sub-command
  // is also whitespace-collapsed so multi-line fragments don't each
  // expand into many rendered rows.
  const MAX_VISIBLE_SUBS = 6;
  const visible = unknown.slice(0, MAX_VISIBLE_SUBS);
  const hidden = unknown.length - visible.length;
  const summaryLines = visible.map((sub, idx) => {
    const reason = extras.alwaysPromptReasons?.get(sub);
    const marker = reason ? '  ⚡ ' : '  ';
    return `${marker}${idx + 1}. ${compactForDialog(sub, 100)}${reason ? ` — ${reason}` : ''}`;
  });
  if (hidden > 0) summaryLines.push(`  … and ${hidden} more`);
  const summary = summaryLines.join('\n');
  const autoHint =
    extras.auto && extras.alwaysPromptReasons && extras.alwaysPromptReasons.size > 0
      ? '\n\n⚡ auto mode cannot skip the ⚡-marked sub-commands.'
      : '';
  const title =
    `⚠️  Bash tool request with ${unknown.length} unknown sub-commands:\n\n${summary}${autoHint}\n\n` +
    `Full command:\n  ${compactForDialog(fullCommand, 180)}\n\nHow should pi proceed?`;

  const choice = await ctx.ui.select(
    title,
    entries.map((e) => e.label),
  );
  const picked = entries.find((e) => e.label === choice);
  if (!picked) return { kind: 'deny' };

  if (picked.decision === 'deny-feedback') {
    const feedback = await ctx.ui.input('Tell the assistant why:', 'e.g. split these into separate calls');
    return { kind: 'deny', feedback: feedback?.trim() || undefined };
  }
  return picked.decision;
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function bashPermissions(pi: ExtensionAPI): void {
  if (process.env.PI_BASH_PERMISSIONS_DISABLED === '1') return;

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
   *     `lib/node/pi/bash-gate.ts` → `requestBashApproval`).
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
    // Enumerate every sub-command the shell would actually execute —
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
    // list — that's the "except for risky actions" carve-out. When a
    // prompt is required because of always-prompt, the decision's reason
    // flags that so the dialog can tell the user why.
    const unknown: string[] = [];
    const alwaysPromptReasons = new Map<string, string>();
    // Cross-extension vouch: when the active persona declares the
    // command in its `bashAllow`, treat it as session-allowed by the
    // user-author of the persona file. Mirrors the writeRoots vouch in
    // `protected-paths.ts`. Persona's `bashAllow` wins over its own
    // `bashDeny` on overlap (see `evaluateBashPolicy`), so the vouch
    // does too. Skipped for the always-prompt carve-out (sudo / doas /
    // pkexec / …) — privilege escalation must always show the dialog
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
          'Add a rule via /bash-allow or by editing ~/.pi/bash-permissions.json, ' +
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
  // pipeline. The slot lives on `globalThis`, see `lib/node/pi/bash-gate.ts`.
  installBashGate(gateBashCommand);

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined;
    const command = String(event.input?.command ?? '').trim();
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
      const pattern = args.trim();
      if (!pattern) {
        ctx.ui.notify('Usage: /bash-allow <exact-command | prefix*>', 'warning');
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
      const pattern = args.trim();
      if (!pattern) {
        ctx.ui.notify('Usage: /bash-deny <exact-command | prefix*>', 'warning');
        return;
      }
      const path = pickScopePath(ctx.cwd);
      addRule(path, 'deny', pattern);
      ctx.ui.notify(`Added deny "${pattern}" → ${path}`, 'info');
    },
  });

  pi.registerCommand('bash-permissions', {
    description: 'Show all bash permission rules (session / project / user)',
    handler: async (_args, ctx) => {
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
      const arg = args.trim().toLowerCase();
      let next: boolean;
      if (arg === 'on' || arg === 'enable' || arg === '1') next = true;
      else if (arg === 'off' || arg === 'disable' || arg === '0') next = false;
      else if (arg === 'status' || arg === '?') {
        ctx.ui.notify(
          sessionAuto
            ? '⚡ Auto mode ON — bash commands auto-run except hardcoded deny / explicit deny rules.'
            : '✅ Auto mode OFF — bash commands require approval.',
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
          '⚡ Auto mode ON — bash commands will auto-run this session.\n' +
            'Hardcoded deny (rm -rf /, mkfs, …) and explicit deny rules still block.\n' +
            'protected-paths is unaffected (writes to .env / outside-workspace still prompt).\n' +
            'Run /bash-auto off to turn it back off.',
          'warning',
        );
      } else {
        ctx.ui.setStatus('bash-auto', undefined);
        ctx.ui.notify('✅ Auto mode OFF — bash commands require approval again.', 'info');
      }
    },
  });
}
