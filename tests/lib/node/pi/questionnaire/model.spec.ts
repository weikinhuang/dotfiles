/**
 * Tests for lib/node/pi/questionnaire/model.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  initialCursorIndex,
  multiAnswerFields,
  normalizeQuestions,
  questionRenderOptions,
  validateQuestions,
  type QuestionnaireQuestionInput,
} from '../../../../../lib/node/pi/questionnaire/model.ts';

test('normalizeQuestions: applies questionnaire defaults', () => {
  const questions = normalizeQuestions([
    { id: 'scope', prompt: 'Pick scope', options: [{ value: 'small', label: 'Small' }] },
    { id: 'notes', label: 'Notes', prompt: 'Anything else?', kind: 'free', allowNotes: false },
  ]);

  expect(questions[0]).toEqual({
    id: 'scope',
    label: 'Q1',
    prompt: 'Pick scope',
    kind: 'single',
    options: [{ value: 'small', label: 'Small' }],
    allowOther: true,
    allowNotes: true,
    minSelect: undefined,
    maxSelect: undefined,
  });
  expect(questions[1]).toMatchObject({
    id: 'notes',
    label: 'Notes',
    kind: 'free',
    options: [],
    allowOther: true,
    allowNotes: false,
  });
});

test('normalizeQuestions: preserves multi-select bounds and explicit flags', () => {
  const input: QuestionnaireQuestionInput[] = [
    {
      id: 'priority',
      prompt: 'Pick priorities',
      kind: 'multi',
      options: [{ value: 'tests', label: 'Tests' }],
      allowOther: false,
      minSelect: 1,
      maxSelect: 2,
    },
  ];

  expect(normalizeQuestions(input)[0]).toMatchObject({
    kind: 'multi',
    allowOther: false,
    minSelect: 1,
    maxSelect: 2,
  });
});

test('questionRenderOptions: adds Other for selectable questions', () => {
  const opts = questionRenderOptions({
    kind: 'single',
    options: [{ value: 'a', label: 'A' }],
    allowOther: true,
  });

  expect(opts).toEqual([
    { value: 'a', label: 'A' },
    { value: '__other__', label: 'Type something.', isOther: true },
  ]);
});

test('questionRenderOptions: adds Next after multi-select options', () => {
  const opts = questionRenderOptions({
    kind: 'multi',
    options: [{ value: 'a', label: 'A' }],
    allowOther: false,
  });

  expect(opts).toEqual([
    { value: 'a', label: 'A' },
    { value: '__next__', label: 'Next', isNext: true },
  ]);
});

test('questionRenderOptions: free-text questions have no option rows', () => {
  expect(questionRenderOptions({ kind: 'free', options: [{ value: 'a', label: 'A' }], allowOther: true })).toEqual([]);
});

test('multiAnswerFields: maps sorted indices to values/labels/1-based indices', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
    { value: 'c', label: 'C' },
  ];

  expect(multiAnswerFields(options, [0, 2])).toEqual({
    values: ['a', 'c'],
    labels: ['A', 'C'],
    indices: [1, 3],
  });
});

test('multiAnswerFields: missing options collapse to empty strings', () => {
  expect(multiAnswerFields([{ value: 'a', label: 'A' }], [0, 5])).toEqual({
    values: ['a', ''],
    labels: ['A', ''],
    indices: [1, 6],
  });
});

test('multiAnswerFields: empty selection yields empty arrays', () => {
  expect(multiAnswerFields([{ value: 'a', label: 'A' }], [])).toEqual({
    values: [],
    labels: [],
    indices: [],
  });
});

test('validateQuestions: passes a well-formed question set', () => {
  const questions = normalizeQuestions([
    { id: 'scope', prompt: 'Pick', options: [{ value: 'a', label: 'A' }] },
    { id: 'notes', prompt: 'Notes', kind: 'free' },
    { id: 'tags', prompt: 'Tags', kind: 'multi', options: [{ value: 'x', label: 'X' }], minSelect: 1, maxSelect: 1 },
  ]);
  expect(validateQuestions(questions)).toEqual([]);
});

test('validateQuestions: flags duplicate ids', () => {
  const questions = normalizeQuestions([
    { id: 'dup', prompt: 'One', options: [{ value: 'a', label: 'A' }] },
    { id: 'dup', prompt: 'Two', options: [{ value: 'b', label: 'B' }] },
  ]);
  expect(validateQuestions(questions)).toEqual(['Duplicate question id "dup" (ids must be unique).']);
});

test('validateQuestions: flags a non-free question with no selectable row', () => {
  const questions = normalizeQuestions([{ id: 'x', prompt: 'Q', kind: 'single', options: [], allowOther: false }]);
  expect(validateQuestions(questions)).toEqual([
    'question "x" has no options and allowOther is false, so it cannot be answered.',
  ]);
});

test('validateQuestions: allowOther keeps an option-less question answerable', () => {
  const questions = normalizeQuestions([{ id: 'x', prompt: 'Q', kind: 'single', options: [] }]);
  expect(validateQuestions(questions)).toEqual([]);
});

test('validateQuestions: flags multi bounds that can never be satisfied', () => {
  const questions = normalizeQuestions([
    { id: 'a', prompt: 'Q', kind: 'multi', options: [{ value: 'o', label: 'O' }], minSelect: 3 },
    { id: 'b', prompt: 'Q', kind: 'multi', options: [{ value: 'o', label: 'O' }], maxSelect: 0 },
    {
      id: 'c',
      prompt: 'Q',
      kind: 'multi',
      options: [
        { value: 'o', label: 'O' },
        { value: 'p', label: 'P' },
      ],
      minSelect: 2,
      maxSelect: 1,
    },
  ]);
  expect(validateQuestions(questions)).toEqual([
    'question "a" minSelect (3) exceeds the 1 option(s), so Next can never enable.',
    'question "b" maxSelect (0) must be at least 1.',
    'question "c" maxSelect (1) is less than minSelect (2).',
  ]);
});

test('validateQuestions: accepts valid defaults across kinds', () => {
  const questions = normalizeQuestions([
    { id: 's', prompt: 'Q', kind: 'single', options: [{ value: 'a', label: 'A' }], default: 'a' },
    {
      id: 'm',
      prompt: 'Q',
      kind: 'multi',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      default: ['a', 'b'],
    },
    { id: 'f', prompt: 'Q', kind: 'free', default: 'hello' },
  ]);
  expect(validateQuestions(questions)).toEqual([]);
});

test('validateQuestions: flags defaults that do not match options or exceed bounds', () => {
  const questions = normalizeQuestions([
    { id: 's', prompt: 'Q', kind: 'single', options: [{ value: 'a', label: 'A' }], default: 'zzz' },
    {
      id: 'm',
      prompt: 'Q',
      kind: 'multi',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      default: ['a', 'b'],
      maxSelect: 1,
    },
  ]);
  expect(validateQuestions(questions)).toEqual([
    'question "s" default "zzz" does not match any option value.',
    'question "m" default selects 2 option(s), exceeding maxSelect (1).',
  ]);
});

test('initialCursorIndex: lands on a matching single-select default, else the top', () => {
  const [single] = normalizeQuestions([
    {
      id: 's',
      prompt: 'Q',
      kind: 'single',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ],
      default: 'c',
    },
  ]);
  expect(initialCursorIndex(single)).toBe(2);

  const [noDefault] = normalizeQuestions([
    { id: 's', prompt: 'Q', kind: 'single', options: [{ value: 'a', label: 'A' }] },
  ]);
  expect(initialCursorIndex(noDefault)).toBe(0);

  const [multi] = normalizeQuestions([
    { id: 'm', prompt: 'Q', kind: 'multi', options: [{ value: 'a', label: 'A' }], default: ['a'] },
  ]);
  expect(initialCursorIndex(multi)).toBe(0);
});
