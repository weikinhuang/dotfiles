/**
 * Inline `[emote:NAME]` marker parsing + system-prompt addendum for the
 * `avatar` extension.
 *
 * The model emits a self-closing `[emote:happy]` marker inline in its
 * prose to drive the avatar's emotion overlay (no tool call). This
 * module strips the markers out of the visible text and reports which
 * emotions were named, mirroring the `color-tags` rewrite/scrub model:
 *
 *   - `message_update` calls {@link parseEmoteMarkers} to strip markers
 *     from the live render and switch the avatar to the last-named
 *     emotion.
 *   - `context` calls {@link stripEmoteMarkers} to scrub markers from
 *     history so the model never sees (and starts echoing) its own
 *     past markers.
 *   - `before_agent_start` injects {@link buildEmotePromptAddendum} so
 *     the model knows the available emotion vocabulary.
 *
 * Pure module - no pi runtime imports.
 */

/**
 * Match a complete `[emote:NAME]` marker. NAME starts with an
 * alphanumeric and may then contain `-`/`_`. Case-insensitive; partial
 * markers (`[emote:ha` mid-stream) deliberately do NOT match, so they
 * stay visible for one frame and get stripped once the stream completes
 * them - same trade-off the color-tags rewriter makes.
 */
const EMOTE_MARKER = /\[emote:\s*([a-z0-9][a-z0-9_-]*)\]/gi;

/** The heading the prompt addendum injects under (keys idempotency). */
export const EMOTE_PROMPT_HEADING = '## Avatar emotes';

export interface ParsedEmotes {
  /** Input text with every complete `[emote:NAME]` marker removed. */
  text: string;
  /** Lowercased emotion names, in the order they appeared. */
  emotes: string[];
}

/**
 * Strip every complete `[emote:NAME]` marker from `input` and return
 * the cleaned text plus the ordered list of lowercased names found.
 * `input` is not mutated.
 */
export function parseEmoteMarkers(input: string): ParsedEmotes {
  if (input.length === 0) return { text: input, emotes: [] };
  const emotes: string[] = [];
  const text = input.replace(EMOTE_MARKER, (_match, name: string) => {
    emotes.push(name.toLowerCase());
    return '';
  });
  return { text, emotes };
}

/** Remove every complete `[emote:NAME]` marker from `input`. */
export function stripEmoteMarkers(input: string): string {
  if (input.length === 0) return input;
  return input.replace(EMOTE_MARKER, '');
}

/**
 * Build the markdown system-prompt section that teaches the model the
 * `[emote:NAME]` syntax and lists the available emotion names. Returns
 * a string starting with {@link EMOTE_PROMPT_HEADING}.
 */
export function buildEmotePromptAddendum(options: { emotions: readonly string[] }): string {
  const list = options.emotions.length > 0 ? options.emotions.join(', ') : '(none available in the active set)';
  return [
    EMOTE_PROMPT_HEADING,
    '',
    'A small avatar widget mirrors what you are doing. You can set its',
    'facial expression by emitting a self-closing `[emote:NAME]` marker',
    'inline in your reply - emit it as plain text, exactly as shown. The',
    'runtime strips the marker from your visible message, so it never',
    'appears to the user; it only drives the avatar.',
    '',
    'Examples:',
    '',
    '- `[emote:happy]` then keep writing - the avatar smiles.',
    '- `[emote:surprised]` - the avatar reacts with surprise.',
    '',
    'Rules:',
    '',
    '- The marker is self-closing; there is no `[/emote]`.',
    '- Use it for roleplay / tone, sparingly - one or two per reply.',
    '- The expression holds briefly, then the avatar returns to',
    '  reflecting your activity (thinking, typing, tool use).',
    '- Unknown names are ignored (the marker is still hidden).',
    '',
    `Available emotions: ${list}.`,
    '',
  ].join('\n');
}

/**
 * Append `addendum` to `base`. Idempotent on {@link EMOTE_PROMPT_HEADING}
 * so `/reload` and other re-entry paths don't double-inject.
 */
export function appendEmotePrompt(base: string, addendum: string): string {
  if (base.includes(EMOTE_PROMPT_HEADING)) return base;
  const trimmed = base.replace(/\s+$/, '');
  if (trimmed.length === 0) return addendum;
  return `${trimmed}\n\n${addendum}`;
}
