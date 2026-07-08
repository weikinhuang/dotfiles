/**
 * secret-redactor - scrub credentials out of the model-bound copy of the
 * conversation, and rehydrate them back into tool calls on demand through
 * a just-in-time, bash-permissions-style approval gate.
 *
 * Threat model
 * ────────────
 * Catches ACCIDENTAL credential leakage to the provider: the agent runs
 * `cat .env`, `env`, `aws configure list`, prints a config, pastes a
 * connection string. It is NOT a defense against an adversarial model -
 * that is the job of the `sandbox` (kernel egress) and `bash-permissions`
 * (command approval) gates. This is defense-in-depth beside them, and the
 * bias is precision over recall: over-redaction silently corrupts the
 * agent's context, so we only redact when confident.
 *
 * Core property
 * ─────────────
 * Redaction happens in the `context` hook, which hands us a mutable deep
 * copy of the messages right before each LLM call. We rewrite text in
 * that copy ONLY. The real value stays in the displayed transcript, the
 * on-disk session, and the live shell - so `$VAR` / sourced-file auth
 * keeps working without the model ever seeing the literal, and nothing is
 * unrecoverable. Redaction is deterministic, so the model-bound prefix is
 * byte-stable across turns and the prompt cache holds.
 *
 * Two un-redaction surfaces, kept distinct:
 *   - REVEAL TO CONTEXT (`/unredact`, `reveal_secret`): the value becomes
 *     visible to the model again. Implemented by approving the handle in
 *     the store, which makes `redactText` skip it.
 *   - REHYDRATE TO SUBPROCESS (the `tool_call` JIT gate): the value flows
 *     into a command's arguments at execution time WITHOUT being revealed
 *     to context. The session-scoped rehydrate set lives in this closure.
 *
 * All detection / redaction / rehydration logic is in pure helpers under
 * lib/node/pi/secret-redactor/; this shell is wiring only. See
 * secret-redactor.md for the full reference.
 *
 * Environment:
 *   PI_SECRET_REDACTOR_DISABLED=1            skip the extension entirely
 *   PI_SECRET_REDACTOR_VERBOSE=1             notify per-turn hit count + labels
 *   PI_SECRET_REDACTOR_TRACE=<path>          append one line per decision
 *   PI_SECRET_REDACTOR_REVEAL_TOOL=1         register the reveal_secret model tool
 *   PI_SECRET_REDACTOR_REHYDRATE_DEFAULT=allow  non-interactive rehydration fallback
 */

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { completePositional } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { createNotifyOnce } from '../../../lib/node/pi/notify-once.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { loadRedactorConfig } from '../../../lib/node/pi/secret-redactor/config.ts';
import { redactMessages } from '../../../lib/node/pi/secret-redactor/context-walk.ts';
import { createLruMemo } from '../../../lib/node/pi/secret-redactor/memo.ts';
import {
  DEFAULT_CONFIG,
  redactText,
  type RedactorConfig,
  rehydrateText,
} from '../../../lib/node/pi/secret-redactor/redact.ts';
import { SecretStore } from '../../../lib/node/pi/secret-redactor/store.ts';
import { SECRET_REDACTOR_USAGE, UNREDACT_USAGE } from '../../../lib/node/pi/secret-redactor/usage.ts';
import { makeDiagnostics } from '../../../lib/node/pi/recovery-diagnostics.ts';

const STATUS_KEY = 'secret-redactor';
const MEMO_CAP = 500;

export default function secretRedactor(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_SECRET_REDACTOR_DISABLED)) return;

  const verbose = envTruthy(process.env.PI_SECRET_REDACTOR_VERBOSE);
  const { trace, notify } = makeDiagnostics({
    label: 'secret-redactor',
    tracePath: process.env.PI_SECRET_REDACTOR_TRACE,
    debug: verbose,
  });
  const rehydrateDefaultAllow = process.env.PI_SECRET_REDACTOR_REHYDRATE_DEFAULT === 'allow';

  const store = new SecretStore();
  // Session-scoped rehydrate approvals (subprocess only - does NOT reveal
  // the value to the model's context). Reveal-to-context lives in the
  // store's approved set.
  const rehydrateSession = new Set<string>();
  let config: RedactorConfig = DEFAULT_CONFIG;

  // LRU memo on raw-text -> redacted-text. `context` fires every request
  // over the whole transcript; deterministic redaction lets unchanged
  // history re-scan for free. Cleared whenever config or approvals change.
  // `config` is read live inside `compute`, so a `memo.clear()` on config
  // change is enough to keep results fresh.
  const memo = createLruMemo(MEMO_CAP, (text) => redactText(text, store, config).text);

  const configWarnings = createNotifyOnce<{ path: string; error: string }>({
    tag: 'secret-redactor',
    keyOf: (w) => `${w.path}:${w.error}`,
    render: (w, tag) => `${tag}: ${w.path}: ${w.error}`,
  });

  const updateStatus = (ctx: ExtensionContext): void => {
    const n = store.redactedCount();
    ctx.ui.setStatus(STATUS_KEY, n > 0 ? `🔒 ${n} redacted` : undefined);
  };

  /** Reveal a handle to the model context (and implicitly to rehydration). */
  const revealHandle = (handle: string): boolean => {
    const ok = store.approve(handle);
    if (ok) memo.clear(); // approved values must stop being redacted
    return ok;
  };

  pi.on('session_start', (_event, ctx) => {
    store.clear();
    rehydrateSession.clear();
    memo.clear();
    configWarnings.reset();
    const loaded = loadRedactorConfig(ctx.cwd);
    config = loaded.config;
    configWarnings.surface(ctx.ui.notify.bind(ctx.ui), loaded.warnings);
    trace(
      `config loaded: prefixed=${config.layers.prefixed} keyword=${config.layers.keyword} ` +
        `custom=${config.customRules.length} allowlist=${config.allowlist.length}`,
    );
  });

  pi.on('session_shutdown', () => {
    store.clear();
    rehydrateSession.clear();
    memo.clear();
  });

  // ────────────────────────────────────────────────────────────────────
  // context hook: redact the model-bound copy
  // ────────────────────────────────────────────────────────────────────

  pi.on('context', (event, ctx) => {
    const changed = redactMessages(event.messages, (text) => memo.get(text));
    updateStatus(ctx);
    if (!changed) return undefined;
    trace(`context: redacted provider copy, ${store.redactedCount()} active / ${store.size()} tracked this session`);
    if (verbose)
      notify(ctx, `secret-redactor: ${store.redactedCount()} secret(s) redacted from the provider copy`, 'info');
    return { messages: event.messages };
  });

  // ────────────────────────────────────────────────────────────────────
  // tool_call hook: JIT rehydration gate
  // ────────────────────────────────────────────────────────────────────

  pi.on('tool_call', async (event, ctx) => {
    const input = event.input as Record<string, unknown>;
    if (!input) return undefined;

    // Collect every known handle referenced across the call's string args.
    const refs = new Set<string>();
    for (const value of Object.values(input)) {
      if (typeof value === 'string') for (const h of store.referencedHandles(value)) refs.add(h);
    }
    if (refs.size === 0) return undefined;

    // Decide which handles may be rehydrated into THIS call. Handles
    // already approved (revealed) or session-rehydrate pass straight
    // through; the rest get ONE batched approval prompt.
    const allowForCall = new Set<string>();
    const denied: string[] = [];
    const pending: string[] = [];
    for (const handle of refs) {
      if (store.isApproved(handle) || rehydrateSession.has(handle)) allowForCall.add(handle);
      else if (store.lookup(handle)) pending.push(handle);
    }

    if (pending.length > 0) {
      if (!ctx.hasUI) {
        if (rehydrateDefaultAllow) for (const h of pending) allowForCall.add(h);
        else denied.push(...pending);
      } else {
        const labels = pending.map((h) => `[${store.lookup(h)?.label ?? 'secret'}#${h}]`).join(', ');
        const cmdPreview = typeof input.command === 'string' ? `\n  ${input.command.slice(0, 200)}` : '';
        const choice = await ctx.ui.select(`Reveal secret(s) ${labels} to this ${event.toolName} call?${cmdPreview}`, [
          'Allow once',
          'Allow for this session',
          'Deny',
        ]);
        if (choice === undefined || choice === 'Deny') {
          denied.push(...pending);
        } else if (choice === 'Allow for this session') {
          for (const h of pending) {
            rehydrateSession.add(h);
            allowForCall.add(h);
          }
        } else {
          for (const h of pending) allowForCall.add(h); // Allow once
        }
      }
    }

    if (denied.length > 0) {
      trace(`blocked tool=${event.toolName} denied=[${denied.join(',')}]`);
      return {
        block: true,
        reason:
          `Denied: the secret(s) referenced as ${denied.map((h) => `#${h}`).join(', ')} were not approved for this ` +
          `${event.toolName} call. Reference the value from the shell environment (e.g. $VAR or a sourced file) ` +
          `instead of pasting the literal, or ask the user to /unredact the handle.`,
      };
    }

    // Rehydrate approved handles into each string arg, in place.
    let rehydrated = 0;
    for (const key of Object.keys(input)) {
      const value = input[key];
      if (typeof value !== 'string') continue;
      const { text, used } = rehydrateText(value, (h) => (allowForCall.has(h) ? store.lookup(h)?.value : undefined));
      if (used.length > 0) {
        input[key] = text;
        rehydrated += used.length;
      }
    }
    if (rehydrated > 0) trace(`rehydrated tool=${event.toolName} count=${rehydrated}`);
    return undefined;
  });

  // ────────────────────────────────────────────────────────────────────
  // Commands
  // ────────────────────────────────────────────────────────────────────

  pi.registerCommand('unredact', {
    description: 'Reveal a redacted secret to the model by its #handle',
    getArgumentCompletions: (prefix) =>
      completePositional(prefix.replace(/^#/, ''), () =>
        store.entries().map((e) => ({ value: e.handle, label: `${e.handle}  (${e.label})` })),
      ),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(UNREDACT_USAGE, 'info');
        return;
      }
      const handle = args.trim().replace(/^#/, '');
      if (!handle) {
        ctx.ui.notify(UNREDACT_USAGE, 'warning');
        return;
      }
      const entry = store.lookup(handle);
      if (!entry) {
        ctx.ui.notify(`No redacted secret with handle #${handle} this session.`, 'warning');
        return;
      }
      const ok = await ctx.ui.confirm(
        'Reveal this secret to the model?',
        `[${entry.label}#${entry.handle}] will be sent to the provider in future turns.`,
      );
      if (!ok) return;
      revealHandle(handle);
      ctx.ui.notify(`Revealed [${entry.label}#${entry.handle}] - it will no longer be redacted this session.`, 'info');
    },
  });

  pi.registerCommand('secret-redactor', {
    description: 'List secrets redacted this session and approve specific ones',
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(SECRET_REDACTOR_USAGE, 'info');
        return;
      }
      const entries = store.entries();
      const lines: string[] = [
        `secret-redactor: layers prefixed=${config.layers.prefixed} keyword=${config.layers.keyword}, ` +
          `${config.customRules.length} custom rule(s), ${config.allowlist.length} allowlist pattern(s)`,
        '',
      ];
      if (entries.length === 0) {
        lines.push('No secrets redacted this session.');
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }
      for (const e of entries) {
        const state = store.isApproved(e.handle)
          ? 'revealed'
          : rehydrateSession.has(e.handle)
            ? 'rehydrate-ok'
            : 'redacted';
        lines.push(`  #${e.handle}  ${e.label}  [${state}]`);
      }
      lines.push('', 'Reveal one with /unredact <handle>.');
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  // ────────────────────────────────────────────────────────────────────
  // Optional model-callable reveal tool (opt-in)
  // ────────────────────────────────────────────────────────────────────

  if (envTruthy(process.env.PI_SECRET_REDACTOR_REVEAL_TOOL)) {
    const RevealParams = Type.Object({
      handle: Type.String({ description: 'The #handle of the redacted secret (without the # prefix).' }),
      reason: Type.String({ description: 'Why you need the literal value revealed. Shown to the user at the prompt.' }),
    });
    interface RevealDetails {
      handle: string;
      revealed: boolean;
    }
    pi.registerTool<typeof RevealParams, RevealDetails>({
      name: 'reveal_secret',
      label: 'Reveal secret',
      description:
        'Request that a redacted secret (shown to you as [REDACTED:label#handle]) be revealed to you. The user must ' +
        'approve. Prefer referencing the value from the shell (e.g. $VAR) over revealing it; only call this when you ' +
        'genuinely need the literal in your own output.',
      parameters: RevealParams,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const handle = params.handle.replace(/^#/, '').trim();
        const entry = store.lookup(handle);
        if (!entry) {
          return {
            content: [{ type: 'text' as const, text: `No redacted secret with handle #${handle}.` }],
            details: { handle, revealed: false },
            isError: true,
          };
        }
        const ok = ctx.hasUI
          ? await ctx.ui.confirm('Reveal secret to the model?', `[${entry.label}#${entry.handle}] - ${params.reason}`)
          : false;
        if (!ok) {
          return {
            content: [{ type: 'text' as const, text: `Reveal of #${handle} denied by user.` }],
            details: { handle, revealed: false },
            isError: true,
          };
        }
        revealHandle(handle);
        return { content: [{ type: 'text' as const, text: entry.value }], details: { handle, revealed: true } };
      },
    });
  }
}
