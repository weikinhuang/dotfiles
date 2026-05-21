/**
 * Helpers for surfacing ASRT's
 * `annotateStderrWithSandboxFailures(command, stderr)` output back to
 * the model through pi's `tool_result` content shape.
 *
 * The extension shell (`config/pi/extensions/sandbox.ts`) owns the
 * SandboxManager lifecycle and the JSONL audit log; this module just
 * does the pure string-and-content-array splicing so the behaviour
 * is unit-testable without ASRT or pi runtime types.
 */

export interface BashContentText {
  type: 'text';
  text?: string;
}
export type BashContentItem = BashContentText | { type: string; text?: string };

export interface AnnotateResult {
  content: BashContentItem[];
  /** Just the new hint string (without the original stderr suffix);
   *  surfaced separately so callers can also write it into the
   *  violations JSONL audit row. */
  hint: string;
  /** Kind classification used for the violations log row. */
  kind: 'net' | 'fs';
}

/**
 * Compose the rewritten `tool_result` content array.
 *
 * - Strips the leading `stderr` substring from `annotated` when ASRT's
 *   annotator returned the original stderr concatenated with its hint
 *   (the common shape - we don't want to duplicate the existing tail).
 * - Returns undefined when the resulting hint would be empty or when
 *   the `content` array is empty / has no text items.
 * - Splices the hint at the top of the first text content; other
 *   content items pass through unchanged so downstream tool_result
 *   handlers (bash-exit-watchdog, tool-output-condenser, …) keep
 *   working.
 *
 * The visible tag (`⚠️  sandbox blocked this operation:`) makes the
 * violation easy to spot in the transcript even after the condenser
 * truncates long output.
 */
export function annotateBashResult(
  annotated: string,
  stderr: string,
  content: readonly BashContentItem[] | undefined,
): AnnotateResult | undefined {
  if (!annotated || annotated === stderr) return undefined;
  if (!content || content.length === 0) return undefined;

  const hint = annotated.startsWith(stderr) ? annotated.slice(stderr.length).trimStart() : annotated;
  if (!hint.trim()) return undefined;

  const firstTextIdx = content.findIndex((c) => c.type === 'text');
  const tag = '⚠️  sandbox blocked this operation:';
  const prefix = `${tag}\n${hint}\n---\n`;

  let newContent: BashContentItem[];
  if (firstTextIdx === -1) {
    newContent = [{ type: 'text', text: prefix }, ...content];
  } else {
    const first = content[firstTextIdx] as BashContentText;
    newContent = content.map((c, i) =>
      i === firstTextIdx ? ({ ...first, text: `${prefix}${first.text ?? ''}` } satisfies BashContentText) : c,
    );
  }

  const kind: 'net' | 'fs' = /network|connect|host|domain/i.test(hint) ? 'net' : 'fs';
  return { content: newContent, hint, kind };
}

/**
 * Prepend a free-form hint to the first text item of a bash tool_result
 * content array. Returns the rewritten content, or undefined when the
 * array is empty / has no text item we can splice into.
 *
 * Used by the reactive filesystem-ask flow to tell the model "the user
 * just granted write access to X; you may retry the previous command on
 * the next turn" after the user accepted the dialog. The hint is
 * wrapped with the same `⚠️  sandbox …:` tag shape as
 * {@link annotateBashResult} so transcripts read consistently across
 * the preventive and reactive paths.
 */
export function prependBashHint(
  content: readonly BashContentItem[] | undefined,
  hint: string,
  tag: string,
): BashContentItem[] | undefined {
  if (!content || content.length === 0) return undefined;
  const trimmed = hint.trim();
  if (!trimmed) return undefined;
  const prefix = `${tag}\n${trimmed}\n---\n`;

  const firstTextIdx = content.findIndex((c) => c.type === 'text');
  if (firstTextIdx === -1) {
    return [{ type: 'text', text: prefix }, ...content];
  }
  const first = content[firstTextIdx] as BashContentText;
  return content.map((c, i) =>
    i === firstTextIdx ? ({ ...first, text: `${prefix}${first.text ?? ''}` } satisfies BashContentText) : c,
  );
}
