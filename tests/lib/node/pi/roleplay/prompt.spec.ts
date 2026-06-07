/**
 * Tests for lib/node/pi/roleplay/prompt.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { type LoreChunk } from '../../../../../lib/node/pi/roleplay/budget.ts';
import { formatLoreBlock } from '../../../../../lib/node/pi/roleplay/prompt.ts';
import { emptyLoreMeta, type RoleplayEntry } from '../../../../../lib/node/pi/roleplay/store.ts';

const chunk = (id: string, body: string, constant = false): LoreChunk => ({
  entry: {
    id,
    kind: 'lore',
    name: id,
    description: `desc ${id}`,
    lore: { ...emptyLoreMeta(), constant },
  } satisfies RoleplayEntry,
  body,
});

test('returns null when nothing kept', () => {
  expect(formatLoreBlock({ kept: [], dropped: [] })).toBeNull();
});

test('renders a header and each kept body', () => {
  const block = formatLoreBlock({ kept: [chunk('ri', 'Rhodes Island detail.')], dropped: [] });
  expect(block).toContain('## Roleplay lore');
  expect(block).toContain('### ri');
  expect(block).toContain('Rhodes Island detail.');
});

test('marks always-on (constant) entries', () => {
  const block = formatLoreBlock({ kept: [chunk('world', 'Setting facts.', true)], dropped: [] });
  expect(block).toContain('### world (always-on)');
});

test('appends a trailer listing dropped entries', () => {
  const dropped: RoleplayEntry[] = [{ id: 'extra', kind: 'lore', name: 'Extra', description: 'd' }];
  const block = formatLoreBlock({ kept: [chunk('ri', 'kept body')], dropped });
  expect(block).toContain('lore budget reached');
  expect(block).toContain('Extra');
});
