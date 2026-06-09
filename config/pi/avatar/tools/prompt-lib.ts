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

/** One per-cell prompt entry for JSON export. */
export interface CellPromptEntry {
  group: string;
  state: string;
  frame: number;
  prompt: string;
}

export function sheetRules(groupName: string): string {
  const cells = GRID.cols * GRID.rows;
  const guard = GROUP_GUARDS[groupName];
  return (
    `Arrange exactly ${cells} sprites in a strict, evenly spaced ${GRID.cols}x${GRID.rows} grid, read left-to-right then top-to-bottom, ` +
    `on a single flat ${CHROMA} (pure green) background. ` +
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
  if (sheet.name !== 'a') {
    lines.push('');
    lines.push(
      'Keep the identical character, style, palette, framing, and grid layout as the base sheet (a); only apply the per-cell change noted.',
    );
  }
  return lines.join('\n');
}

/**
 * Build one prompt for a single (state, frame) cell: STYLE + identity + the
 * per-frame description from `frameDescriptions` + the group's SFW guard when
 * applicable.
 */
export function cellPrompt(groupName: string, state: string, frame: number, identity: string): string {
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
  if (guard !== undefined) {
    lines.push('');
    lines.push(guard);
  }
  return lines.join('\n');
}
