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
 * In addition, a short HARDCODED_DENY list of "never auto-run" patterns
 * (rm -rf /, fork bomb, dd to raw disk, mkfs, pipe-to-shell from the
 * network, …) is checked FIRST. These block even if the user has a broad
 * allow rule above them. Set PI_BASH_PERMISSIONS_NO_HARDCODED_DENY=1 to
 * disable (not recommended).
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
 *
 * Environment:
 *   PI_BASH_PERMISSIONS_DISABLED=1           skip the gate entirely
 *   PI_BASH_PERMISSIONS_DEFAULT=allow|deny   default action when no UI
 *                                            (default: deny)
 *   PI_BASH_PERMISSIONS_NO_HARDCODED_DENY=1  disable the built-in denylist
 *
 * Pure helpers (splitCompound, matchesPattern, checkHardcodedDeny, …)
 * live in ./lib/bash-match.ts so they can be unit-tested under plain
 * `node --test` without pulling in the pi runtime.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type ExtensionAPI, type ExtensionContext } from '@mariozechner/pi-coding-agent';
import {
  checkHardcodedDeny,
  type LoadedRules,
  matchOne,
  type RuleFile,
  type Scope,
  splitCompound,
  truncate,
  twoTokenPattern,
} from './lib/bash-match.ts';

// ──────────────────────────────────────────────────────────────────────
// Rule storage
// ──────────────────────────────────────────────────────────────────────

const USER_RULES_PATH = join(homedir(), '.pi', 'bash-permissions.json');
const PROJECT_RULES_RELATIVE = join('.pi', 'bash-permissions.json');

function projectRulesPath(cwd: string): string {
  return resolve(cwd, PROJECT_RULES_RELATIVE);
}

function readRules(path: string): LoadedRules {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as RuleFile;
    return {
      allow: Array.isArray(parsed.allow) ? parsed.allow.map(String) : [],
      deny: Array.isArray(parsed.deny) ? parsed.deny.map(String) : [],
    };
  } catch {
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

async function askForPermission(ctx: ExtensionContext, command: string): Promise<Decision> {
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

  const choice = await ctx.ui.select(
    `⚠️  Bash tool request:\n\n  ${command}\n\nHow should pi proceed?`,
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

/**
 * Coalesced prompt for a compound/multi-line bash call with ≥2 unknown
 * sub-commands. A single decision applies to all of them.
 */
async function askForPermissionBatch(
  ctx: ExtensionContext,
  fullCommand: string,
  unknown: string[],
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

  const summary = unknown.map((sub, idx) => `  ${idx + 1}. ${truncate(sub, 120)}`).join('\n');
  const title =
    `⚠️  Bash tool request with ${unknown.length} unknown sub-commands:\n\n${summary}\n\n` +
    `Full command:\n  ${truncate(fullCommand, 200)}\n\nHow should pi proceed?`;

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

  const defaultFallback = process.env.PI_BASH_PERMISSIONS_DEFAULT === 'allow' ? 'allow' : 'deny';

  const loadLayers = (cwd: string): { scope: Scope; rules: LoadedRules }[] => [
    { scope: 'session' as const, rules: sessionRules },
    { scope: 'project' as const, rules: readRules(projectRulesPath(cwd)) },
    { scope: 'user' as const, rules: readRules(USER_RULES_PATH) },
  ];

  pi.on('session_shutdown', () => {
    sessionRules.allow.length = 0;
    sessionRules.deny.length = 0;
  });

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined;
    const command = String(event.input?.command ?? '').trim();
    if (!command) return undefined;

    const layers = loadLayers(ctx.cwd);
    const subcommands = splitCompound(command);

    // Pass 1: hardcoded deny trumps everything (including user allow rules).
    for (const sub of subcommands) {
      const reason = checkHardcodedDeny(sub);
      if (reason) {
        return {
          block: true,
          reason: `Blocked by built-in denylist (${reason}): "${sub}"`,
        };
      }
    }

    // Pass 2: any user/project/session deny anywhere in the chain → block.
    for (const sub of subcommands) {
      const m = matchOne(sub, layers);
      if (m?.kind === 'deny') {
        return {
          block: true,
          reason: `Blocked by ${m.scope} deny rule: "${m.pattern}" (matched "${sub}")`,
        };
      }
    }

    // Then: every sub-command must be explicitly allowed; otherwise prompt.
    const unknown: string[] = [];
    for (const sub of subcommands) {
      const m = matchOne(sub, layers);
      if (!m) unknown.push(sub);
    }
    if (unknown.length === 0) return undefined;

    if (!ctx.hasUI) {
      if (defaultFallback === 'allow') return undefined;
      return {
        block: true,
        reason:
          `No UI available for approval. Unknown command(s):\n  ${unknown.join('\n  ')}\n` +
          'Add a rule via /bash-allow or by editing ~/.pi/bash-permissions.json, ' +
          'or set PI_BASH_PERMISSIONS_DEFAULT=allow.',
      };
    }

    // ≥2 unknowns → one coalesced prompt for the whole batch.
    if (unknown.length >= 2) {
      const batch = await askForPermissionBatch(ctx, command, unknown);
      if (batch.kind === 'deny') {
        return {
          block: true,
          reason: batch.feedback ?? 'Blocked by user',
        };
      }
      if (batch.kind === 'allow-all-session') {
        for (const sub of unknown) sessionRules.allow.push(sub);
      }
      // allow-all-once: no persistence.
      return undefined;
    }

    // Exactly one unknown → rich dialog with save-rule options.
    const sub = unknown[0];
    const decision = await askForPermission(ctx, sub);
    if (decision.kind === 'deny') {
      return {
        block: true,
        reason: decision.feedback ?? 'Blocked by user',
      };
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
    return undefined;
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
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}
