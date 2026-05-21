/**
 * Overlay header/mid-rule renderer shared by the `/bg-bash`, `/agents`,
 * and `/todos` overlays. Produces `─── Title ───…─── Chip ───`, where
 * the title is accent-themed, the dashes are borderMuted, and the chip
 * (if present) is muted. When `chip` is undefined the rule falls back to
 * the simpler `─── Title ───…` shape (used for empty-state overlays so
 * nothing reads "0/0").
 *
 * Pi-free: the helper accepts a structural {@link RuleTheme} slice
 * declared locally so the lib stays free of the pi runtime's `Theme`
 * type. Call sites pass their `theme` straight through - the runtime
 * type is structurally assignable.
 */

/**
 * Structural slice of the pi runtime `Theme` type - just the `fg` color
 * roles `formatHeaderRule` consumes. Declared locally so this module
 * stays pi-free.
 */
export interface RuleTheme {
  fg(role: 'borderMuted' | 'accent' | 'muted', text: string): string;
}

export function formatHeaderRule(title: string, chip: string | undefined, width: number, theme: RuleTheme): string {
  const lead = '─'.repeat(3);
  const titleSegment = ` ${title} `;
  if (!chip) {
    const fill = '─'.repeat(Math.max(0, width - lead.length - titleSegment.length));
    return theme.fg('borderMuted', lead) + theme.fg('accent', titleSegment) + theme.fg('borderMuted', fill);
  }
  const chipSegment = ` ${chip} `;
  const trail = '─'.repeat(3);
  const middle = '─'.repeat(Math.max(1, width - lead.length - titleSegment.length - chipSegment.length - trail.length));
  return (
    theme.fg('borderMuted', lead) +
    theme.fg('accent', titleSegment) +
    theme.fg('borderMuted', middle) +
    theme.fg('muted', chipSegment) +
    theme.fg('borderMuted', trail)
  );
}
