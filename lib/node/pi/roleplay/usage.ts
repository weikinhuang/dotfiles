/**
 * USAGE text + argument-completion spec for the `/roleplay` command. Pure
 * module so the extension shell, the `--help` path, and the specs share
 * one source of truth.
 */

import { type SubverbSpec } from '../commands/complete.ts';

export const ROLEPLAY_USAGE = [
  'Usage: /roleplay [list|context|cast <name>|import <path>|event [hint]|images [simple|full|off]|newscene|dir|rescan|casts]',
  '',
  'List the active cast (no args or `list`), show the context-window state',
  '(`context`, aliases `ctx` / `window`), switch / set the active cast',
  '(`cast <name>`), import a SillyTavern character card into the active cast',
  '(`import <path.json|.png>`), queue a one-shot scene complication for your',
  'next reply (`event [hint]`; LLM-generated, or drawn from the `events` deck),',
  'show or select the image interface (`images [simple|full|off]`),',
  'start a fresh scene by archiving + clearing the recap / timeline / captured-fact',
  'carry-overs (`newscene`), print the store dir (`dir`), rescan disk (`rescan`),',
  'or list every cast on disk (`casts`).',
].join('\n');

/**
 * The `/roleplay` subverb completion spec. `listCasts` supplies the
 * `cast <name>` candidates (injected so the spec stays disk-free).
 */
export function roleplaySubverbs(listCasts: () => readonly string[]): SubverbSpec {
  return {
    list: { description: 'List the active cast' },
    context: { description: 'Show the context-window state (cutoffs, tokens, cache, drain)' },
    cast: { description: 'Switch / set the active cast', args: () => listCasts().map((c) => ({ label: c })) },
    import: { description: 'Import a SillyTavern card (.json/.png) into the active cast' },
    event: { description: 'Queue a one-shot scene complication (LLM-generated, or from the deck)' },
    images: { description: 'Show or change the image interface', args: ['simple', 'full', 'off'] },
    newscene: { description: 'Start a fresh scene: archive + clear the recap / timeline / fact carry-overs' },
    dir: { description: 'Print the roleplay store dir' },
    rescan: { description: 'Rescan the active cast from disk' },
    casts: { description: 'List every cast on disk' },
  };
}
