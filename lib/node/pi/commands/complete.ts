/**
 * Shared helpers for slash-command argument completion.
 *
 * pi replaces the ENTIRE argument string (everything after the command
 * name) with the chosen completion's `value`. For a subverb command that
 * means a deeper-level completion's `value` must carry the full verb
 * prefix (`on <id>`), not just the bare id, or the verb is dropped from
 * the submitted line. These helpers enforce that rule centrally so no
 * call site can get it wrong: a verb's resolver returns bare candidates
 * (just the id / name / scope), and `completeSubverbs` synthesizes the
 * `value` as `<verb> <arg>`.
 *
 * The canonical hand-written model is `scheduled-prompts.ts` (`/schedules`);
 * these helpers are its split-and-branch skeleton, extracted and tested.
 *
 * Pure module -- no `@earendil-works/*` imports -- so it stays
 * unit-testable under vitest without the pi runtime.
 */

/** A completion item in pi's shape. `value` is the full line that replaces the argument string. */
export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

/**
 * A candidate argument for a subverb, as returned by a verb's resolver.
 * Only the bare token (id / name / scope) and an optional description --
 * the helper synthesizes the `<verb> <token>` `value` so the verb prefix
 * can never be dropped. `value` here overrides the matched token when the
 * display `label` differs from the literal token to complete.
 */
export interface ArgCandidate {
  label: string;
  value?: string;
  description?: string;
}

/** Resolve a verb's argument candidates given the partial token being typed. */
export type ArgResolver = (tail: string) => ArgCandidate[];

/** One verb in a subverb spec: a level-1 description plus an optional argument resolver. */
export interface VerbSpec {
  description?: string;
  /** Omit for a terminal verb (no deeper args). A `string[]` is a fixed candidate list. */
  args?: string[] | ArgResolver;
}

/** Maps each level-1 verb to its spec. */
export type SubverbSpec = Record<string, VerbSpec>;

/**
 * Complete a subverb command at every token position.
 *
 * - Level 1 (no verb chosen yet): the verbs in `spec` whose name starts
 *   with the partial token, each carrying its `description`.
 * - Level 2+ (a verb is chosen): that verb's argument candidates whose
 *   token starts with the partial tail, each with `value` set to
 *   `<verb> <token>` so the verb survives submission.
 *
 * Returns `null` (not `[]`) when nothing matches -- an unknown verb, a
 * terminal verb that takes no args, or an empty filtered list -- matching
 * the convention the extensions expect from `getArgumentCompletions`.
 */
export function completeSubverbs(prefix: string, spec: SubverbSpec): CompletionItem[] | null {
  const parts = prefix.split(/\s+/);
  const verbs = Object.keys(spec);

  if (parts.length <= 1) {
    const head = parts[0] ?? '';
    const matched = verbs
      .filter((v) => v.startsWith(head))
      .map((v) => ({ value: v, label: v, description: spec[v].description }));
    return matched.length > 0 ? matched : null;
  }

  const verb = parts[0];
  const tail = parts[parts.length - 1];
  const entry = spec[verb];
  if (!entry?.args) return null;

  const candidates: ArgCandidate[] =
    typeof entry.args === 'function' ? entry.args(tail) : entry.args.map((label) => ({ label }));
  const matched = candidates
    .filter((c) => (c.value ?? c.label).startsWith(tail))
    .map((c) => ({
      value: `${verb} ${c.value ?? c.label}`,
      label: c.label,
      description: c.description,
    }));
  return matched.length > 0 ? matched : null;
}

/**
 * Complete a positional command (no subverbs -- the whole argument is one
 * value, e.g. `/bash-allow <pattern>`, `/sandbox-allow <domain>`).
 *
 * The candidate's token IS the full submitted line, so `value` is just the
 * bare candidate and the filter matches against the WHOLE prefix (not the
 * last whitespace token) -- a positional value like `git status` must stay
 * matchable while the user is mid-phrase. Returns `null` when nothing
 * matches.
 */
export function completePositional(prefix: string, resolve: ArgResolver): CompletionItem[] | null {
  const needle = prefix.trimStart();
  const matched = resolve(needle)
    .filter((c) => (c.value ?? c.label).startsWith(needle))
    .map((c) => ({ value: c.value ?? c.label, label: c.label, description: c.description }));
  return matched.length > 0 ? matched : null;
}
