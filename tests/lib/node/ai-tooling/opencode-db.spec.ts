import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { type OpencodeMessage } from '../../../../lib/node/ai-tooling/adapters/opencode-adapter.ts';
import {
  defaultOpencodeDataDir,
  isOpencodeV2,
  readOpencodeMessages,
  resolveOpencodeDbPath,
  summarizeOpencodeMessages,
} from '../../../../lib/node/ai-tooling/opencode-db.ts';

function v2Db(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL);
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);
  return db;
}

describe('isOpencodeV2', () => {
  test('true when session_v2 exists', () => {
    expect(isOpencodeV2(v2Db())).toBe(true);
  });

  test('false for a v1 store (session / message / part)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE session (id TEXT); CREATE TABLE message (id TEXT); CREATE TABLE part (id TEXT);');
    expect(isOpencodeV2(db)).toBe(false);
  });
});

describe('readOpencodeMessages', () => {
  test('orders by seq, folds the row type into data, skips malformed rows', () => {
    const db = v2Db();
    const insert = db.prepare('INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?, ?, ?, ?, ?)');
    insert.run('m3', 's1', 'assistant', 30, JSON.stringify({ agent: 'build', model: { id: 'm' } }));
    insert.run('m1', 's1', 'user', 10, JSON.stringify({ text: 'hi' }));
    insert.run('m2', 's1', 'synthetic', 20, 'not json');
    insert.run('m4', 's1', 'assistant', 40, '[1, 2]');
    insert.run('x1', 's2', 'user', 10, '{}');

    const msgs = readOpencodeMessages(db, 's1');
    expect(msgs.map((m) => m.type)).toEqual(['user', 'assistant']);
    expect(msgs[1]).toMatchObject({ type: 'assistant', agent: 'build', model: { id: 'm' } });
  });
});

describe('summarizeOpencodeMessages', () => {
  const messages: OpencodeMessage[] = [
    { type: 'user' },
    { type: 'synthetic' },
    {
      type: 'assistant',
      agent: 'build',
      model: { id: 'gpt-a', providerID: 'github-copilot' },
      cost: 0.25,
      tokens: { input: 8270, output: 154, reasoning: 25, cache: { read: 0, write: 0 } },
      content: [
        { type: 'reasoning' },
        { type: 'text' },
        { type: 'tool', name: 'read' },
        { type: 'tool', name: 'read' },
        { type: 'tool', name: 'glob' },
      ],
    },
    {
      type: 'assistant',
      agent: 'plan',
      model: { id: 'gpt-b', providerID: 'github-copilot' },
      cost: 0.5,
      tokens: { input: 8700, output: 911, reasoning: 41, cache: { read: 18704, write: 4 } },
      content: [{ type: 'tool', name: 'shell' }, { type: 'tool' }],
    },
    { type: 'user' },
    { type: 'idle' },
  ];

  test('counts user turns, sums tokens and cost, tallies tool items by name', () => {
    const s = summarizeOpencodeMessages(messages);
    expect(s.userTurns).toBe(2);
    expect(s.cost).toBeCloseTo(0.75);
    expect(s.tokens).toEqual({ input: 16970, output: 1065, reasoning: 66, cacheRead: 18704, cacheWrite: 4 });
    expect(s.toolCalls).toBe(4);
    expect(s.toolBreakdown).toEqual({ read: 2, glob: 1, shell: 1 });
  });

  test('first agent wins, last model wins', () => {
    const s = summarizeOpencodeMessages(messages);
    expect(s.agent).toBe('build');
    expect(s.model).toBe('gpt-b');
  });

  test('lastContextTokens is input + cache write + cache read of the last assistant message', () => {
    expect(summarizeOpencodeMessages(messages).lastContextTokens).toBe(8700 + 4 + 18704);
  });

  test('empty session yields zeroes and no context', () => {
    const s = summarizeOpencodeMessages([]);
    expect(s.userTurns).toBe(0);
    expect(s.toolCalls).toBe(0);
    expect(s.lastContextTokens).toBeUndefined();
  });
});

describe('resolveOpencodeDbPath', () => {
  test('explicit --user-dir wins over OPENCODE_DB', () => {
    expect(resolveOpencodeDbPath('/data/oc', { OPENCODE_DB: '/x/other.db' })).toBe(join('/data/oc', 'opencode.db'));
  });

  test('OPENCODE_DB is used when no --user-dir is given', () => {
    expect(resolveOpencodeDbPath('', { OPENCODE_DB: '/profiles/work/opencode.db' })).toBe('/profiles/work/opencode.db');
  });

  test('falls back to XDG_DATA_HOME, then ~/.local/share', () => {
    expect(resolveOpencodeDbPath('', { XDG_DATA_HOME: '/xdg' })).toBe(join('/xdg', 'opencode', 'opencode.db'));
    expect(defaultOpencodeDataDir({})).toBe('~/.local/share/opencode');
  });
});
