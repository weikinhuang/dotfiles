/**
 * UI-side dialogs for the bash-permissions extension. Pi-free helpers
 * lifted out of `config/pi/extensions/bash-permissions.ts` so the
 * dialog wording, decision unions, and feedback handling become unit
 * testable without spinning up the full pi runtime.
 *
 * The extension still owns the `gateBashCommand` pipeline and the
 * persistence side-effects (`addRule`, `notify`). This module exposes
 * the two prompt entry points it needs:
 *
 *   - {@link askForPermission} - rich single-command dialog with
 *     allow-once / allow-session-exact / allow-project-exact /
 *     allow-project-two-token / allow-user-prefix / deny variants.
 *   - {@link askForPermissionBatch} - coalesced multi-command dialog
 *     (allow-all-once / allow-all-session / deny).
 *
 * Both share {@link compactForDialog} to collapse multi-line / huge
 * shell input down to one short rendered line so the dialog stays a
 * predictable size in small terminals.
 */

import { DENY_WITH_FEEDBACK, promptSelectWithFeedback } from './approval-prompt.ts';
import type { BashGateContext } from './bash-gate.ts';
import { twoTokenPattern } from './bash-match.ts';
import { truncate } from './shared.ts';

/**
 * Decision returned by the single-command prompt. Includes every
 * persistence variant the bash-permissions extension supports today;
 * the extension applies the side-effect (write project rule, write
 * user rule, push session entry) at the call site.
 */
export type BashPermissionDecision =
  | { kind: 'allow-once' }
  | { kind: 'allow-session-exact' }
  | { kind: 'allow-project-exact' }
  | { kind: 'allow-project-two-token'; pattern: string }
  | { kind: 'allow-user-prefix'; pattern: string }
  | { kind: 'deny'; feedback?: string };

/**
 * Decision returned by the coalesced batch prompt. Batch decisions
 * apply to every unknown sub-command in the original compound bash
 * call - the extension fans the choice out across the list.
 */
export type BashBatchDecision =
  | { kind: 'allow-all-once' }
  | { kind: 'allow-all-session' }
  | { kind: 'deny'; feedback?: string };

export interface AskForPermissionExtras {
  /** Session auto mode is currently ON. */
  auto?: boolean;
  /** Reason the always-prompt list forced this prompt (e.g. "sudo"). */
  alwaysPromptReason?: string;
}

export interface AskForPermissionBatchExtras {
  /** Session auto mode is currently ON. */
  auto?: boolean;
  /**
   * Map sub-command → always-prompt reason. Sub-commands that aren't
   * in the map landed in the prompt for the ordinary "unknown command"
   * reason.
   */
  alwaysPromptReasons?: Map<string, string>;
}

/**
 * Collapse whitespace (including newlines) to single spaces and
 * truncate.
 *
 * Pi's ExtensionSelectorComponent has no scrolling / height clamp - it
 * renders every child line directly. If the dialog grows taller than
 * the terminal, the terminal itself scrolls and the UI flickers wildly
 * on every repaint. Keeping the rendered command to one short line is
 * the cheapest way to keep the dialog a predictable ~10–12 rows
 * regardless of how long the original bash call was.
 */
export function compactForDialog(s: string, maxLen = 160): string {
  return truncate(s.replace(/\s+/g, ' ').trim(), maxLen);
}

/**
 * Render the rich single-unknown-command prompt. Side-effect free -
 * the caller applies the returned decision (allow-list push, project
 * rule write, etc.) at its own discretion.
 */
export async function askForPermission(
  ctx: BashGateContext,
  command: string,
  extras: AskForPermissionExtras = {},
): Promise<BashPermissionDecision> {
  const trimmed = command.trimStart();
  const firstToken = trimmed.split(/[\s|&;<>()]/)[0] ?? command;
  const twoToken = twoTokenPattern(command);
  const userPrefixPattern = `${firstToken}*`;

  const entries: { label: string; decision: BashPermissionDecision | typeof DENY_WITH_FEEDBACK }[] = [
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
  entries.push({ label: 'Deny with feedback…', decision: DENY_WITH_FEEDBACK });

  // `command` is shown inline in the dialog title; collapse newlines
  // and cap the length so multi-line heredocs / long scripts don't
  // blow the dialog past the terminal height (see compactForDialog).
  const displayCommand = compactForDialog(command);
  const titleLines: string[] = ['⚠️  Bash tool request:', '', `  ${displayCommand}`];
  if (extras.auto && extras.alwaysPromptReason) {
    titleLines.push('', `⚡ auto mode cannot skip this (${extras.alwaysPromptReason}).`);
  }
  titleLines.push('', 'How should pi proceed?');

  return promptSelectWithFeedback<BashPermissionDecision>(
    ctx,
    titleLines.join('\n'),
    entries,
    { title: 'Tell the assistant why:', placeholder: 'e.g. use the test script instead' },
    (feedback) => ({ kind: 'deny', feedback }),
  );
}

/**
 * Coalesced prompt for a compound / multi-line bash call with ≥ 2
 * unknown sub-commands. A single decision applies to all of them.
 */
export async function askForPermissionBatch(
  ctx: BashGateContext,
  fullCommand: string,
  unknown: string[],
  extras: AskForPermissionBatchExtras = {},
): Promise<BashBatchDecision> {
  const entries: { label: string; decision: BashBatchDecision | typeof DENY_WITH_FEEDBACK }[] = [
    { label: `Allow all ${unknown.length} once`, decision: { kind: 'allow-all-once' } },
    { label: `Allow all ${unknown.length} for this session`, decision: { kind: 'allow-all-session' } },
    { label: 'Deny', decision: { kind: 'deny' } },
    { label: 'Deny with feedback…', decision: DENY_WITH_FEEDBACK },
  ];

  // Cap the number of sub-commands rendered inline so the dialog
  // stays within a reasonable height on small terminals; the remainder
  // is summarised as a single "…and N more" line. Each visible
  // sub-command is also whitespace-collapsed so multi-line fragments
  // don't each expand into many rendered rows.
  const MAX_VISIBLE_SUBS = 6;
  const visible = unknown.slice(0, MAX_VISIBLE_SUBS);
  const hidden = unknown.length - visible.length;
  const summaryLines = visible.map((sub, idx) => {
    const reason = extras.alwaysPromptReasons?.get(sub);
    const marker = reason ? '  ⚡ ' : '  ';
    return `${marker}${idx + 1}. ${compactForDialog(sub, 100)}${reason ? ` - ${reason}` : ''}`;
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

  return promptSelectWithFeedback<BashBatchDecision>(
    ctx,
    title,
    entries,
    { title: 'Tell the assistant why:', placeholder: 'e.g. split these into separate calls' },
    (feedback) => ({ kind: 'deny', feedback }),
  );
}
