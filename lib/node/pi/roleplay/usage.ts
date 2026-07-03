/**
 * USAGE text for the `/roleplay` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const ROLEPLAY_USAGE = [
  'Usage: /roleplay [list|cast <name>|import <path>|event [hint]|newscene|dir|rescan|casts]',
  '',
  'List the active cast (no args or `list`), switch / set the active cast',
  '(`cast <name>`), import a SillyTavern character card into the active cast',
  '(`import <path.json|.png>`), queue a one-shot scene complication for your',
  'next reply (`event [hint]`; LLM-generated, or drawn from the `events` deck),',
  'start a fresh scene by archiving + clearing the recap / timeline / captured-fact',
  'carry-overs (`newscene`), print the store dir (`dir`), rescan disk (`rescan`),',
  'or list every cast on disk (`casts`).',
].join('\n');
