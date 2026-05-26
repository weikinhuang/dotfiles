/**
 * Pure layout math for the questionnaire extension.
 *
 * The extension supplies terminal-aware width functions and applies theme
 * colours; this module only decides dimensions and joins plain rows.
 */

export const QUESTIONNAIRE_PREVIEW_MIN_WIDTH = 100;
export const QUESTIONNAIRE_PREVIEW_LEFT_RATIO = 0.4;
export const QUESTIONNAIRE_PREVIEW_GUTTER = 2;

type VisibleWidth = (s: string) => number;

export interface QuestionnairePreviewLayoutOptions {
  width: number;
  preview?: string;
  minWidth?: number;
  leftRatio?: number;
  gutter?: number;
}

export type QuestionnairePreviewLayout =
  | { mode: 'none' }
  | { mode: 'split'; leftWidth: number; rightWidth: number; gutter: number }
  | { mode: 'stacked'; previewHeight: number; previewWidth: number };

export function padVisibleText(s: string, width: number, visibleWidth: VisibleWidth = (x) => x.length): string {
  const w = visibleWidth(s);
  if (w >= width) return s;
  return s + ' '.repeat(width - w);
}

export function zipQuestionnaireColumns(args: {
  left: readonly string[];
  right: readonly string[];
  leftWidth: number;
  gutter: number;
  visibleWidth?: VisibleWidth;
}): string[] {
  const height = Math.max(args.left.length, args.right.length);
  const out: string[] = [];
  const pad = ' '.repeat(args.gutter);
  for (let i = 0; i < height; i++) {
    const l = args.left[i] ?? '';
    const r = args.right[i] ?? '';
    out.push(padVisibleText(l, args.leftWidth, args.visibleWidth) + pad + r);
  }
  return out;
}

export function selectQuestionnairePreviewLayout(opts: QuestionnairePreviewLayoutOptions): QuestionnairePreviewLayout {
  if (!opts.preview) return { mode: 'none' };
  const minWidth = opts.minWidth ?? QUESTIONNAIRE_PREVIEW_MIN_WIDTH;
  const leftRatio = opts.leftRatio ?? QUESTIONNAIRE_PREVIEW_LEFT_RATIO;
  const gutter = opts.gutter ?? QUESTIONNAIRE_PREVIEW_GUTTER;
  if (opts.width >= minWidth) {
    const leftWidth = Math.max(30, Math.floor(opts.width * leftRatio));
    return { mode: 'split', leftWidth, rightWidth: opts.width - leftWidth - gutter, gutter };
  }
  return {
    mode: 'stacked',
    previewHeight: Math.min(12, opts.preview.split('\n').length + 2),
    previewWidth: Math.min(opts.width, 80),
  };
}
