/**
 * Pure listing / label formatting for the `checkpoint` extension: the
 * `/rewind list` body and the "code ahead of conversation" out-of-sync
 * widget line. Kept out of the shell so the exact text is unit-testable.
 *
 * No pi imports.
 */

import type { CheckpointManifest } from './types.ts';

/**
 * Render the `/rewind list` body: a header plus one line per manifest
 * (`<anchor>  <local time>  <n> file(s)`), newest first. Callers only
 * invoke this when at least one checkpoint exists (the empty case has its
 * own "No checkpoints recorded yet." message).
 */
export function formatCheckpointList(manifests: readonly CheckpointManifest[]): string {
  const lines = [...manifests]
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((m) => {
      const when = new Date(m.timestamp).toLocaleString();
      const files = new Set(m.entries.map((e) => e.path)).size;
      return `${m.leafEntryId}  ${when}  ${files} file${files === 1 ? '' : 's'}`;
    });
  return ['Checkpoints (anchor · time · files):', ...lines].join('\n');
}

/** The out-of-sync widget line for `leftover` files still drifted from the conversation. */
export function outOfSyncWidgetText(leftover: number): string {
  return `⚠ code ahead of conversation - /rewind to review (${leftover} file${leftover === 1 ? '' : 's'})`;
}
