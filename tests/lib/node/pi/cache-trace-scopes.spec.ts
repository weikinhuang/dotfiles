import { expect, test } from 'vitest';

import { extractTraceScopes } from '../../../../lib/node/pi/cache-trace-scopes.ts';

test.each([
  { system: [{ type: 'text', text: 'SYSTEM' }], tools: [{ name: 'tool' }] },
  { system: [{ text: 'SYSTEM' }], toolConfig: { tools: [{ toolSpec: { name: 'tool' } }] } },
  {
    instructions: 'SYSTEM',
    input: [{ role: 'developer', content: [{ type: 'input_text', text: 'MORE' }] }],
    tools: [],
  },
  { systemInstruction: { parts: [{ text: 'SYSTEM' }] }, tools: [] },
])('separately extracts provider-specific system fields and declarations', (payload) => {
  const scopes = extractTraceScopes(payload);
  expect(scopes.system.text).toContain('SYSTEM');
  expect(scopes.system.metadata.bytes).toBeGreaterThan(0);
  expect(scopes.system.metadata.sha256).toHaveLength(64);
  expect(scopes.tools.metadata.sources.length).toBeGreaterThan(0);
});

test('never extracts conversation, tool-output, auth fields, or system image bodies as raw text', () => {
  const scopes = extractTraceScopes({
    instructions: 'SYSTEM',
    api_key: 'PRIVATE key',
    messages: [
      { role: 'user', content: 'PRIVATE user' },
      { role: 'tool', content: 'PRIVATE tool' },
      {
        role: 'system',
        content: [
          { type: 'image', data: 'PRIVATE image' },
          { type: 'text', text: 'SYSTEM text' },
        ],
      },
    ],
  });
  expect(scopes.system.text).not.toContain('PRIVATE');
  expect(scopes.tools.text).not.toContain('PRIVATE');
  expect(extractTraceScopes({ arbitrary: 'PRIVATE arbitrary' }).system.text).toBe('');
});

test('additional tool declarations are tool scope, not raw system text', () => {
  const scopes = extractTraceScopes({
    input: [{ type: 'additional_tools', role: 'developer', tools: [{ name: 'added' }] }],
  });
  expect(scopes.tools.text).toContain('added');
  expect(scopes.system.text).toBe('');
});
