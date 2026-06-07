/**
 * Shared confirmation flow for the agent drop / collapse tools
 * (`drop_image` in `context-trim.ts`, `collapse_output` in
 * `tool-collapse.ts`). Both tools resolve a set of recency-addressed
 * candidates and then gate the actual drop behind the SAME per-call
 * dialog, so the dialog + session-flag + "Edit selection…" wiring lives
 * here under `lib/node/pi/ext/` (pi-coupled glue shared across both
 * extensions) rather than being duplicated in each shell.
 *
 * It reuses the existing approval engine (`promptSelectWithFeedback`,
 * `DENY_WITH_FEEDBACK`) exactly as `bash-permissions` does, plus the
 * pure drop-specific {@link DropDecision} union + entries / title
 * builders from `context-edit/agent-drop.ts`, plus the interactive
 * uncheck-the-keeper multi-select from `multi-select-prompt.ts`.
 *
 * ext/ shares CODE, not STATE: the per-session `autoAllow` / `neverAllow`
 * flags live in each extension's own closure (one {@link DropSessionFlags}
 * object) and are passed in here; this module reads and mutates that
 * object but never owns it. Each extension clears its own flags on
 * `session_shutdown`.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { promptSelectWithFeedback } from '../approval-prompt.ts';
import { buildDropEntries, buildDropTitle, type DropDecision, type DropTitleItem } from '../context-edit/agent-drop.ts';
import { type MultiSelectItem } from './multi-select-list.ts';
import { promptMultiSelect } from './multi-select-prompt.ts';

/** Per-session decision flags, owned by the extension closure, cleared on shutdown. */
export interface DropSessionFlags {
  /** "Allow <tool> for this session" - auto-allow every drop. */
  autoAllow: boolean;
  /** "Never allow this session" - auto-deny every drop. */
  neverAllow: boolean;
}

export function emptyDropFlags(): DropSessionFlags {
  return { autoAllow: false, neverAllow: false };
}

export interface ConfirmDropArgs {
  /** Tool name echoed in the session-scoped dialog options (`drop_image` / `collapse_output`). */
  toolName: string;
  /** Action verb for the title, e.g. `drop` / `collapse`. */
  verb: string;
  /** Target noun for the title, e.g. `image(s)` / `tool output(s)`. */
  noun: string;
  /** Why the model wants to drop (shown in the dialog, stored for audit). */
  reason?: string;
  /** Selected items rendered into the dialog title (parallel to {@link rows}). */
  titleItems: DropTitleItem[];
  /** Tail-guarded items surfaced in the title (informational). */
  guardedItems?: DropTitleItem[];
  /** Explicit `drop` ordinals that addressed nothing (informational). */
  missing?: number[];
  /** Multi-select rows for "Edit selection…", parallel to {@link titleItems}. */
  rows: MultiSelectItem[];
  /** Session flags object (read + mutated in place). */
  flags: DropSessionFlags;
  /** Non-interactive fallback when there is no UI. */
  nonInteractiveDefault: 'allow' | 'deny';
}

/**
 * Outcome of the confirmation flow. `indices` are positions into the
 * caller's selected array that should actually be dropped (the full set
 * for plain allow, a subset after "Edit selection…"). `deny` carries
 * optional feedback returned to the model.
 */
export type ConfirmDropOutcome = { allow: true; indices: number[] } | { allow: false; feedback?: string };

const allIndices = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/**
 * Run the per-call confirmation. Honors the session flags first
 * (`neverAllow` -> deny, `autoAllow` -> allow), then the non-interactive
 * fallback, then the interactive dialog. Mutates `flags` when the user
 * picks a session-scoped option.
 */
export async function confirmDrop(ctx: ExtensionContext, args: ConfirmDropArgs): Promise<ConfirmDropOutcome> {
  const count = args.titleItems.length;
  if (count === 0) return { allow: false };

  // Session flags short-circuit the dialog (deny wins).
  if (args.flags.neverAllow) return { allow: false, feedback: `${args.toolName} is denied for this session.` };
  if (args.flags.autoAllow) return { allow: true, indices: allIndices(count) };

  // No UI -> conservative env default.
  if (!ctx.hasUI) {
    return args.nonInteractiveDefault === 'allow'
      ? { allow: true, indices: allIndices(count) }
      : { allow: false, feedback: 'No UI available for approval; set PI_CONTEXT_TRIM_DROP_DEFAULT=allow to opt in.' };
  }

  const title = buildDropTitle({
    verb: args.verb,
    noun: args.noun,
    items: args.titleItems,
    guarded: args.guardedItems,
    missing: args.missing,
    reason: args.reason,
  });

  const decision = await promptSelectWithFeedback<DropDecision>(
    ctx,
    title,
    buildDropEntries(args.toolName),
    { title: 'Tell the model why:', placeholder: 'e.g. keep the latest render, I am iterating on it' },
    (feedback) => ({ kind: 'deny', feedback }),
  );

  switch (decision.kind) {
    case 'allow-once':
      return { allow: true, indices: allIndices(count) };
    case 'allow-session':
      args.flags.autoAllow = true;
      return { allow: true, indices: allIndices(count) };
    case 'never-session':
      args.flags.neverAllow = true;
      return { allow: false, feedback: `${args.toolName} denied for the rest of this session.` };
    case 'edit-selection': {
      const kept = await promptMultiSelect(ctx, { title, items: args.rows });
      if (kept === undefined) return { allow: false, feedback: 'Selection cancelled.' };
      if (kept.length === 0) return { allow: false, feedback: 'Nothing left selected to drop.' };
      return { allow: true, indices: kept };
    }
    case 'deny':
      return { allow: false, feedback: decision.feedback };
  }
}
