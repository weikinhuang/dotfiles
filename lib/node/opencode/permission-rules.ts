/**
 * Helpers for opencode v2 permission rule lists.
 *
 * Pure module: no `@opencode/*` imports.
 */

/** Structural slice of opencode `Permission.Rule`. */
export interface PermissionRuleLike {
  action: string;
  resource: string;
  effect: string;
}

/**
 * Where to insert `{ action, resource: '*', effect: 'ask' }` into an agent's
 * rules, or `undefined` when it is already there.
 *
 * opencode's base policy starts with `* * allow`, so a custom plugin action is
 * allowed unless something asks. The rule goes right after that leading
 * wildcard and before every configured rule, so user `allow` / `deny` rules for
 * the action (and saved "Allow always" approvals, which are evaluated last)
 * still win, and agents that later deny everything (explore, title) still deny.
 */
export function defaultAskRuleIndex(rules: readonly PermissionRuleLike[], action: string): number | undefined {
  const base = rules.findIndex((r) => r.action === '*' && r.resource === '*' && r.effect === 'allow');
  const at = base === -1 ? 0 : base + 1;
  const existing = rules[at];
  if (existing?.action === action && existing.resource === '*' && existing.effect === 'ask') return undefined;
  return at;
}
