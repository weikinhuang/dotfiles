/**
 * Shared `Allow once / Allow this session / Deny + feedback` approval
 * prompt used by `filesystem.ts` and any other extension that needs the
 * same UX.
 *
 * Pure-helper conventions apply: the module is pi-runtime-free at
 * runtime and only depends on a structural slice of `ExtensionContext`
 * (see `ApprovalPromptContext` below). Same trick `bash-gate.ts` uses
 * to stay vitest-able without the pi runtime.
 */

// Narrow structural shape of what the prompt needs from an
// `ExtensionContext`. Typed loosely so this module doesn't have to
// import from `@earendil-works/pi-coding-agent` (which keeps it
// testable under vitest without the pi runtime).
export interface ApprovalPromptContext {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
  };
}

/**
 * Discriminated union returned by `askForPermission`.
 *
 *   - `allow-once`     - proceed with the current call only.
 *   - `allow-session`  - proceed AND remember; subsequent calls to the
 *                        same path/key skip the prompt for the rest of
 *                        the session.
 *   - `deny`           - block the call. Optional `feedback` carries
 *                        the user's free-text reason back to the model.
 *                        Empty/whitespace-only feedback is normalised
 *                        to `undefined` so callers can render a default.
 */
export type ApprovalDecision = { kind: 'allow-once' } | { kind: 'allow-session' } | { kind: 'deny'; feedback?: string };

/**
 * Sentinel decision value that tells {@link promptSelectWithFeedback}
 * to follow up with a free-text input prompt and return a deny
 * decision carrying that text. Use it wherever the picker offers a
 * "Deny with feedback…" entry.
 */
export const DENY_WITH_FEEDBACK = { kind: 'deny-feedback' as const };
export type DenyWithFeedback = typeof DENY_WITH_FEEDBACK;

export interface PromptEntry<D> {
  label: string;
  decision: D | DenyWithFeedback;
}

export interface FeedbackPromptCopy {
  title: string;
  placeholder?: string;
}

/**
 * Generic "pick one entry; if the user picks the deny-feedback
 * sentinel, collect free text" helper. Consolidates the dialog
 * scaffolding used by every extension-side approval gate
 * (`filesystem.ts` via {@link askForPermission}, `bash-permissions.ts`
 * for both single-command and batch prompts).
 *
 * Contract:
 *   - On dialog dismissal (`ctx.ui.select` returns `undefined`) we
 *     fall back to `buildDeny()` - fail-closed.
 *   - On `deny-feedback` selection we prompt for input, trim it, and
 *     pass it to `buildDeny`. Empty/whitespace-only input collapses to
 *     `undefined` so callers can render a default.
 *   - Otherwise we return the entry's decision verbatim.
 *
 * `D` is constrained to "something with a `kind`" so we can detect
 * the deny-feedback sentinel without losing the discriminated-union
 * shape on the way out.
 */
export async function promptSelectWithFeedback<D extends { kind: string }>(
  ctx: ApprovalPromptContext,
  title: string,
  entries: readonly PromptEntry<D>[],
  feedback: FeedbackPromptCopy,
  buildDeny: (feedback?: string) => D,
): Promise<D> {
  const choice = await ctx.ui.select(
    title,
    entries.map((e) => e.label),
  );
  const picked = entries.find((e) => e.label === choice);
  if (!picked) return buildDeny();
  const decision = picked.decision;
  if (decision.kind === 'deny-feedback') {
    const fb = await ctx.ui.input(feedback.title, feedback.placeholder);
    const trimmed = fb?.trim();
    return buildDeny(trimmed && trimmed.length > 0 ? trimmed : undefined);
  }
  // TS can't narrow `D | DenyWithFeedback` past the literal check above
  // when `D` is generic - asserting back to `D` is the standard escape.
  return decision as D;
}

export interface ApprovalPromptArgs {
  /** The pi tool that triggered the prompt (e.g. `'write'`, `'edit'`). */
  tool: string;
  /** The user-visible path being gated. Echoed in the prompt body. */
  path: string;
  /** One-line reason the path is gated (e.g. `'inside ~/.ssh'`). */
  detail: string;
  /**
   * Optional label identifying who is asking when the prompt is routed
   * to a different session's UI (e.g. a subagent prompting the parent).
   * Rendered as a header line above the dialog body. Omit for the
   * ordinary same-session prompt.
   */
  requester?: string;
}

export function buildApprovalPrompt(args: ApprovalPromptArgs): {
  title: string;
  entries: PromptEntry<ApprovalDecision>[];
  feedback: FeedbackPromptCopy;
} {
  const { tool, path, detail, requester } = args;
  const header = requester
    ? `⚠️  [${requester}] ${tool} wants to touch a protected path:`
    : `⚠️  ${tool} wants to touch a protected path:`;
  return {
    title: `${header}\n\n  ${path}\n  (${detail})\n\nHow should pi proceed?`,
    entries: [
      { label: 'Allow once', decision: { kind: 'allow-once' } },
      { label: `Allow "${path}" for this session`, decision: { kind: 'allow-session' } },
      { label: 'Deny', decision: { kind: 'deny' } },
      { label: 'Deny with feedback…', decision: DENY_WITH_FEEDBACK },
    ],
    feedback: { title: 'Tell the assistant why:', placeholder: 'e.g. read docs/foo.md instead' },
  };
}

/**
 * Ask the user how to proceed when an extension wants to gate a
 * tool call. Returns an `ApprovalDecision`; the caller is responsible
 * for actually applying it (block, allow-list, etc.).
 *
 * If the underlying `ctx.ui.select` returns `undefined` (e.g. the
 * dialog was dismissed), this function defaults to `{ kind: 'deny' }`
 * - same fail-closed behaviour the inlined helper had.
 */
export async function askForPermission(
  ctx: ApprovalPromptContext,
  args: ApprovalPromptArgs,
): Promise<ApprovalDecision> {
  const prompt = buildApprovalPrompt(args);
  return promptSelectWithFeedback<ApprovalDecision>(ctx, prompt.title, prompt.entries, prompt.feedback, (fb) => ({
    kind: 'deny',
    feedback: fb,
  }));
}
