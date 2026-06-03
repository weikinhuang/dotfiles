/**
 * USAGE strings for the context-edit commands, shared by each handler's
 * `--help` path and its empty-arg path so the text has one source of
 * truth. No pi imports.
 */

export const CONTEXT_TRIM_USAGE = [
  'Usage: /context-trim [<id> [reason] | list | restore <id> | clear]',
  '',
  'Remove large/bulky content (images, big tool results, long messages) from the',
  "model's context, replaced by a placeholder. Non-destructive: the original stays",
  'in the session and can be restored. Survives reload and exit -> resume.',
  '',
  '  /context-trim              list trimmable content (heaviest first)',
  '  /context-trim <id> [why]   trim candidate <id> (e.g. img1, tool3, msg2)',
  '  /context-trim list         show active trims',
  '  /context-trim restore <id> undo a trim by its directive #id',
  '  /context-trim clear        undo all trims',
].join('\n');

export const CONTEXT_EDIT_USAGE = [
  'Usage: /context-edit [<id> | list | restore <id> | clear]',
  '',
  'Edit a user or assistant message in place for steering (OpenWebUI-style),',
  'without dropping any downstream turns. Non-destructive overlay: the original',
  'message stays in the session; the edit is reapplied each turn and survives',
  'reload and exit -> resume until you restore it.',
  '',
  '  /context-edit              list editable messages',
  '  /context-edit <id>         open an editor prefilled with message <id> (e.g. msg2)',
  '  /context-edit list         show active edits',
  '  /context-edit restore <id> undo an edit by its directive #id',
  '  /context-edit clear        undo all edits',
].join('\n');

export const TOOL_COLLAPSE_USAGE = [
  'Usage: /context-collapse [<id> [reason] | list | restore <id> | clear]',
  '',
  'Collapse a finished or fire-and-forget tool call + its result down to a',
  '[TOOL CALLED - reason] marker to reclaim context (e.g. a background comfyui job',
  'whose result the agent never needed). Non-destructive overlay; survives reload.',
  '',
  '  /context-collapse                list collapsible tool calls (background hinted)',
  '  /context-collapse <id> [why]     collapse candidate <id> (e.g. call2, tool3)',
  '  /context-collapse list           show active collapses',
  '  /context-collapse restore <id>   undo a collapse by its directive #id',
  '  /context-collapse clear          undo all collapses',
].join('\n');
