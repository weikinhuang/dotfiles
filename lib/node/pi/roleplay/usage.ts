/**
 * USAGE text + argument-completion spec for the `/roleplay` command. Pure
 * module so the extension shell, the `--help` path, and the specs share
 * one source of truth.
 */

import { completeSubverbs, type CompletionItem, type SubverbSpec } from '../commands/complete.ts';

const REQUEST_FLAGS = ['--json', '--snippets', '--content', '--section', '--turn', '--request'];
const REQUEST_SECTIONS = [
  'system',
  'tools',
  'conversation',
  'recap',
  'timeline',
  'lore',
  'depth',
  'scene-fold',
  'memory',
  'other-reminder',
  'head',
  'tail',
];

export const ROLEPLAY_USAGE = [
  'Usage: /roleplay [list|context|lore|recap [show|force|now]|summary|timeline [--all]|facts [--content]|budget [set N|off]|opener [show|pin [reply]|unpin]|jobs [retry facts|timeline|all|drain]|request|debug|relationships|cast <name>|import <path>|export [character] [path]|event [hint]|images [simple|full|off]|newscene|dir|rescan|casts]',
  '',
  'List the active cast (no args or `list`), show the context-window state',
  "(`context`, aliases `ctx` / `window`), show the last turn's lore selection and",
  'sticky / cooldown timing (`lore`), show the recap + coverage + timeline preview',
  'or force the next context pass to roll the recap (`recap [show|force|now]`);',
  '`recap now` immediately performs model work without adding a narrative turn.',
  '`summary` shows full sensitive local recap text without a model call;',
  '`timeline [--all]` shows a capped injection preview, or all sensitive local text;',
  '`facts [--content]` reports content-free active-branch captures by default.',
  '`budget [set N|off]` sets a soft full-input target (integer N >= 1024).',
  '`opener [show|pin [reply]|unpin]` reports head metadata or sets scene-local pinning.',
  '`jobs` reports safe queue status; `jobs retry facts|timeline|all` and `jobs drain`',
  'explicitly run queued model work, never automatically backfilling legacy gaps.',
  '`request` / `debug` report metadata by default; flags: --json, --snippets,',
  '--section <system|tools|conversation|recap|timeline|lore|depth|scene-fold|memory|other-reminder|head|tail>',
  '--content (requires --section), --turn N, --request N.',
  '`request capture on|off` opts into persisting sensitive future request text;',
  'turning capture off does not delete earlier captures. Text readouts escape terminal controls.',
  'List relationship records with decayed affinity (`relationships`, alias `rel`),',
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
    recap: { description: 'Show recap state, force the next roll, or run recap now', args: ['show', 'force', 'now'] },
    summary: { description: 'Show full sensitive local recap text without model work' },
    timeline: { description: 'Show capped timeline preview or all local text', args: ['--all'] },
    facts: { description: 'Show active-scene fact metadata or sensitive content', args: ['--content'] },
    budget: { description: 'Show or set the soft full-input token target', args: ['set', 'off'] },
    opener: { description: 'Show opener metadata or set scene-local pinning', args: ['show', 'pin', 'unpin'] },
    jobs: { description: 'Show safe extraction status or explicitly run queued model work', args: ['retry', 'drain'] },
    request: {
      description: 'Inspect the last sanitized request; metadata only by default',
      args: [...REQUEST_FLAGS, 'capture'],
    },
    debug: { description: 'Inspect safe request, policy and queue diagnostics', args: [...REQUEST_FLAGS] },
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

/** Complete nested positions via the shared helper, preserving the ENTIRE argument prefix. */
export function completeRoleplayArguments(
  prefix: string,
  listCasts: () => readonly string[],
  listCharacters: () => readonly string[] = () => [],
): CompletionItem[] | null {
  const parts = prefix.split(/\s+/);
  if (parts.length <= 2) return completeSubverbs(prefix, roleplaySubverbs(listCasts, listCharacters));
  const [verb, command] = parts;
  const preceding = parts.slice(0, -1);
  const tail = parts.at(-1) ?? '';
  let candidates: string[];
  if (verb === 'jobs' && command === 'retry' && parts.length === 3) candidates = ['facts', 'timeline', 'all'];
  else if (verb === 'opener' && command === 'pin' && parts.length === 3) candidates = ['reply'];
  else if (verb === 'request' && command === 'capture' && parts.length === 3) candidates = ['on', 'off'];
  else if (verb === 'request' || verb === 'debug') {
    if (command === 'capture') return null;
    const previous = preceding.at(-1);
    if (previous === '--section') candidates = REQUEST_SECTIONS;
    else if (previous === '--turn' || previous === '--request') return null;
    else candidates = REQUEST_FLAGS;
  } else return null;
  // A synthetic verb lets completeSubverbs own matching and replacement semantics at every depth.
  const matched = completeSubverbs(`arg ${tail}`, { arg: { args: candidates } });
  return (
    matched?.map((item) => Object.assign({}, item, { value: `${preceding.join(' ')} ${item.value.slice(4)}` })) ?? null
  );
}
