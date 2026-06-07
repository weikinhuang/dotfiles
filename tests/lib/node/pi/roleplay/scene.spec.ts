/**
 * Tests for lib/node/pi/roleplay/scene.ts (Phase 5 scene composition).
 *
 * Pure module - bodies are injected via a Map-backed `bodyOf`.
 */

import { expect, test } from 'vitest';

import { composeSceneBlock, resolveCharacter } from '../../../../../lib/node/pi/roleplay/scene.ts';
import { type RoleplayEntry, type RoleplayState } from '../../../../../lib/node/pi/roleplay/store.ts';

function char(id: string, name: string): RoleplayEntry {
  return { id, kind: 'character', name, description: `${name} desc` };
}

const state: RoleplayState = {
  cast: 'penguin-logistics',
  entries: [
    char('exusiai', 'Exusiai'),
    char('texas', 'Texas'),
    char('lappland', 'Lappland'),
    { id: 'org', kind: 'lore', name: 'Penguin Logistics', description: 'the org' },
  ],
};

const bodies: Record<string, string> = {
  exusiai: 'Exusiai is a cheerful Sankta sniper.',
  texas: 'Texas is a stoic Lupo executive.',
  lappland: 'Lappland is an unhinged Lupo.',
};
const bodyOf = (e: RoleplayEntry): string => bodies[e.id] ?? '';

// ── resolveCharacter ──────────────────────────────────────────────────────

test('resolveCharacter matches by id, then case-insensitive name, then name-slug', () => {
  expect(resolveCharacter(state, 'exusiai')?.id).toBe('exusiai');
  expect(resolveCharacter(state, 'TEXAS')?.id).toBe('texas');
  expect(resolveCharacter(state, 'Lappland')?.id).toBe('lappland');
  expect(resolveCharacter(state, 'unknown')).toBeUndefined();
  expect(resolveCharacter(state, '  ')).toBeUndefined();
});

test('resolveCharacter never returns a lore entry', () => {
  expect(resolveCharacter(state, 'Penguin Logistics')).toBeUndefined();
});

// ── composeSceneBlock ─────────────────────────────────────────────────────

test('neither characters nor pov → null block, no missing', () => {
  expect(composeSceneBlock(state, bodyOf, {})).toStrictEqual({ block: null, missing: [] });
});

test('folds listed characters in declared order under headings', () => {
  const { block, missing } = composeSceneBlock(state, bodyOf, { characters: ['Texas', 'Exusiai'] });
  expect(missing).toStrictEqual([]);
  expect(block).toBe(
    [
      '## Roleplay scene',
      '',
      '### Texas',
      'Texas is a stoic Lupo executive.',
      '',
      '### Exusiai',
      'Exusiai is a cheerful Sankta sniper.',
    ].join('\n'),
  );
});

test('dedupes repeated names', () => {
  const { block } = composeSceneBlock(state, bodyOf, { characters: ['Exusiai', 'exusiai', 'Exusiai'] });
  expect(block?.match(/### Exusiai/g)).toHaveLength(1);
});

test('pov character renders last, tagged, and is dropped from the NPC list', () => {
  const { block } = composeSceneBlock(state, bodyOf, { characters: ['Exusiai', 'Texas'], pov: 'Texas' });
  expect(block).toBe(
    [
      '## Roleplay scene',
      '',
      'The user plays **Texas**.',
      '',
      '### Exusiai',
      'Exusiai is a cheerful Sankta sniper.',
      '',
      '### Texas (player character)',
      'Texas is a stoic Lupo executive.',
    ].join('\n'),
  );
});

test('off-cast pov still announces the POV line without a body', () => {
  const { block, missing } = composeSceneBlock(state, bodyOf, { pov: 'Doctor' });
  expect(missing).toStrictEqual([]);
  expect(block).toBe(['## Roleplay scene', '', 'The user plays **Doctor**.'].join('\n'));
});

test('missing characters are warn-dropped, resolved ones still fold', () => {
  const { block, missing } = composeSceneBlock(state, bodyOf, { characters: ['Exusiai', 'Ghost', 'Phantom'] });
  expect(missing).toStrictEqual(['Ghost', 'Phantom']);
  expect(block).toContain('### Exusiai');
  expect(block).not.toContain('Ghost');
});

test('characters with empty bodies are skipped', () => {
  const { block } = composeSceneBlock(state, (e) => (e.id === 'exusiai' ? '' : bodyOf(e)), {
    characters: ['Exusiai', 'Texas'],
  });
  expect(block).not.toContain('### Exusiai');
  expect(block).toContain('### Texas');
});

test('budget omits later sheets but always keeps the first, with a trailer', () => {
  const big = (e: RoleplayEntry): string => 'y'.repeat(400) + e.id;
  const { block } = composeSceneBlock(state, big, { characters: ['Exusiai', 'Texas', 'Lappland'], maxChars: 500 });
  // First sheet (~400 chars) fits; the second would push past 500 -> omitted.
  expect(block).toContain('### Exusiai');
  expect(block).not.toContain('### Texas');
  expect(block).toMatch(/2 character sheet\(s\) omitted for length/);
});

test('first sheet is kept even when it alone exceeds the cap', () => {
  const huge = 'x'.repeat(2000);
  const { block } = composeSceneBlock(state, (e) => (e.id === 'exusiai' ? huge : bodyOf(e)), {
    characters: ['Exusiai', 'Texas'],
    maxChars: 500,
  });
  expect(block).toContain(huge);
  expect(block).toMatch(/omitted for length/);
});
