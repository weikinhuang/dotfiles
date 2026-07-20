/**
 * Pure data helpers for the questionnaire extension.
 *
 * The extension owns the pi/TUI event loop; this module owns the stable
 * question and answer shapes plus defaulting logic that does not depend
 * on pi runtime packages.
 */

export type QuestionKind = 'single' | 'multi' | 'free';

export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export type RenderOption = QuestionOption & {
  isOther?: boolean;
  isNext?: boolean;
};

export interface Question {
  id: string;
  label: string;
  prompt: string;
  kind: QuestionKind;
  options: QuestionOption[];
  allowOther: boolean;
  allowNotes: boolean;
  minSelect?: number;
  maxSelect?: number;
}

export interface Answer {
  id: string;
  kind: QuestionKind;
  // single
  value?: string;
  label?: string;
  index?: number;
  // multi
  values?: string[];
  labels?: string[];
  indices?: number[];
  // free / "Type something." overflow
  customText?: string;
  wasCustom?: boolean;
  // per-question note
  note?: string;
}

export interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
  chatRequested: boolean;
  chatContextId: string | null;
}

export interface QuestionnaireQuestionInput {
  id: string;
  label?: string;
  prompt: string;
  kind?: QuestionKind;
  options?: QuestionOption[];
  allowOther?: boolean;
  allowNotes?: boolean;
  minSelect?: number;
  maxSelect?: number;
}

export function normalizeQuestions(input: readonly QuestionnaireQuestionInput[]): Question[] {
  return input.map((q, i) => ({
    id: q.id,
    label: q.label?.length ? q.label : `Q${i + 1}`,
    prompt: q.prompt,
    kind: q.kind ?? 'single',
    options: q.options ?? [],
    allowOther: q.allowOther !== false,
    allowNotes: q.allowNotes !== false,
    minSelect: q.minSelect,
    maxSelect: q.maxSelect,
  }));
}

/**
 * Build the `values` / `labels` / 1-based `indices` arrays for a multi-select
 * answer from the question's options and a set of selected 0-based indices.
 * `selectedIndices` is expected pre-sorted (see `sortedSelection`); missing
 * options collapse to empty strings, matching the inline behaviour the
 * questionnaire extension shipped before the MultiSelectList extraction.
 */
export function multiAnswerFields(
  options: readonly QuestionOption[],
  selectedIndices: readonly number[],
): { values: string[]; labels: string[]; indices: number[] } {
  return {
    values: selectedIndices.map((i) => options[i]?.value ?? ''),
    labels: selectedIndices.map((i) => options[i]?.label ?? ''),
    indices: selectedIndices.map((i) => i + 1),
  };
}

export function questionRenderOptions(q: Pick<Question, 'kind' | 'options' | 'allowOther'>): RenderOption[] {
  if (q.kind === 'free') return [];
  const opts: RenderOption[] = [...q.options];
  if (q.allowOther) {
    opts.push({ value: '__other__', label: 'Type something.', isOther: true });
  }
  if (q.kind === 'multi') {
    opts.push({ value: '__next__', label: 'Next', isNext: true });
  }
  return opts;
}

/**
 * Validate normalized questions for structural soundness. Returns a list of
 * human-readable error messages (empty when the set is answerable). Catches
 * inputs that would otherwise trap the user in an un-completable modal:
 * duplicate ids (answers collide in the id-keyed map), non-free questions
 * with no selectable row, and `minSelect` / `maxSelect` bounds that can never
 * be satisfied.
 */
export function validateQuestions(questions: readonly Question[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    const where = `question "${q.id}"`;
    if (seen.has(q.id)) {
      errors.push(`Duplicate question id "${q.id}" (ids must be unique).`);
    }
    seen.add(q.id);

    if (q.kind === 'free') continue;

    const selectable = q.options.length + (q.allowOther ? 1 : 0);
    if (selectable === 0) {
      errors.push(`${where} has no options and allowOther is false, so it cannot be answered.`);
    }

    if (q.kind === 'multi') {
      if (q.minSelect !== undefined && q.minSelect > q.options.length) {
        errors.push(
          `${where} minSelect (${q.minSelect}) exceeds the ${q.options.length} option(s), so Next can never enable.`,
        );
      }
      if (q.maxSelect !== undefined && q.maxSelect < 1) {
        errors.push(`${where} maxSelect (${q.maxSelect}) must be at least 1.`);
      }
      if (q.minSelect !== undefined && q.maxSelect !== undefined && q.maxSelect < q.minSelect) {
        errors.push(`${where} maxSelect (${q.maxSelect}) is less than minSelect (${q.minSelect}).`);
      }
    }
  }
  return errors;
}
