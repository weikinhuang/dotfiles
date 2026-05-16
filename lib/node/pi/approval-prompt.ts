/**
 * Shared `Allow once / Allow this session / Deny + feedback` approval
 * prompt. Extracted from `config/pi/extensions/protected-paths.ts` so
 * other extensions (notably the upcoming `mode.ts` write-roots gate)
 * can reuse the exact same UX.
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

export interface ApprovalPromptArgs {
  /** The pi tool that triggered the prompt (e.g. `'write'`, `'edit'`). */
  tool: string;
  /** The user-visible path being gated. Echoed in the prompt body. */
  path: string;
  /** One-line reason the path is gated (e.g. `'inside ~/.ssh'`). */
  detail: string;
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
  const { tool, path, detail } = args;

  interface Entry {
    label: string;
    decision: ApprovalDecision | 'deny-feedback';
  }
  const entries: Entry[] = [
    { label: 'Allow once', decision: { kind: 'allow-once' } },
    { label: `Allow "${path}" for this session`, decision: { kind: 'allow-session' } },
    { label: 'Deny', decision: { kind: 'deny' } },
    { label: 'Deny with feedback…', decision: 'deny-feedback' },
  ];

  const choice = await ctx.ui.select(
    `⚠️  ${tool} wants to touch a protected path:\n\n  ${path}\n  (${detail})\n\nHow should pi proceed?`,
    entries.map((e) => e.label),
  );

  const picked = entries.find((e) => e.label === choice);
  if (!picked) return { kind: 'deny' };

  if (picked.decision === 'deny-feedback') {
    const feedback = await ctx.ui.input('Tell the assistant why:', 'e.g. read docs/foo.md instead');
    const trimmed = feedback?.trim();
    // Empty / whitespace-only feedback collapses to undefined so callers
    // can render a default rather than echoing a blank line back.
    if (trimmed && trimmed.length > 0) return { kind: 'deny', feedback: trimmed };
    return { kind: 'deny' };
  }
  return picked.decision;
}
