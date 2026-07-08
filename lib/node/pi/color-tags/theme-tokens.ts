/**
 * Theme-token vocabulary + theme-aware color resolver for the
 * `color-tags` extension.
 *
 * {@link THEME_COLOR_TOKENS} is a hardcoded mirror of the `ThemeColor`
 * union exported by `@earendil-works/pi-coding-agent`. That type is
 * type-only at runtime so it can't be iterated - keep this list in
 * lockstep with the upstream `.d.ts` manually. Kept here as a plain
 * `string[]` so the module stays pure (no pi import); the extension
 * shell casts entries to `ThemeColor` at its `theme.getFgAnsi(...)`
 * call.
 *
 * The list is used both to advertise theme-token names in the
 * system-prompt addendum and to route bracket-tag names to the theme's
 * foreground resolver instead of the pure named-16 / 256 / hex
 * resolver.
 */

import { type ColorResolver } from './parse-color-tags.ts';
import { CLOSE_FG, resolveColor } from './resolve-color.ts';

export const THEME_COLOR_TOKENS: readonly string[] = [
  'accent',
  'border',
  'borderAccent',
  'borderMuted',
  'success',
  'error',
  'warning',
  'muted',
  'dim',
  'text',
  // 'thinkingText',
  // 'userMessageText',
  // 'customMessageText',
  // 'customMessageLabel',
  // 'toolTitle',
  // 'toolOutput',
  // 'mdHeading',
  // 'mdLink',
  // 'mdLinkUrl',
  // 'mdCode',
  // 'mdCodeBlock',
  // 'mdCodeBlockBorder',
  // 'mdQuote',
  // 'mdQuoteBorder',
  // 'mdHr',
  // 'mdListBullet',
  // 'toolDiffAdded',
  // 'toolDiffRemoved',
  // 'toolDiffContext',
  // 'syntaxComment',
  // 'syntaxKeyword',
  // 'syntaxFunction',
  // 'syntaxVariable',
  // 'syntaxString',
  // 'syntaxNumber',
  // 'syntaxType',
  // 'syntaxOperator',
  // 'syntaxPunctuation',
  // 'thinkingOff',
  // 'thinkingMinimal',
  // 'thinkingLow',
  // 'thinkingMedium',
  // 'thinkingHigh',
  // 'thinkingXhigh',
  // 'bashMode',
];

export const THEME_COLOR_SET: ReadonlySet<string> = new Set(THEME_COLOR_TOKENS);

/**
 * Build a {@link ColorResolver} bound to a theme's foreground lookup.
 * Theme tokens take priority over the pure named/256/hex resolver so a
 * theme-defined `accent` isn't shadowed by an unrelated 16-color name
 * in some future expansion of the named set. `getThemeFgAnsi` is the
 * theme's foreground-ANSI accessor (the shell passes
 * `(t) => theme.getFgAnsi(t as ThemeColor)`); it is only called with a
 * name already known to be in {@link THEME_COLOR_SET}.
 */
export function buildColorResolver(getThemeFgAnsi: (token: string) => string): ColorResolver {
  return (rawName) => {
    const name = rawName.trim();
    if (name.length === 0) return undefined;
    if (THEME_COLOR_SET.has(name)) {
      return { open: getThemeFgAnsi(name), close: CLOSE_FG };
    }
    return resolveColor(name);
  };
}
