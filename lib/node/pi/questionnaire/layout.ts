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

export interface WrapWithPrefixOptions {
  /** ANSI-styled content to wrap. */
  content: string;
  /** Total line width (prefix included). */
  width: number;
  /** Prefix prepended to the first wrapped line (may carry ANSI). */
  firstPrefix: string;
  /** Prefix prepended to continuation lines (may carry ANSI). */
  contPrefix?: string;
  /** Word-wrap function (ANSI-aware), injected by the caller. */
  wrap: (text: string, width: number) => string[];
  visibleWidth?: VisibleWidth;
}

/**
 * Word-wrap ANSI-styled `content` to `width`, prepending `firstPrefix` to the
 * first line and `contPrefix` (default: spaces matching the first prefix's
 * visible width) to every continuation line. The inner wrap width reserves
 * room for the widest prefix so no composed line exceeds `width`.
 */
export function wrapWithPrefix(opts: WrapWithPrefixOptions): string[] {
  const visible = opts.visibleWidth ?? ((x) => x.length);
  const firstW = visible(opts.firstPrefix);
  const contPrefix = opts.contPrefix ?? ' '.repeat(firstW);
  const contW = visible(contPrefix);
  const inner = Math.max(1, opts.width - Math.max(firstW, contW));
  const wrapped = opts.wrap(opts.content, inner);
  return wrapped.map((line, i) => (i === 0 ? opts.firstPrefix : contPrefix) + line);
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
