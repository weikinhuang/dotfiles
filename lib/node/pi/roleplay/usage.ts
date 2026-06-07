/**
 * USAGE text for the `/roleplay` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const ROLEPLAY_USAGE = [
  'Usage: /roleplay [list|cast <name>|import <path>|dir|rescan|casts]',
  '',
  'List the active cast (no args or `list`), switch / set the active cast',
  '(`cast <name>`), import a SillyTavern character card into the active cast',
  '(`import <path.json|.png>`), print the store dir (`dir`), rescan disk',
  '(`rescan`), or list every cast on disk (`casts`).',
].join('\n');
