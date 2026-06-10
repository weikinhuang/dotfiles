/**
 * Shared prompt builders for avatar sprite generation.
 *
 * Sheet-level prompts (grid layouts) and per-cell prompts (single images) both
 * render from sprite-manifest.ts via this module so hosted and local backends
 * stay aligned.
 */

import { BORDER, CHROMA, GRID, STYLE, frameDescriptions, type Sheet } from './sprite-manifest.ts';

/**
 * Content guard appended to prompts for suggestive / mature groups.
 * Keeps them tasteful and within image-UI policy: expression-driven, fully
 * clothed, head-and-shoulders only - no nudity, suggestive posing, or explicit
 * content. Shared by `sultry` and the opt-in `mature` overlay groups.
 */
export const SFW_GUARD =
  'Keep every cell strictly safe-for-work and tasteful: head-and-shoulders only, fully clothed in the same outfit, expression- and gaze-driven only. No nudity, no suggestive or revealing posing, no explicit or sexual content - just facial expression, flush, and a hint of body language.';

export const GROUP_GUARDS: Record<string, string> = {
  sultry: SFW_GUARD,
  desire: SFW_GUARD,
  intensity: SFW_GUARD,
  intimacy: SFW_GUARD,
};

/**
 * Reference clause for prompts generated against an approved "hero" bust
 * (the single canonical pixel-art reference, saved as avatar-ref/canonical.png,
 * that every other expression and frame must match). Used by the hosted grid /
 * cell prompts - where you upload the hero alongside the prompt - and by local
 * edit-role workflows, where gen-comfyui injects the hero as the source image.
 */
export const HERO_CLAUSE =
  'Match the attached hero reference image EXACTLY for the character design, pixel-art style, line weight, shading, and color palette, and keep the same head-and-shoulders bust crop, size, and framing; change ONLY the expression or pose noted.';

/** One per-cell prompt entry for JSON export. */
export interface CellPromptEntry {
  group: string;
  state: string;
  frame: number;
  prompt: string;
}

/** Options shared by the per-cell prompt builders. */
export interface CellPromptOptions {
  /**
   * Append {@link HERO_CLAUSE}: the prompt is generated against the attached /
   * injected hero reference (hosted prompts and local edit-role workflows).
   */
  reference?: boolean;
}

/**
 * Normalize a raw identity blurb for the `Character: ${identity}.` line: trim
 * whitespace and drop a single trailing period so the rendered sentence never
 * doubles up (`...outfit..`). Applied by the CLI entrypoints before building.
 */
export function normalizeIdentity(identity: string): string {
  return identity.trim().replace(/\.$/, '');
}

/**
 * Prompt for the one canonical "hero" bust that every other sprite is matched
 * against. This is the bootstrap step: render your character reference art into
 * the target pixel-art style, then approve a single result as
 * avatar-ref/canonical.png. (Unlike the expression prompts, you attach the
 * original character art here, not the hero.)
 */
export function heroPrompt(identity: string): string {
  return [
    `Style: ${STYLE}.`,
    '',
    `Character: ${identity}.`,
    '',
    `A single head-and-shoulders bust: front-facing, neutral friendly expression, looking at the viewer, ` +
      `centered on a solid, flat chroma-key green-screen background (${CHROMA}, vivid fully-saturated pure green, ` +
      `no gradient, no scenery, nothing but green behind the character). This is the canonical reference image that every ` +
      `other expression and animation frame will be matched against, so keep it clean, well-lit, and on-model. ` +
      `Match the attached character reference art for hair, eyes, halo, and outfit, rendered in the pixel-art style above. ` +
      `No text, labels, borders, drop shadows, or extra panels.`,
  ].join('\n');
}

/**
 * Full-body variant of {@link STYLE}: the identical render style, but framed head
 * to toe instead of head-and-shoulders. Used by the full-body reference prompts.
 */
const FULL_BODY_STYLE = STYLE.replace(
  'bust framing (head and shoulders)',
  'full-body framing (head to toe, the entire figure visible)',
);

/** Shared turnaround / model-sheet body for a given framing noun. */
function turnaroundBody(framing: string): string {
  return (
    `A character turnaround / model sheet: the SAME ${framing} shown from four angles in one row, evenly ` +
    `spaced, all at the exact same size, eye-line, and scale: (1) front view, (2) three-quarter view facing ` +
    `left, (3) three-quarter view facing right, (4) side profile. Neutral friendly expression and a relaxed, ` +
    `natural stance in every view. Keep the character perfectly consistent across all four - identical hair, ` +
    `halo position, outfit details, and color palette. Flat plain light-gray background, even lighting. ` +
    `Match the attached character reference art for hair, eyes, halo, and outfit, rendered in the pixel-art ` +
    `style above. No text, labels, numbers, arrows, borders, drop shadows, or extra panels.`
  );
}

/**
 * Bust turnaround / model sheet: the same head-and-shoulders bust from four angles
 * on a plain neutral background. Optional pre-hero reference - generate it from the
 * original character art, then attach it (alongside the hero) when generating
 * sheets so head-turned expressions stay on-model. Reference material, never
 * sliced, so it uses a neutral background, NOT the green chroma key.
 */
export function turnaroundPrompt(identity: string): string {
  return [`Style: ${STYLE}.`, '', `Character: ${identity}.`, '', turnaroundBody('head-and-shoulders bust')].join('\n');
}

/**
 * Single full-body figure on a plain neutral background: a head-to-toe reference
 * for the character's complete outfit and proportions. Reference material, not
 * sliced.
 */
export function fullBodyPrompt(identity: string): string {
  return [
    `Style: ${FULL_BODY_STYLE}.`,
    '',
    `Character: ${identity}.`,
    '',
    `A single full-body figure shown head to toe with the entire figure visible: front-facing, neutral friendly ` +
      `expression, relaxed natural standing pose, looking at the viewer, centered on a flat plain light-gray ` +
      `background. Keep it clean, well-lit, and on-model. Match the attached character reference art for hair, ` +
      `eyes, halo, and outfit, rendered in the pixel-art style above. No text, labels, borders, drop shadows, or ` +
      `extra panels.`,
  ].join('\n');
}

/**
 * Full-body turnaround / model sheet: the full head-to-toe figure from four angles
 * on a plain neutral background. The most complete identity reference. Not sliced.
 */
export function fullBodyTurnaroundPrompt(identity: string): string {
  return [`Style: ${FULL_BODY_STYLE}.`, '', `Character: ${identity}.`, '', turnaroundBody('full-body figure')].join(
    '\n',
  );
}

/** The reference artifacts the generator scripts can produce from character art. */
export type ReferenceKind = 'hero' | 'turnaround' | 'full-body' | 'full-body-turnaround';

/** Dispatch to the reference prompt for `kind`; shared by both generator scripts. */
export function referencePrompt(kind: ReferenceKind, identity: string): string {
  switch (kind) {
    case 'hero':
      return heroPrompt(identity);
    case 'turnaround':
      return turnaroundPrompt(identity);
    case 'full-body':
      return fullBodyPrompt(identity);
    case 'full-body-turnaround':
      return fullBodyTurnaroundPrompt(identity);
  }
}

export function sheetRules(groupName: string): string {
  const cells = GRID.cols * GRID.rows;
  const guard = GROUP_GUARDS[groupName];
  return (
    `Arrange exactly ${cells} sprites in a strict, evenly spaced ${GRID.cols}x${GRID.rows} grid, read left-to-right then top-to-bottom, ` +
    `on a single solid, flat chroma-key green-screen background (${CHROMA}, vivid fully-saturated pure green, no gradient or scenery). ` +
    `Outline every cell with a thin 1px solid bright cyan (${BORDER}) rectangular border - flat and fully saturated, no gradient or glow. Make all borders the exact same size and evenly spaced, with green gutters between them. ` +
    `Draw one sprite inside each border box at the EXACT same size and position in every cell: head near the top inner edge, centered horizontally, the same bust crop. Leave a clear band of plain green between the character and the cyan border on all sides - nothing should touch or cross the border. ` +
    'The borders are alignment guides only (they get removed). No text, labels, numbers, drop shadows, or extra panel lines.' +
    (guard === undefined ? '' : ` ${guard}`)
  );
}

export function buildPrompt(groupName: string, sheet: Sheet): string {
  const lines: string[] = [];
  lines.push(`# ${groupName} - sheet ${sheet.name}`);
  lines.push('');
  lines.push(`Style: ${STYLE}.`);
  lines.push('');
  lines.push('Character: {identity}.');
  lines.push('');
  lines.push(sheetRules(groupName));
  lines.push('');
  lines.push('Cells (one expression each):');
  sheet.cells.forEach((cell, i) => {
    if (cell === null) {
      lines.push(`  ${i + 1}. (leave blank - background only)`);
    } else if (cell.frame === 0) {
      lines.push(`  ${i + 1}. ${cell.state}: ${cell.desc}`);
    } else {
      lines.push(`  ${i + 1}. ${cell.state} [frame ${cell.frame + 1}]: ${cell.desc}`);
    }
  });
  lines.push('');
  lines.push(HERO_CLAUSE);
  return lines.join('\n');
}

/**
 * Build one prompt for a single (state, frame) cell: STYLE + identity + the
 * per-frame description from `frameDescriptions` + the hero-reference clause
 * (when `reference`) + the group's SFW guard when applicable.
 */
export function cellPrompt(
  groupName: string,
  state: string,
  frame: number,
  identity: string,
  options: CellPromptOptions = {},
): string {
  const desc = frameDescriptions(groupName, state).at(frame);
  if (desc === undefined) {
    throw new Error(`Unknown frame ${frame} for state "${state}" in group "${groupName}"`);
  }
  const guard = GROUP_GUARDS[groupName];
  const lines: string[] = [];
  lines.push(`Style: ${STYLE}.`);
  lines.push('');
  lines.push(`Character: ${identity}.`);
  lines.push('');
  if (frame === 0) {
    lines.push(`Expression: ${state}: ${desc}`);
  } else {
    lines.push(`Expression: ${state} [frame ${frame + 1}]: ${desc}`);
  }
  if (options.reference === true) {
    lines.push('');
    lines.push(HERO_CLAUSE);
  }
  if (guard !== undefined) {
    lines.push('');
    lines.push(guard);
  }
  return lines.join('\n');
}
