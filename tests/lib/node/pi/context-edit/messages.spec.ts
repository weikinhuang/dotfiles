import { describe, expect, test } from 'vitest';

import {
  addEdit,
  emptyState,
  type ContextEditState,
  type EditDirective,
  removeDirective,
} from '../../../../../lib/node/pi/context-edit/directive.ts';
import {
  buildMessageEditItems,
  filterMessageEditItems,
  parseEditId,
} from '../../../../../lib/node/pi/context-edit/messages.ts';
import { type LooseMessage, type Target, targetKey } from '../../../../../lib/node/pi/context-edit/target.ts';

const target = (timestamp: number, role: 'user' | 'assistant' = 'user'): Target => ({ by: 'message', role, timestamp });
const edit = (id: number, target: Target, text: string): EditDirective => ({
  kind: 'edit',
  id,
  target,
  text,
  createdAt: id,
});
const state = (...directives: EditDirective[]): ContextEditState => ({ directives, nextId: 100 });

const messages: LooseMessage[] = [
  { role: 'user', timestamp: 1, content: 'first question' },
  { role: 'assistant', timestamp: 2, content: 'second answer' },
  { role: 'user', timestamp: 3, content: 'third question' },
];

describe('buildMessageEditItems', () => {
  test('lists whole user/assistant text messages in document order with stable target keys', () => {
    const items = buildMessageEditItems(messages, emptyState());
    expect(items.map((item) => [item.id, item.role, item.text, item.stale])).toEqual([
      ['msg1', 'user', 'first question', false],
      ['msg2', 'assistant', 'second answer', false],
      ['msg3', 'user', 'third question', false],
    ]);
    expect(items.every((item) => item.key === targetKey(item.target))).toBe(true);
    expect(items.every((item) => item.editId === undefined && item.nonTextParts === 0)).toBe(true);
  });

  test('extracts only text with exact whitespace, newlines and empty text parts', () => {
    const input: LooseMessage[] = [
      {
        role: 'assistant',
        timestamp: 1,
        content: [
          { type: 'thinking', text: 'not visible', thinking: 'secret' },
          { type: 'text', text: '  first\n' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: '' },
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { text: 'not visible' } },
          { type: 'text', text: '\nlast  ' },
        ],
      },
    ];
    const [item] = buildMessageEditItems(input, emptyState());
    expect(item.original).toBe('  first\n\n\n\nlast  ');
    expect(item.text).toBe(item.original);
    expect(item.nonTextParts).toBe(3);
  });

  test('omits nontext messages and other roles, but includes original empty and whitespace text', () => {
    const input: LooseMessage[] = [
      { role: 'assistant', timestamp: 1, content: [{ type: 'thinking', text: 'secret' }] },
      { role: 'toolResult', timestamp: 2, content: 'output' },
      { role: 'system', timestamp: 3, content: 'system' },
      { role: 'user', timestamp: 4, content: '' },
      { role: 'assistant', timestamp: 5, content: [{ type: 'text', text: ' \n ' }] },
    ];
    expect(buildMessageEditItems(input, emptyState()).map((item) => item.original)).toEqual(['', ' \n ']);
  });

  test('counts duplicate timestamp occurrences even for skipped nontext messages', () => {
    const input: LooseMessage[] = [
      { role: 'assistant', timestamp: 1, content: [{ type: 'thinking', thinking: 'secret' }] },
      { role: 'assistant', timestamp: 1, content: 'one' },
      { role: 'assistant', timestamp: 1, content: 'two' },
    ];
    const overlay = state(edit(7, { by: 'message', role: 'assistant', timestamp: 1, occurrence: 2 }, 'changed'));
    const items = buildMessageEditItems(input, overlay);
    expect(items.map((item) => item.target)).toEqual([
      { by: 'message', role: 'assistant', timestamp: 1, occurrence: 1 },
      { by: 'message', role: 'assistant', timestamp: 1, occurrence: 2 },
    ]);
    expect(items.map((item) => item.text)).toEqual(['one', 'changed']);
    expect(items[1].editId).toBe(7);
  });

  test('keeps empty edits reachable and undo does not renumber handles', () => {
    const result = addEdit(emptyState(), target(1), '', undefined, 1);
    if (!result.ok) throw new Error(result.error);
    const items = buildMessageEditItems(messages, result.state);
    expect(items[0]).toMatchObject({ id: 'msg1', original: 'first question', text: '', editId: 1, stale: false });
    const restored = removeDirective(result.state, 1);
    if (!restored.ok) throw new Error(restored.error);
    expect(buildMessageEditItems(messages, restored.state).map((item) => item.id)).toEqual(
      items.map((item) => item.id),
    );
    expect(buildMessageEditItems(messages, restored.state)[0].text).toBe('first question');
  });

  test('edited multi-part text is exactly the draft, without blank-slot separator newlines', () => {
    const input: LooseMessage[] = [
      {
        role: 'user',
        timestamp: 1,
        content: [
          { type: 'text', text: 'one' },
          { type: 'image', data: 'A', mimeType: 'image/png' },
          { type: 'text', text: 'two' },
        ],
      },
    ];
    expect(buildMessageEditItems(input, state(edit(1, target(1), 'replacement')))[0].text).toBe('replacement');
  });

  test('uses directive id order for current text and surfaces unrepresented edits', () => {
    const items = buildMessageEditItems(messages, state(edit(9, target(1), 'newest'), edit(2, target(1), 'older')));
    expect(items[0]).toMatchObject({ text: 'newest', editId: 9 });
    expect(items[3]).toMatchObject({ id: 'edit2', text: 'older', editId: 2, stale: true });
  });

  test('includes orphan edits and invalid no-text targets as undo-only rows', () => {
    const input: LooseMessage[] = [
      { role: 'assistant', timestamp: 4, content: [{ type: 'image', data: 'A', mimeType: 'image/png' }] },
    ];
    const edits = [
      edit(4, target(1), 'missing user'),
      edit(5, target(2, 'assistant'), ''),
      edit(6, target(4, 'assistant'), 'cannot apply'),
    ];
    const items = buildMessageEditItems(input, state(...edits));
    expect(items.map((item) => [item.id, item.role, item.stale, item.original, item.text])).toEqual([
      ['edit4', 'user', true, '', 'missing user'],
      ['edit5', 'assistant', true, '', ''],
      ['edit6', 'assistant', true, '', 'cannot apply'],
    ]);
    expect(items.map((item) => item.key)).toEqual(edits.map((d) => targetKey(d.target)));
    expect(items[2].nonTextParts).toBe(1);
  });

  test('keeps legacy part-scoped and tool-result edits available for undo', () => {
    const input: LooseMessage[] = [...messages, { role: 'toolResult', toolCallId: 'c1', content: 'result' }];
    const items = buildMessageEditItems(
      input,
      state(
        edit(7, { ...target(1), partIndex: 0 }, 'part edit'),
        edit(8, { by: 'toolCallId', toolCallId: 'c1' }, 'result edit'),
      ),
    );
    expect(items[0].text).toBe('part edit');
    expect(items.slice(3).map((item) => [item.id, item.original, item.stale, item.role])).toEqual([
      ['edit7', 'first question', true, 'user'],
      ['edit8', 'result', true, 'assistant'],
    ]);
  });

  test('sorts by current UTF-8 bytes with stable ties without changing handles', () => {
    const input: LooseMessage[] = [
      { role: 'user', timestamp: 1, content: 'x'.repeat(100) },
      { role: 'user', timestamp: 2, content: '界界' },
      { role: 'assistant', timestamp: 3, content: 'abcdef' },
    ];
    expect(buildMessageEditItems(input, state(edit(1, target(1), '')), 'size').map((item) => item.id)).toEqual([
      'msg2',
      'msg3',
      'msg1',
    ]);
  });

  test('does not mutate original messages or directive state', () => {
    const input: LooseMessage[] = [
      { role: 'user', timestamp: 1, content: [{ type: 'text', text: 'original', signature: 's' }] },
    ];
    const overlay = state(edit(1, target(1), 'changed'), edit(2, target(99), 'orphan'));
    const before = structuredClone({ input, overlay });
    const items = buildMessageEditItems(input, overlay, 'size');
    expect({ input, overlay }).toEqual(before);
    items[0].target.partIndex = 99;
    expect(overlay).toEqual(before.overlay);
  });
});

describe('filterMessageEditItems', () => {
  test('searches full original/current bodies beyond previews, supports fuzzy multiword queries in any order', () => {
    const input: LooseMessage[] = [{ role: 'user', timestamp: 1, content: `${'x'.repeat(3000)}\noriginal needle` }];
    const items = buildMessageEditItems(input, state(edit(1, target(1), `${'z'.repeat(3000)}\ncurrent lantern`)));
    expect(filterMessageEditItems(items, 'lantern needle')).toEqual(items);
    expect(filterMessageEditItems(items, 'crnt ndl')).toEqual(items);
    expect(filterMessageEditItems(items, 'msg1')).toEqual(items);
    expect(filterMessageEditItems(items, 'LANTERN\n\tNEEDLE')).toEqual(items);
    expect(filterMessageEditItems(items, 'needle missing')).toEqual([]);
  });

  test('preserves chronological order instead of ranking fuzzy matches', () => {
    const items = buildMessageEditItems(messages, emptyState());
    expect(filterMessageEditItems(items, 'qstn').map((item) => item.id)).toEqual(['msg1', 'msg3']);
    expect(filterMessageEditItems(items, ' \n\t ')).toEqual(items);
  });

  test('combines role and edited-only filters, including empty and stale edits', () => {
    const items = buildMessageEditItems(
      messages,
      state(edit(1, target(1), ''), edit(2, target(9, 'assistant'), 'missing')),
    );
    expect(filterMessageEditItems(items, '', 'user').map((item) => item.id)).toEqual(['msg1', 'msg3']);
    expect(filterMessageEditItems(items, '', 'all', true).map((item) => item.id)).toEqual(['msg1', 'edit2']);
    expect(filterMessageEditItems(items, '', 'assistant', true).map((item) => item.id)).toEqual(['edit2']);
    expect(filterMessageEditItems(items, 'first', 'user', true).map((item) => item.id)).toEqual(['msg1']);
  });
});

describe('parseEditId', () => {
  test.each(['1', '#1', '42', '#42', '9007199254740991', '001'])('accepts positive safe decimal id %s', (input) => {
    expect(parseEditId(input)).toBe(Number(input.replace('#', '')));
  });

  test.each([
    '',
    '#',
    '0',
    '#0',
    '-1',
    '#-1',
    '+1',
    '1junk',
    '#1junk',
    '1.0',
    '1.2',
    '1e2',
    '0x10',
    'Infinity',
    'NaN',
    ' 1',
    '1 ',
    '1\n',
    '#1\r\n',
    '##1',
    '9007199254740992',
    '#9007199254740993',
  ])('rejects invalid id %s', (input) => {
    expect(parseEditId(input)).toBeNull();
  });
});
