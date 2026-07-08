/**
 * Shared types for the `checkpoint` extension's pure core.
 *
 * A {@link CheckpointManifest} is one per user message (anchored to a
 * session-tree entry id), holding the per-file {@link CheckpointEntry}
 * records captured as the agent's `write` / `edit` / `apply_patch` tools
 * mutate the work-tree. Each entry stores the `before` blob hash (for the
 * undo leg) and the `after` blob hash (for conflict detection AND the
 * forward-redo leg) - see `resolve.ts` for how the two legs combine.
 *
 * No pi imports - everything here is plain data so the resolution /
 * conflict / diff / restore logic can be unit-tested under vitest.
 */

/** The three tools whose writes we snapshot in tool-level mode. */
export type CaptureTool = 'write' | 'edit' | 'apply_patch';

/**
 * One file touched by one tool call within a message.
 *
 * `before`/`after` are sha256 hex hashes of the file's bytes (the bytes
 * themselves live in the content-addressed blob store), or `null` to mean
 * "the file did not exist at this point":
 *   - `before: null` → file was absent before the write; undo deletes it.
 *   - `after: null`  → the write deleted the file; redo deletes it.
 */
export interface CheckpointEntry {
  path: string;
  before: string | null;
  after: string | null;
  tool: CaptureTool;
  toolCallId: string;
}

/**
 * All file snapshots for a single user message, anchored to the session
 * tree entry that was the leaf when the message started (the restore
 * anchor). Persisted as `<entryId>.json` in the project-scoped store.
 */
export interface CheckpointManifest {
  /** Session tree node this message hung off - the restore anchor. */
  leafEntryId: string;
  timestamp: number;
  entries: CheckpointEntry[];
  /** Full mode only: commit sha in the side checkpoint git-dir. */
  treeRef?: string;
}

/**
 * Per-file classification for the restore review, comparing the file's
 * bytes on disk against its recorded target / expected-current states:
 *   - `no-op`         → disk already equals the target (hidden by default).
 *   - `clean-restore` → disk equals the expected-current state, so the
 *                       restore is a clean swap.
 *   - `conflict`      → disk matches neither (edited out-of-band).
 */
export type FileStatus = 'clean-restore' | 'no-op' | 'conflict';

/**
 * The recorded content of one file at the two ends of a navigation move,
 * computed by `resolve.ts` from the undo + redo manifest legs. Hashes are
 * sha256 hex, or `null` for "file absent at this point".
 */
export interface FileTarget {
  path: string;
  /** Recorded content as of the new leaf (where navigation is going). */
  target: string | null;
  /** Recorded content as of the old leaf (where navigation is coming from). */
  expectedCurrent: string | null;
}

/**
 * A row in the restore review: a resolved {@link FileTarget} plus how it
 * differs from the file's current bytes on disk. Built by the pure
 * {@link import('./review.ts').buildReviewRow} from disk + blob content and
 * consumed by the pi-coupled `ReviewOverlay` (which re-exports this type).
 * Lives here (not in `ext/`) so the pure row builder can produce it without
 * pulling in the pi-tui overlay.
 */
export interface ReviewRow {
  target: FileTarget;
  status: FileStatus;
  adds: number;
  dels: number;
  /** Current bytes on disk as text, or null if absent. */
  currentText: string | null;
  /** Restore-target bytes as text, or null if the target state is "absent". */
  targetText: string | null;
  checked: boolean;
}
