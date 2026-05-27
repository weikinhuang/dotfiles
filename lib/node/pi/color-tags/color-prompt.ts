/**
 * System-prompt addendum builder for the `color-tags` pi extension.
 *
 * Pi assembles its system prompt from a base + every extension's
 * `before_agent_start` contribution. We append a `## Inline color tags`
 * section that teaches the model:
 *
 *   - The bracket syntax (`[c:NAME]content[/c]`).
 *   - Three example shapes (named-16, hex, theme token).
 *   - That close tags are required and tags don't nest.
 *   - The full vocabulary of names available to it.
 *   - Discipline: use sparingly, never colorize whole paragraphs or
 *     tool output.
 *   - **Critical phrasing:** the addendum talks about "emitting" the
 *     tags as plain text and explicitly tells the model NOT to
 *     convert them to ANSI escape sequences itself. Without this
 *     guardrail, Claude (verified on opus-4-7) auto-converts some
 *     opens to raw `\x1b[…m` bytes from its training data. The
 *     guardrail keeps the syntax model-agnostic.
 *
 * Pure module - no pi runtime imports.
 */

import { NAMED_COLOR_NAMES } from './resolve-color.ts';

/** The heading the addendum injects under. Idempotency in `appendColorPrompt` keys off this string. */
export const COLOR_PROMPT_HEADING = '## Inline color tags';

export interface BuildColorPromptOptions {
  /**
   * Theme-color tokens the active theme exposes. Listed in the
   * vocabulary section so the model knows it can use semantic names
   * like `success` / `error` instead of raw 16-color names.
   */
  themeTokens: readonly string[];
}

/**
 * Build the markdown section that explains inline color tags. Returns
 * a string starting with the `COLOR_PROMPT_HEADING` line.
 */
export function buildColorPromptAddendum(options: BuildColorPromptOptions): string {
  const themeList = options.themeTokens.length > 0 ? options.themeTokens.join(', ') : '(none)';
  const namedList = NAMED_COLOR_NAMES.join(', ');
  return [
    COLOR_PROMPT_HEADING,
    '',
    'Wrap short inline runs of your prose in `[c:NAME]content[/c]`',
    'tags. Emit the tags as plain text - the pi runtime is the one',
    'that converts them to terminal ANSI sequences during streaming.',
    'Do NOT convert tags to escape sequences yourself; emit',
    'character-for-character what is shown below.',
    '',
    'Examples:',
    '',
    '- ``[c:red]error[/c]`` - named-16 color',
    '- ``[c:#ffaa00]warning[/c]`` - 24-bit hex',
    '- ``[c:success]ok[/c]`` - theme token',
    '',
    'Rules:',
    '',
    '- Always close with `[/c]`. An unclosed tag is left visible by',
    '  the runtime, but the close-tag is what restores the surrounding',
    '  style cleanly.',
    '- Tags do NOT nest. The first `[/c]` always closes the outermost',
    '  span.',
    '- Inline only. Do not wrap entire paragraphs, code blocks, lists,',
    '  or tool output - color is for emphasis on individual words or',
    '  short phrases.',
    '- Use sparingly. Two or three colored runs per turn is plenty.',
    '- Unknown names pass through as the literal tag, not as text -',
    '  that is how you spot a typo in the color name.',
    '- The tag syntax does not collide with markdown link syntax',
    '  (`[text](url)`) because color tags have no `(...)` after the',
    '  closing bracket.',
    '',
    'Vocabulary:',
    '',
    `- Named-16: ${namedList}.`,
    '- 256-color index: `x256-N` or `256-N` where N is 0-255.',
    '- 24-bit hex: `#RRGGBB` or `#RGB`.',
    `- Theme tokens (preferred for semantic colors): ${themeList}.`,
    '',
  ].join('\n');
}

/**
 * Append the addendum to a base system prompt. Idempotent - if the
 * heading is already present we return `base` unchanged so /reload and
 * other re-entry paths don't double-inject.
 */
export function appendColorPrompt(base: string, addendum: string): string {
  if (base.includes(COLOR_PROMPT_HEADING)) return base;
  const trimmed = base.replace(/\s+$/, '');
  if (trimmed.length === 0) return addendum;
  return `${trimmed}\n\n${addendum}`;
}
