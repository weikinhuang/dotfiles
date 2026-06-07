/**
 * Pure helpers for sourcing an image placeholder's *description* - the
 * lossy-compressed caption that stands in for the dropped pixels (see
 * `plans/pi-agentic-context-edit-image-descriptions.md`).
 *
 * No pi imports - testable under `vitest` without the runtime. The
 * pi-coupled glue (the actual vision call via `runOneShotAgent`) lives in
 * `config/pi/extensions/context-trim.ts`; this module owns only the pure
 * SELECTION logic: which source wins, how it is capped, and how the
 * generation prompt is fished out of the message list.
 *
 * Description sources, in priority order:
 *   1. agent-supplied summary (feature 1 seam - the model that dropped
 *      the image hands over a `summary`; absent until feature 1 lands)
 *   2. generation prompt for `comfyui` / `generate_image` results
 *      ({@link extractGenerationPrompt}) - free, covers most traffic
 *   3. auto-caption (a vision pass) - last resort, run by the extension
 */

import { collapseWhitespace, truncate } from '../shared/strings.ts';
import { type LooseMessage, type LooseToolCallPart, toParts } from './target.ts';

/**
 * Tool name -> positive-prompt argument key. Both image generators in
 * this repo expose the positive prompt as `prompt`. This map is the only
 * knowledge {@link extractGenerationPrompt} carries; add a row here when
 * a new generator tool ships.
 */
export const GENERATION_TOOL_PROMPT_ARG: Readonly<Record<string, string>> = {
  comfyui: 'prompt',
  generate_image: 'prompt',
};

/**
 * Max stored-description length in characters (~150 tokens). Lossy
 * compression, not a transcript - keeps the placeholder small and the
 * caption call bounded. Applied by {@link capDescription}.
 */
export const CAPTION_MAX_CHARS = 600;

/**
 * Walk `messages`, find the assistant `toolCall` block whose id is
 * `toolCallId` and whose tool name is a known image generator, and return
 * its positive-prompt argument (trimmed). Returns `undefined` when the
 * call isn't present, isn't a generator, or carries no usable prompt.
 *
 * Pure - operates over the already-resolved `LooseMessage[]` the overlay
 * core already passes around, so no session API is needed.
 */
export function extractGenerationPrompt(messages: readonly LooseMessage[], toolCallId: string): string | undefined {
  if (!toolCallId) return undefined;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const part of toParts(m.content)) {
      if (part.type !== 'toolCall') continue;
      const call = part as LooseToolCallPart;
      if (call.id !== toolCallId) continue;
      const argKey = GENERATION_TOOL_PROMPT_ARG[call.name];
      if (!argKey) return undefined;
      const value = call.arguments?.[argKey];
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    }
  }
  return undefined;
}

/** The three candidate description strings, any of which may be absent. */
export interface DescriptionSources {
  /** Source 1: agent-supplied summary (feature 1). */
  agentSummary?: string | undefined;
  /** Source 2: generation prompt (comfyui / generate_image). */
  generationPrompt?: string | undefined;
  /** Source 3: auto-caption from a vision pass. */
  autoCaption?: string | undefined;
}

/**
 * Trim + collapse `text` and cap it at `maxChars`. Returns `undefined`
 * for an empty / whitespace-only input so callers can `??`-chain sources.
 */
export function capDescription(text: string | undefined, maxChars = CAPTION_MAX_CHARS): string | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  return truncate(collapseWhitespace(t), maxChars);
}

/**
 * Pick the description in priority order (agent summary > generation
 * prompt > auto-caption), capped to `maxChars`. Returns `undefined` when
 * every source is empty - the caller then emits a size-only placeholder.
 */
export function selectImageDescription(sources: DescriptionSources, maxChars = CAPTION_MAX_CHARS): string | undefined {
  return (
    capDescription(sources.agentSummary, maxChars) ??
    capDescription(sources.generationPrompt, maxChars) ??
    capDescription(sources.autoCaption, maxChars)
  );
}

/**
 * Whether sources 1 and 2 are both empty, so a vision auto-caption is the
 * only remaining way to get a description. The extension uses this to
 * decide whether to spend a vision call at all (it never auto-captions
 * when a free source already covered it).
 */
export function needsAutoCaption(sources: Pick<DescriptionSources, 'agentSummary' | 'generationPrompt'>): boolean {
  return capDescription(sources.agentSummary) === undefined && capDescription(sources.generationPrompt) === undefined;
}

/** File extension for an image MIME type, used when staging a temp file for the caption agent to read. */
export function imageExtForMime(mimeType: string | undefined): string {
  switch ((mimeType ?? '').toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}

/**
 * Pure caption-task prompt for the spawned vision agent. It is told to
 * `read` the staged image file and emit a single dense caption no longer
 * than `maxChars`, with no preamble - so the child's final text drops
 * straight into the placeholder.
 */
export function buildCaptionTask(imagePath: string, maxChars = CAPTION_MAX_CHARS): string {
  return [
    `Read the image file at ${imagePath} using the read tool, then describe what it depicts.`,
    `Write ONE dense factual caption of at most ${maxChars} characters covering subject, setting, notable detail, and visual style.`,
    'Output only the caption text - no preamble, no markdown, no surrounding quotes.',
  ].join('\n');
}
