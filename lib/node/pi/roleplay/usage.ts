/**
 * USAGE text + argument-completion spec for the `/roleplay` command. Pure
 * module so the extension shell, the `--help` path, and the specs share
 * one source of truth.
 */

import { type SubverbSpec } from '../commands/complete.ts';

export const ROLEPLAY_USAGE = [
  'Usage: /roleplay [list|context|lore|recap [show|force]|relationships|cast <name>|import <path>|export [character] [path]|event [hint]|images [simple|full|off]|newscene|dir|rescan|casts]',
  '',
  'List the active cast (no args or `list`), show the context-window state',
  "(`context`, aliases `ctx` / `window`), show the last turn's lore selection and",
  'sticky / cooldown timing (`lore`), show the recap + coverage + timeline preview',
  'or force the next context pass to roll the recap (`recap [show|force]`), list',
  'relationship records with decayed affinity (`relationships`, alias `rel`),',
  'switch / set the active cast (`cast <name>`), import a SillyTavern character',
  'card into the active cast (`import <path.json|.png>`), export a character +',
  'the active lore as a Character Card V2 JSON (`export [character] [path]`;',
  'defaults to the primary character and `<cwd>/<slug>.card.json`), queue a',
  'one-shot scene complication for your next reply (`event [hint]`;',
  'LLM-generated, or drawn from the `events` deck),',
  'show or select the image interface (`images [simple|full|off]`),',
  'start a fresh scene by archiving + clearing the recap / timeline / captured-fact',
  'carry-overs (`newscene`), print the store dir (`dir`), rescan disk (`rescan`),',
  'or list every cast on disk (`casts`).',
].join('\n');

/**
 * The `/roleplay` subverb completion spec. `listCasts` supplies the
 * `cast <name>` candidates and `listCharacters` the `export <character>`
 * ids (both injected so the spec stays disk-free).
 */
export function roleplaySubverbs(
  listCasts: () => readonly string[],
  listCharacters: () => readonly string[] = () => [],
): SubverbSpec {
  return {
    list: { description: 'List the active cast' },
    context: { description: 'Show the context-window state (cutoffs, tokens, cache, drain)' },
    lore: { description: "Show the last turn's lore selection and sticky / cooldown timing" },
    recap: { description: 'Show the recap state, or force the next pass to roll it', args: ['show', 'force'] },
    relationships: { description: 'List relationship records with decayed affinity' },
    cast: { description: 'Switch / set the active cast', args: () => listCasts().map((c) => ({ label: c })) },
    import: { description: 'Import a SillyTavern card (.json/.png) into the active cast' },
    export: {
      description: 'Export a character + active lore as a Character Card V2 JSON',
      args: () => listCharacters().map((c) => ({ label: c })),
    },
    event: { description: 'Queue a one-shot scene complication (LLM-generated, or from the deck)' },
    images: { description: 'Show or change the image interface', args: ['simple', 'full', 'off'] },
    newscene: { description: 'Start a fresh scene: archive + clear the recap / timeline / fact carry-overs' },
    dir: { description: 'Print the roleplay store dir' },
    rescan: { description: 'Rescan the active cast from disk' },
    casts: { description: 'List every cast on disk' },
  };
}
