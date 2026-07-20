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

export interface TabWindowInput {
  /** Visible width of each tab segment (separators included). */
  widths: readonly number[];
  /** Index of the tab that must stay visible. */
  active: number;
  /** Width available for segments (chrome/markers already subtracted). */
  avail: number;
}

export interface TabWindow {
  /** First visible segment index (inclusive). */
  start: number;
  /** One past the last visible segment index (exclusive). */
  end: number;
  /** Segments hidden left of the window (== start). */
  hiddenLeft: number;
  /** Segments hidden right of the window (== widths.length - end). */
  hiddenRight: number;
}

/**
 * Compute a contiguous window of variable-width tab segments that fits within
 * `avail` and always includes `active`. Grows the window right-then-left from
 * the active tab. When every segment fits, the full range is returned with no
 * hidden tabs; a single tab wider than `avail` is still shown alone (the
 * caller truncates it).
 */
export function windowTabSegments(input: TabWindowInput): TabWindow {
  const n = input.widths.length;
  if (n === 0) return { start: 0, end: 0, hiddenLeft: 0, hiddenRight: 0 };
  const active = Math.max(0, Math.min(n - 1, Math.floor(input.active)));
  const avail = Math.max(0, Math.floor(input.avail));

  const total = input.widths.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (total <= avail) return { start: 0, end: n, hiddenLeft: 0, hiddenRight: 0 };

  let start = active;
  let end = active + 1;
  let used = Math.max(0, input.widths[active] ?? 0);
  let grew = true;
  while (grew) {
    grew = false;
    if (end < n && used + Math.max(0, input.widths[end] ?? 0) <= avail) {
      used += Math.max(0, input.widths[end] ?? 0);
      end++;
      grew = true;
    }
    if (start > 0 && used + Math.max(0, input.widths[start - 1] ?? 0) <= avail) {
      start--;
      used += Math.max(0, input.widths[start - 1] ?? 0);
      grew = true;
    }
  }
  return { start, end, hiddenLeft: start, hiddenRight: n - end };
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
