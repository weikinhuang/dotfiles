/**
 * Tests for lib/node/pi/questionnaire/model.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  normalizeQuestions,
  questionRenderOptions,
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
