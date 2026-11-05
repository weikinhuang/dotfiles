import { describe, expect, test } from 'vitest';

import type { ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import { frameReminder } from '../../../../../lib/node/pi/context-reminder.ts';
import { reminderRequestChars } from '../../../../../lib/node/pi/reminder-budget.ts';
import { reminderMessageAnchor } from '../../../../../lib/node/pi/reminder-identity.ts';
import { injectRecap, injectTimeline } from '../../../../../lib/node/pi/roleplay/context-window.ts';
import {
  associateRoleplayRequestUsage,
  captureRoleplayRequest,
  formatRoleplayRequest,
  readRoleplayRequestMetadata,
  roleplayGenerationOptions,
  type CaptureRoleplayRequestInput,
  type RoleplayRequestCategory,
} from '../../../../../lib/node/pi/roleplay/request-report.ts';

const message = (role: string, text: string, extra: Record<string, unknown> = {}): ReminderMessage => ({
  role,
  content: text,
  ...extra,
});
const snapshot = (id: string, body: string, timestamp = 20): ReminderMessage =>
  message('user', frameReminder(id, body), { cacheReminderSnapshot: true, timestamp });
const capture = (overrides: Partial<CaptureRoleplayRequestInput> = {}): ReturnType<typeof captureRoleplayRequest> =>
  captureRoleplayRequest({
    messages: [],
    scene: [],
    turnOrdinal: 7,
    requestOrdinal: 3,
    ...overrides,
  });

test('bounded metadata preserves boundary rows and reports omitted middle rows', () => {
  const messages = Array.from({ length: 700 }, (_, i) => message('user', `PRIVATE_${i}`, { timestamp: i }));
  const report = capture({ messages, scene: messages });
  expect(report.metadata.rows).toHaveLength(256);
  expect(report.metadata.omittedRows).toBe(444);
  expect(readRoleplayRequestMetadata(report.metadata)?.tail?.sceneTurn).toBe(700);
  expect(formatRoleplayRequest(report.metadata, report.content, { json: true })).not.toContain('PRIVATE_');
});

test('configuration provenance and provider options cross fixed allowlists only', () => {
  const report = capture({
    configSources: {
      keepTurns: 'project',
      promptTokenTarget: 'branch',
      private: 'PRIVATE',
    } as CaptureRoleplayRequestInput['configSources'],
  });
  expect(report.metadata.configSources).toEqual({ keepTurns: 'project', promptTokenTarget: 'branch' });
  expect(
    roleplayGenerationOptions({
      temperature: 0.8,
      max_tokens: 1200,
      authorization: 'PRIVATE',
      top_k: { private: true },
    }),
  ).toEqual({ temperature: 0.8, max_tokens: 1200 });
  expect(() => formatRoleplayRequest(report.metadata, {} as never, { section: 'system', content: true })).not.toThrow();
});

function secretFixture(): { messages: ReminderMessage[]; user: ReminderMessage } {
  const user = message('user', 'USER_SECRET', {
    timestamp: 20,
    cacheReminderEntryId: 'entry:PRIVATE_PATH/PRIVATE_ID:0',
  });
  const messages = [
    message('system', 'SYSTEM_SECRET', {
      sections: { PRIVATE_SECTION_NAME: 'SECTION_SECRET' },
      tools: [
        {
          name: 'TOOL_NAME_SECRET',
          description: 'TOOL_DEFINITION_SECRET',
          parameters: { secret: 'TOOL_SCHEMA_SECRET' },
        },
      ],
      headers: { authorization: 'AUTH_SECRET' },
    }),
    user,
    snapshot('roleplay-lore', 'LORE_SECRET'),
    snapshot('memory-capture', 'MEMORY_SECRET'),
    snapshot('arbitrary-private-name', 'OTHER_SECRET'),
    message('assistant', '', {
      content: [
        { type: 'text', text: 'ASSISTANT_SECRET' },
        { type: 'thinking', thinking: 'THINKING_SECRET', text: 'THINKING_TEXT_SECRET' },
        { type: 'image', data: 'IMAGE_SECRET' },
        {
          type: 'toolCall',
          id: 'CALL_ID_SECRET',
          name: 'TOOL_NAME_SECRET',
          arguments: { path: '/PATH_SECRET', token: 'TOOL_ARGS_SECRET' },
        },
      ],
    }),
    message('toolResult', 'TOOL_OUTPUT_SECRET', { toolCallId: 'CALL_ID_SECRET', toolName: 'TOOL_NAME_SECRET' }),
  ];
  return { messages, user };
}

describe('captureRoleplayRequest privacy boundary', () => {
  test('metadata JSON and default text never contain source text, identifiers, payloads, or arbitrary config', () => {
    const { messages, user } = secretFixture();
    const report = capture({
      messages,
      scene: [user],
      origin: reminderMessageAnchor(user),
      recap: { text: 'RECAP_SECRET', coveredTo: 4 },
      timeline: { text: 'TIMELINE_SECRET' },
      config: {
        windowTokens: 32000,
        privateName: 'CONFIG_SECRET',
        paths: ['/CONFIG_PATH_SECRET'],
        toolsEnabled: 'CONFIG_TOOL_SECRET',
      } as unknown as CaptureRoleplayRequestInput['config'],
      provider: 'https://PRIVATE_PROVIDER_SECRET',
      model: '/PRIVATE_MODEL_SECRET',
    });
    for (const rendered of [
      JSON.stringify(report.metadata),
      formatRoleplayRequest(report.metadata, report.content),
      formatRoleplayRequest(report.metadata, report.content, { json: true, snippets: true, content: true }),
    ]) {
      expect(rendered).not.toMatch(
        /SECRET|PRIVATE|arbitrary-private-name|authorization|parameters|cacheReminderEntryId/,
      );
    }
    expect(report.metadata.config).toEqual({ windowTokens: 32000 });
    expect(report.metadata.provider).toBeUndefined();
    expect(report.metadata.model).toBeUndefined();
    expect(report.metadata.rows[4].category).toBe('other-reminder');
  });

  test('snippets and section content require explicit opt-in; JSON stays metadata-only', () => {
    const report = capture({ messages: [message('user', 'visible private text')] });
    expect(formatRoleplayRequest(report.metadata, report.content, { section: 'conversation' })).not.toContain(
      'visible private text',
    );
    expect(formatRoleplayRequest(report.metadata, report.content, { content: true })).not.toContain(
      'visible private text',
    );
    expect(formatRoleplayRequest(report.metadata, report.content, { snippets: true })).toContain(
      'visible private text',
    );
    expect(
      formatRoleplayRequest(report.metadata, report.content, { section: 'conversation', content: true }),
    ).toContain('visible private text');
    expect(formatRoleplayRequest(report.metadata, report.content, { json: true, snippets: true })).not.toContain(
      'visible private text',
    );
  });

  test('even opt-in snapshots exclude thinking, images, tool arguments, auth headers, and declaration payloads', () => {
    const { messages } = secretFixture();
    messages.push(message('user', 'Hello\nAuthorization: Bearer AUTH_SECRET\nX-API-Key: KEY_SECRET\nGoodbye'));
    const report = capture({ messages });
    const text = JSON.stringify(report.content);
    expect(text).toContain('USER_SECRET');
    expect(text).toContain('TOOL_OUTPUT_SECRET');
    expect(text).toContain('[auth header redacted]');
    expect(text).not.toMatch(
      /THINKING|IMAGE_SECRET|AUTH_SECRET|KEY_SECRET|TOOL_ARGS_SECRET|TOOL_DEFINITION_SECRET|TOOL_NAME_SECRET|TOOL_SCHEMA_SECRET|CALL_ID_SECRET/,
    );
    const shown = formatRoleplayRequest(report.metadata, report.content, { snippets: true });
    expect(shown).not.toMatch(/THINKING|IMAGE_SECRET|AUTH_SECRET|KEY_SECRET|TOOL_ARGS_SECRET/);
  });

  test('copies the exact text snapshot before later input mutation', () => {
    const part = { type: 'text', text: 'exact  spacing\nline two' };
    const original = message('user', '', { content: [part], cacheReminderEntryId: 'stable-entry' });
    const input: CaptureRoleplayRequestInput = {
      messages: [original],
      scene: [original],
      turnOrdinal: 4,
      requestOrdinal: 1,
      recap: { text: 'old recap' },
      config: { windowTokens: 8000 },
    };
    const report = captureRoleplayRequest(input);
    const savedMetadata = JSON.stringify(report.metadata);
    part.text = 'mutated';
    original.content = 'replaced';
    input.recap!.text = 'new recap';
    input.config!.windowTokens = 2;
    expect(report.content.sections.conversation.text).toBe('exact  spacing\nline two');
    expect(report.content.sections.recap.text).toBe('old recap');
    expect(JSON.stringify(report.metadata)).toBe(savedMetadata);
  });

  test('escapes terminal controls, C1 controls and bidi overrides in every text content mode', () => {
    const report = capture({ messages: [message('user', '\u001b[31mred\u0007\r\u009b31m\u202eBAD\nnext')] });
    const out = formatRoleplayRequest(report.metadata, report.content, { section: 'conversation', content: true });
    expect(out).toContain('\\u001b[31mred\\u0007\\u000d\\u009b31m\\u202eBAD\nnext');
    expect(Array.from(out).some((character) => [27, 7, 13, 155, 0x202e].includes(character.codePointAt(0) ?? 0))).toBe(
      false,
    );
  });
});

describe('composition and scene mapping', () => {
  test('head and tail are actual final conversation rows mapped through stable identities, not request positions', () => {
    const first = message('user', 'first', { cacheReminderEntryId: 'one', timestamp: 10 });
    const reply = message('assistant', 'reply', { cacheReminderEntryId: 'two' });
    const latest = message('user', 'latest', { cacheReminderEntryId: 'three', timestamp: 20 });
    const report = capture({
      scene: [message('system', 'head'), first, reply, latest],
      origin: reminderMessageAnchor(latest),
      messages: [
        message('system', 'head'),
        snapshot('roleplay-lore', 'historical', 10),
        { ...reply, content: 'condensed reply' },
        latest,
        snapshot('roleplay-depth', 'tail note'),
      ],
    });
    expect(report.metadata.head).toMatchObject({ ordinal: 3, role: 'assistant', sceneTurn: 1 });
    expect(report.metadata.tail).toMatchObject({ ordinal: 4, role: 'user', sceneTurn: 2 });
    expect(report.metadata.rows[1]).toMatchObject({
      category: 'lore',
      sceneTurn: 1,
      snapshot: 'historical',
      afterLatestUser: false,
    });
    expect(report.metadata.rows[4]).toMatchObject({
      category: 'depth',
      sceneTurn: 2,
      snapshot: 'current',
      afterLatestUser: true,
    });
    expect(report.metadata.rows.map((row) => row.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(JSON.stringify(report.metadata)).not.toMatch(/"one"|"two"|"three"/);
  });

  test('tool-only assistant messages and results do not replace the actual conversation tail', () => {
    const user = message('user', 'hello');
    const call = message('assistant', '', {
      content: [{ type: 'toolCall', name: 'PRIVATE_TOOL', arguments: { secret: 'SECRET' } }],
    });
    const result = message('toolResult', 'tool output');
    const report = capture({ messages: [user, call, result], scene: [user, call, result] });
    expect(report.metadata.rows.map((row) => row.category)).toEqual(['conversation', 'tools', 'tools']);
    expect(report.metadata.head?.ordinal).toBe(1);
    expect(report.metadata.tail?.ordinal).toBe(1);
    expect(report.metadata.totals.toolsChars).toBe(reminderRequestChars([call, result]));
  });

  test('a custom trigger uses its bound origin for after-latest-user placement', () => {
    const user = message('user', 'previous', { timestamp: 10 });
    const custom = message('custom', 'scheduled', { customType: 'scheduled-prompt', timestamp: 20 });
    const report = capture({
      messages: [user, snapshot('roleplay-lore', 'old', 10), custom, snapshot('roleplay-lore', 'new', 20)],
      scene: [user, custom],
      origin: reminderMessageAnchor(custom),
    });
    expect(report.metadata.rows.map((row) => row.afterLatestUser)).toEqual([false, false, false, true]);
  });

  test('ambiguous and unavailable identities are not guessed; unknown roles have a fixed label', () => {
    const duplicate = message('user', 'same', { timestamp: 1 });
    const report = capture({
      scene: [duplicate, { ...duplicate }],
      messages: [duplicate, message('PRIVATE_ROLE', 'text', { cacheReminderIdentityUnavailable: true })],
    });
    expect(report.metadata.rows.map((row) => row.sceneTurn)).toEqual([null, null]);
    expect(report.metadata.rows[1].role).toBe('other');
    expect(JSON.stringify(report.metadata)).not.toContain('PRIVATE_ROLE');
  });

  test('unique stable identities take precedence over duplicate content fallback hashes', () => {
    const first = message('user', 'identical', { timestamp: 1, cacheReminderEntryId: 'private-first' });
    const second = { ...first, cacheReminderEntryId: 'private-second' };
    const report = capture({ scene: [first, second], messages: [second] });
    expect(report.metadata.head?.sceneTurn).toBe(2);
    expect(JSON.stringify(report.metadata)).not.toMatch(/private-first|private-second/);
  });

  test('snapshot age is unknown without unique origin evidence', () => {
    const user = message('user', 'user', { timestamp: 20 });
    const snap = snapshot('roleplay-lore', 'lore');
    expect(capture({ scene: [user], messages: [user, snap] }).metadata.rows[1].snapshot).toBe('unknown');
    expect(
      capture({
        scene: [user, { ...user, content: 'different' }],
        messages: [snap],
        origin: reminderMessageAnchor(user),
      }).metadata.rows[0].snapshot,
    ).toBe('unknown');
  });

  test.each([
    ['roleplay-lore', 'lore'],
    ['roleplay-depth', 'depth'],
    ['roleplay-scene-fold', 'scene-fold'],
    ['memory-index', 'memory'],
    ['memory-capture', 'memory'],
    ['roleplay-recap', 'recap'],
    ['roleplay-timeline', 'timeline'],
    ['unknown-id', 'other-reminder'],
  ] as const)('maps only fixed reminder producer %s to %s', (id, category) => {
    expect(capture({ messages: [snapshot(id, 'body')] }).metadata.rows[0].category).toBe(category);
  });

  test('mixed reminder snapshots expose every fixed component without adding rows or budget charges', () => {
    const producers = [
      ['roleplay-lore', 'lore'],
      ['roleplay-depth', 'depth'],
      ['roleplay-scene-fold', 'scene-fold'],
      ['memory-index', 'memory'],
    ] as const;
    const mixed = snapshot('roleplay-lore', 'lore');
    mixed.content = producers.map(([id, category]) => ({
      type: 'text',
      text: frameReminder(id, `${category} PRIVATE_BODY`),
    }));
    const { metadata, content } = capture({ messages: [mixed] });
    expect(metadata.rows).toHaveLength(1);
    expect(metadata.rows[0].category).toBe('other-reminder');
    for (const [id, category] of producers) {
      expect(metadata.rows[0].components).toContainEqual({
        category,
        chars: frameReminder(id, `${category} PRIVATE_BODY`).length,
      });
      expect(content.sections[category].text).toBe(frameReminder(id, `${category} PRIVATE_BODY`));
      expect(formatRoleplayRequest(metadata, content, { section: category, content: true })).toContain(
        `${category} PRIVATE_BODY`,
      );
    }
    expect(metadata.totals).toMatchObject({ reminderChars: reminderRequestChars([mixed]), conversationChars: 0 });
    expect(readRoleplayRequestMetadata(metadata)).toEqual(metadata);
    expect(formatRoleplayRequest(metadata, content)).not.toContain('PRIVATE_BODY');
  });

  test('only genuine user narratives increment scene turns; tool, custom, startup and reminder messages do not', () => {
    const scene = [
      message('assistant', 'preface'),
      message('user', 'startup', { startup: true }),
      message('user', 'one'),
      message('assistant', 'reply'),
      message('toolResult', 'result'),
      message('custom', 'notice'),
      message('user', 'typed custom', { customType: 'notice' }),
      snapshot('memory-index', 'memory'),
      message('user', 'two'),
      message('assistant', 'two reply'),
    ];
    const report = capture({ scene, messages: scene });
    expect(report.metadata.rows.map((row) => row.sceneTurn)).toEqual([null, null, 1, 1, 1, 1, 1, null, 2, 2]);
  });

  test('unmarked user tags stay conversation while marked producer blocks have component metadata', () => {
    const framed = frameReminder('memory-index', 'memory');
    const plain = message('user', framed);
    const marked = message('user', '', {
      content: [
        { type: 'text', text: 'narrative' },
        { type: 'text', text: framed, cacheReminderBlock: true },
      ],
    });
    const untouched = capture({ messages: [plain] });
    expect(untouched.metadata.totals.reminderChars).toBe(0);
    expect(untouched.content.sections.memory.status).toBe('unavailable');
    expect(untouched.content.sections.conversation.text).toBe(framed);
    const report = capture({ messages: [marked] });
    expect(report.metadata.rows[0].components).toEqual([
      { category: 'conversation', chars: 9 },
      { category: 'memory', chars: framed.length },
    ]);
    expect(report.metadata.totals.reminderChars).toBe(framed.length);
    expect(report.content.sections.memory.text).toBe(framed);
    expect(report.content.sections.head.text).toBe('narrative');
  });

  test('exact supplied recap/timeline prefixes split from the first user and count once', () => {
    const scene = [message('user', 'real narrative', { cacheReminderEntryId: 'one' })];
    const messages = injectTimeline(injectRecap(scene, 'recap text'), 'timeline text') as readonly ReminderMessage[];
    const report = capture({ messages, scene, recap: { text: 'recap text' }, timeline: { text: 'timeline text' } });
    expect(report.content.sections.conversation.text).toBe('real narrative');
    expect(report.content.sections.head.text).toBe('real narrative');
    expect(report.content.sections.recap.text).toContain('recap text');
    expect(report.content.sections.timeline.text).toContain('timeline text');
    expect(report.content.sections.recap.source).not.toBe('supplemental');
    expect(report.metadata.totals.conversationChars).toBe('real narrative'.length);
    expect(report.metadata.totals.requestChars).toBe(reminderRequestChars(messages));
    expect(report.metadata.totals.conversationChars + report.metadata.totals.reminderChars).toBe(
      report.metadata.totals.requestChars,
    );
    expect(report.metadata.rows[0].sceneTurn).toBe(1);
    const unknown = capture({
      messages,
      scene,
      recap: { text: 'different recap' },
      timeline: { text: 'different timeline' },
    });
    expect(unknown.metadata.totals.reminderChars).toBe(0);
    expect(unknown.content.sections.conversation.text).toContain('recap text');
    expect(unknown.content.sections.recap.source).toBe('supplemental');
    expect(formatRoleplayRequest(unknown.metadata, unknown.content, { section: 'recap', content: true })).toContain(
      'supplemental snapshot; not an additional request budget charge',
    );
  });

  test('effective system sections, tool patches, forced prompt, and messages form exclusive character buckets', () => {
    const messages = [
      message('system', 'base', {
        sections: { a: 'old', b: 'keep' },
        tools: [{ name: 'one', description: 'old' }, { name: 'two' }],
      }),
      message('system', '', {
        sections: { a: 'newer', b: null },
        toolsAdded: [{ name: 'three' }],
        toolsRemoved: ['one'],
      }),
      message('user', 'hi'),
      snapshot('roleplay-lore', 'lore'),
      message('toolResult', 'result'),
      message('assistant', '', { content: [{ type: 'toolCall', arguments: { query: 'arg' }, name: 'two' }] }),
    ];
    for (const systemPrompt of [undefined, '', 'forced head']) {
      const report = capture({ messages, systemPrompt, recap: { text: 'not an extra request charge' } });
      const totals = report.metadata.totals;
      expect(totals.requestChars).toBe(reminderRequestChars(messages, systemPrompt));
      expect(totals.systemChars).toBe(
        systemPrompt === undefined ? 'base'.length + 'newer'.length : systemPrompt.length,
      );
      expect(totals.systemChars + totals.toolsChars + totals.conversationChars + totals.reminderChars).toBe(
        totals.requestChars,
      );
      expect(totals.toolsChars).toBe(
        JSON.stringify([{ name: 'two' }, { name: 'three' }]).length +
          'result'.length +
          reminderRequestChars([messages[5]]),
      );
      expect(report.content.sections.system.text).toBe(systemPrompt ?? 'base\n\nnewer');
    }
  });

  test('non-system tool declarations belong only to tools, not conversation or reminders', () => {
    const user = message('user', 'hi', { tools: [{ name: 'private' }] });
    const totals = capture({ messages: [user] }).metadata.totals;
    expect(totals.conversationChars).toBe(2);
    expect(totals.toolsChars).toBe(JSON.stringify(user.tools).length);
    expect(totals.requestChars).toBe(totals.conversationChars + totals.toolsChars);
  });

  test('recap and timeline metadata retain counts and coverage only', () => {
    const report = capture({
      recap: { text: 'recap', coveredFrom: 1, coveredTo: 10 },
      timeline: { text: 'timeline', coveredTo: 8 },
    });
    expect(report.metadata.recap).toEqual({ available: true, chars: 5, coveredFrom: 1, coveredTo: 10 });
    expect(report.metadata.timeline).toEqual({ available: true, chars: 8, coveredFrom: null, coveredTo: 8 });
    expect(report.metadata.head).toBeNull();
    expect(report.metadata.tail).toBeNull();
    expect(report.metadata.totals.requestChars).toBe(0);
  });
});

describe('bounded transient content', () => {
  test('head and tail preserve beginning and end independently of exhausted conversation capacity', () => {
    const first = message('user', `FIRST_BEGIN${'x'.repeat(1000)}FIRST_END`);
    const last = message('assistant', `LAST_BEGIN${'y'.repeat(1000)}LAST_END`);
    const report = capture({
      messages: [first, message('assistant', 'middle'), last, snapshot('memory-index', 'not the tail')],
      sectionChars: 64,
    });
    expect(report.content.sections.conversation.status).toBe('truncated');
    for (const [key, begin, end] of [
      ['head', 'FIRST_BEGIN', 'FIRST_END'],
      ['tail', 'LAST_BEGIN', 'LAST_END'],
    ] as const) {
      const section = report.content.sections[key];
      expect(section.status).toBe('truncated');
      expect(section.text.length).toBeLessThanOrEqual(64);
      expect(section.text).toContain(begin);
      expect(section.text).toContain(end);
      expect(formatRoleplayRequest(report.metadata, report.content, { section: key, content: true })).toContain(end);
      expect(formatRoleplayRequest(report.metadata, report.content, { section: key })).not.toContain(begin);
      expect(
        formatRoleplayRequest(report.metadata, report.content, { section: key, json: true, snippets: true }),
      ).not.toContain(begin);
    }
    const snippets = formatRoleplayRequest(report.metadata, report.content, {
      section: 'tail',
      snippets: true,
      snippetChars: 32,
    });
    expect(snippets).toContain('LAST_BEGIN');
    expect(snippets).toContain('LAST_END');
  });
  test('each section is capped independently and explicit truncation/unavailable markers survive formatting', () => {
    const report = capture({
      sectionChars: 24,
      systemPrompt: 's'.repeat(100),
      messages: [
        message('user', 'u'.repeat(100)),
        snapshot('roleplay-lore', 'l'.repeat(100)),
        message('user', 'another message'),
      ],
      recap: { text: 'r'.repeat(100) },
    });
    for (const category of ['system', 'conversation', 'lore', 'recap'] as const) {
      expect(report.content.sections[category].text.length).toBeLessThanOrEqual(24);
      expect(report.content.sections[category].status).toBe('truncated');
      expect(formatRoleplayRequest(report.metadata, report.content, { section: category, content: true })).toContain(
        `[${category}: truncated]`,
      );
    }
    expect(report.content.sections.memory.status).toBe('unavailable');
    expect(formatRoleplayRequest(report.metadata, undefined, { section: 'memory', content: true })).toContain(
      '[memory: unavailable]',
    );
    expect(report.metadata.rows[0].chars).toBe(100);
  });

  test('hard cap, zero cap, default snippet cap, and section opt-in cannot be bypassed', () => {
    const text = 'x'.repeat(100000);
    const report = capture({ systemPrompt: text, sectionChars: 1e9 });
    expect(report.content.sections.system.text).toHaveLength(65536);
    expect(report.content.sections.system.status).toBe('truncated');
    const zero = capture({ systemPrompt: 'anything', sectionChars: 0 });
    expect(zero.content.sections.system).toEqual({ status: 'truncated', text: '', source: 'request' });
    const snippet = formatRoleplayRequest(report.metadata, report.content, {
      snippets: true,
      section: 'system',
      snippetChars: 10000,
    });
    expect(snippet.split('\n').at(-1)).toHaveLength(512);
    expect(snippet).toContain('[system: truncated]');
    expect(
      formatRoleplayRequest(report.metadata, report.content, {
        section: 'INJECTED_SECTION' as RoleplayRequestCategory,
        content: true,
      }),
    ).not.toContain('INJECTED_SECTION');
  });
});

describe('persisted metadata and reported usage', () => {
  test('caller request facts are validated, optional and independent of window configuration', () => {
    const facts = {
      outcome: 'completed',
      requestKind: 'continuation',
      createdAt: 123.5,
      estimatedInputTokens: 234,
    } as const;
    const report = capture(facts);
    expect(report.metadata).toMatchObject(facts);
    expect(readRoleplayRequestMetadata({ ...report.metadata, text: 'SECRET' })).toEqual(report.metadata);
    for (const outcome of ['projected', 'attempted', 'completed', 'failed', 'aborted'] as const)
      expect(capture({ outcome }).metadata.outcome).toBe(outcome);
    expect(capture({ requestKind: 'narrative' }).metadata.requestKind).toBe('narrative');
    const bad = { outcome: 'SECRET', requestKind: 'SECRET', createdAt: Infinity, estimatedInputTokens: -1 };
    const invalid = capture(bad as unknown as Partial<CaptureRoleplayRequestInput>);
    for (const key of Object.keys(bad)) expect(invalid.metadata).not.toHaveProperty(key);
    expect(readRoleplayRequestMetadata({ ...report.metadata, ...bad })).toEqual(capture().metadata);
    expect(capture().metadata).not.toHaveProperty('createdAt');
    expect(capture().metadata).not.toHaveProperty('estimatedInputTokens');
  });

  test('safe configuration includes retention and recap controls with nullable recapAsync', () => {
    const config = {
      promptTokenTarget: 12000,
      pinSceneOpener: true,
      pinSceneOpenerReply: false,
      keepTurns: 4,
      recapChunk: 8,
      capture: true,
      timeline: false,
      recapAsync: null,
    };
    const report = capture({ config });
    expect(report.metadata.config).toEqual(config);
    expect(readRoleplayRequestMetadata(report.metadata)?.config).toEqual(config);
    for (const recapAsync of [true, false, null])
      expect(capture({ config: { recapAsync } }).metadata.config.recapAsync).toBe(recapAsync);
    expect(
      capture({ config: { capture: null, recapAsync: 1 } as unknown as CaptureRoleplayRequestInput['config'] }).metadata
        .config,
    ).toEqual({});
  });
  test('round-trips metadata while dropping unknown fields at every boundary and rebuilding head/tail', () => {
    const report = capture({
      messages: [message('user', 'private')],
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      config: { windowTokens: 64000 },
    });
    const dirty = {
      ...report.metadata,
      text: 'SECRET',
      headers: { authorization: 'SECRET' },
      rows: report.metadata.rows.map((row) => ({ ...row, toolName: 'SECRET' })),
      totals: { ...report.metadata.totals, payload: 'SECRET' },
      config: { ...report.metadata.config, private: 'SECRET' },
      recap: { ...report.metadata.recap, text: 'SECRET' },
      timeline: { ...report.metadata.timeline, text: 'SECRET' },
      head: { role: 'SECRET' },
      tail: { text: 'SECRET' },
    };
    expect(readRoleplayRequestMetadata(dirty)).toEqual(report.metadata);
    expect(JSON.stringify(readRoleplayRequestMetadata(dirty))).not.toContain('SECRET');
    expect(formatRoleplayRequest(dirty, report.content, { json: true })).not.toContain('SECRET');
    expect(readRoleplayRequestMetadata(JSON.parse(JSON.stringify(report.metadata)))).toEqual(report.metadata);
  });

  test('rejects invalid metadata rather than rendering arbitrary string values', () => {
    const report = capture({ messages: [message('user', 'private')] });
    for (const bad of [
      null,
      'PRIVATE',
      {},
      { ...report.metadata, version: 2 },
      { ...report.metadata, turnOrdinal: NaN },
      { ...report.metadata, rows: [{ ...report.metadata.rows[0], role: 'PRIVATE' }] },
      { ...report.metadata, rows: [{ ...report.metadata.rows[0], chars: -1 }] },
      { ...report.metadata, totals: { ...report.metadata.totals, requestChars: Infinity } },
    ])
      expect(readRoleplayRequestMetadata(bad)).toBeNull();
    expect(formatRoleplayRequest({ ...report.metadata, version: 2 })).toContain('unavailable');
  });

  test('identifiers must pass restricted provider/model patterns', () => {
    expect(capture({ provider: 'openai', model: 'gpt-4.1' }).metadata).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1',
    });
    for (const model of ['gemma4:31b', 'gemma-4-31b-it', 'llama3.3:70b', 'qwen3:32b']) {
      const report = capture({ provider: 'llama-cpp', model });
      expect(report.metadata).toMatchObject({ provider: 'llama-cpp', model });
      expect(readRoleplayRequestMetadata(report.metadata)?.model).toBe(model);
    }
    for (const invalid of [
      'https://host/path?api_key=SECRET',
      'PRIVATE_NAME',
      'gpt-4\u001b[31m',
      'gpt-/private/path',
      'claude-SECRET',
      'openai:Bearer SECRET',
    ]) {
      expect(capture({ provider: invalid, model: invalid }).metadata.provider).toBeUndefined();
      expect(capture({ provider: invalid, model: invalid }).metadata.model).toBeUndefined();
    }
  });

  test('usage attaches only to the same turn/request and retains input/cache counts, never payloads', () => {
    const { metadata } = capture();
    const usage = { input: 100, cacheRead: 200, cacheWrite: 50, output: 999, private: 'SECRET' };
    expect(
      associateRoleplayRequestUsage(metadata, { turnOrdinal: 7, requestOrdinal: 3, usage }).reportedInputTokens,
    ).toBe(350);
    expect(associateRoleplayRequestUsage(metadata, { turnOrdinal: 7, requestOrdinal: 4, usage })).toBe(metadata);
    expect(associateRoleplayRequestUsage(metadata, { turnOrdinal: 6, requestOrdinal: 3, usage })).toBe(metadata);
    expect(associateRoleplayRequestUsage(metadata, { turnOrdinal: 7, requestOrdinal: 3, usage: { input: -1 } })).toBe(
      metadata,
    );
    expect(
      JSON.stringify(associateRoleplayRequestUsage(metadata, { turnOrdinal: 7, requestOrdinal: 3, usage })),
    ).not.toContain('SECRET');
    expect(metadata.reportedInputTokens).toBeUndefined();
  });
});
