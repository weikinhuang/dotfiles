/**
 * Pure construction of the restore-review rows for the `checkpoint`
 * extension. Given a resolved {@link FileTarget}, the file's current bytes
 * on disk (text + hash), and the recorded target bytes, produce the
 * {@link ReviewRow} the overlay renders - or `undefined` to hide the row.
 *
 * The shell owns the I/O (reading disk, fetching blobs); this module owns
 * the classification + diff-count + default-checked decisions so they are
 * unit-testable without the pi runtime. The target text is passed as a
 * thunk so a hidden `no-op` row never pays for the blob read.
 *
 * No pi imports.
 */

import { classifyFile } from './conflict.ts';
import { countDiff } from './diff.ts';
import type { FileTarget, ReviewRow } from './types.ts';

/** Row-default knobs, sourced from the resolved checkpoint config. */
export interface ReviewRowOptions {
  /** Hide rows where disk already equals the target (a `no-op`). */
  hideNoOpRows: boolean;
  /** Whether `conflict` rows start checked (opt-in restore). */
  conflictRowsDefaultChecked: boolean;
}

/**
 * Build one {@link ReviewRow} for `target`, comparing the file's current
 * disk bytes (`diskText` / `diskHash`, both `null` when absent) against the
 * recorded target. Returns `undefined` for a `no-op` row when
 * `hideNoOpRows` is set - and, crucially, short-circuits BEFORE calling
 * `readTargetText`, so a hidden row never triggers the blob read the shell
 * would otherwise do.
 *
 * Row `checked` defaults: `clean-restore` on, `conflict` per
 * `conflictRowsDefaultChecked`, everything else off.
 */
export function buildReviewRow(
  target: FileTarget,
  diskText: string | null,
  diskHash: string | null,
  readTargetText: () => string | null,
  opts: ReviewRowOptions,
): ReviewRow | undefined {
  const status = classifyFile(target, diskHash);
  if (status === 'no-op' && opts.hideNoOpRows) return undefined;
  const targetText = readTargetText();
  const { adds, dels } = countDiff(diskText, targetText);
  const checked = status === 'clean-restore' ? true : status === 'conflict' ? opts.conflictRowsDefaultChecked : false;
  return { target, status, adds, dels, currentText: diskText, targetText, checked };
}

/**
 * Sort review rows by target path (ascending), the stable order the
 * overlay presents. Returns a new array; the input is left untouched.
 */
export function sortReviewRows(rows: readonly ReviewRow[]): ReviewRow[] {
  return [...rows].sort((a, b) => (a.target.path < b.target.path ? -1 : a.target.path > b.target.path ? 1 : 0));
}
