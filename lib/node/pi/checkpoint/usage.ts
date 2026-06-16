/**
 * USAGE string for the `/rewind` command, kept in its own pure module so
 * the handler, the `--help` path, and the empty-arg path share one source
 * of truth (the convention every command in `config/pi/extensions/` follows).
 *
 * No pi imports.
 */

export const REWIND_USAGE = [
  '/rewind - review and restore files to match a point in the conversation',
  '',
  '  /rewind            recompute the plan for the current leaf vs disk and reopen the review',
  '                     (the change-your-mind / code-only path; never moves the conversation)',
  '  /rewind list       list message checkpoints (anchor entry, time, file count)',
  '  /rewind <entryId>  review/restore to that anchor without moving the conversation',
  '  /rewind --help     show this help',
  '',
  'Navigating the conversation tree opens the same review automatically.',
].join('\n');
