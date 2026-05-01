/**
 * Tests for lib/node/pi/tool-arg-recovery.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';
import {
  buildCorrectedExample,
  buildRecoveryBlock,
  describeSchema,
  exampleValue,
  parseValidationFailure,
  resolveSchemaPath,
  type SchemaNode,
} from '../../../../lib/node/pi/tool-arg-recovery.ts';

// ──────────────────────────────────────────────────────────────────────
// parseValidationFailure
// ──────────────────────────────────────────────────────────────────────

describe('parseValidationFailure', () => {
  test('parses single-issue failure with received JSON', () => {
    const raw = [
      'Validation failed for tool "todo":',
      '  - id: Expected number',
      '',
      'Received arguments:',
      '{',
      '  "action": "start",',
      '  "id": "1"',
      '}',
    ].join('\n');

    const out = parseValidationFailure(raw);

    expect(out).toBeDefined();
    expect(out?.toolName).toBe('todo');
    expect(out?.issues).toEqual([{ path: 'id', message: 'Expected number' }]);
    expect(out?.received).toEqual({ action: 'start', id: '1' });
  });

  test('parses multi-issue failure', () => {
    const raw = [
      'Validation failed for tool "scratchpad":',
      '  - action: Expected one of "list" | "append" | "update" | "remove" | "clear"',
      '  - body: Required property',
      '',
      'Received arguments:',
      '{ "action": "add" }',
    ].join('\n');

    const out = parseValidationFailure(raw);

    expect(out?.issues).toHaveLength(2);
    expect(out?.issues[0].path).toBe('action');
    expect(out?.issues[1].path).toBe('body');
    expect(out?.issues[1].message).toBe('Required property');
    expect(out?.received).toEqual({ action: 'add' });
  });

  test('tolerates leading blank lines', () => {
    const raw = '\n\n' + 'Validation failed for tool "bash":\n  - command: Required property\n';
    const out = parseValidationFailure(raw);

    expect(out?.toolName).toBe('bash');
    expect(out?.issues[0].path).toBe('command');
  });

  test('leaves `received` undefined when JSON is malformed', () => {
    const raw = [
      'Validation failed for tool "todo":',
      '  - id: Expected number',
      '',
      'Received arguments:',
      '{ this is not json }',
    ].join('\n');

    const out = parseValidationFailure(raw);

    expect(out?.toolName).toBe('todo');
    expect(out?.received).toBeUndefined();
    expect(out?.receivedRaw).toContain('this is not json');
  });

  test('returns undefined for unrelated errors', () => {
    expect(parseValidationFailure('Command exited with code 1')).toBeUndefined();
    expect(parseValidationFailure('Tool foo not found')).toBeUndefined();
    expect(parseValidationFailure('')).toBeUndefined();
    expect(parseValidationFailure(undefined)).toBeUndefined();
  });

  test('returns undefined when the header exists but no issue lines follow', () => {
    expect(parseValidationFailure('Validation failed for tool "x":\n\nReceived arguments:\n{}')).toBeUndefined();
  });

  test('handles nested paths (dotted / numeric)', () => {
    const raw = [
      'Validation failed for tool "todo":',
      '  - items.0.body: Expected string',
      '  - items.1.id: Expected number',
      '',
      'Received arguments:',
      '{ "items": [{ "body": 1 }, { "id": "a" }] }',
    ].join('\n');

    const out = parseValidationFailure(raw);

    expect(out?.issues.map((i) => i.path)).toEqual(['items.0.body', 'items.1.id']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveSchemaPath / describeSchema / exampleValue
// ──────────────────────────────────────────────────────────────────────

const todoSchema: SchemaNode = {
  type: 'object',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['list', 'add', 'start', 'complete'] },
    id: { type: 'number', description: 'Todo ID' },
    text: { type: 'string', description: 'Todo text' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          body: { type: 'string' },
          id: { type: 'number' },
        },
        required: ['body'],
      },
    },
  },
};

describe('resolveSchemaPath', () => {
  test('returns the root when path is empty or "root"', () => {
    expect(resolveSchemaPath(todoSchema, 'root')).toBe(todoSchema);
    expect(resolveSchemaPath(todoSchema, '')).toBe(todoSchema);
  });

  test('walks properties', () => {
    expect(resolveSchemaPath(todoSchema, 'id')?.type).toBe('number');
  });

  test('walks array indices into `items`', () => {
    expect(resolveSchemaPath(todoSchema, 'items.0.body')?.type).toBe('string');
  });

  test('returns undefined for unknown path', () => {
    expect(resolveSchemaPath(todoSchema, 'nope')).toBeUndefined();
    expect(resolveSchemaPath(todoSchema, 'id.what')).toBeUndefined();
  });

  test('returns undefined when schema is undefined', () => {
    expect(resolveSchemaPath(undefined, 'x')).toBeUndefined();
  });
});

describe('describeSchema', () => {
  test('enums render as union of JSON literals', () => {
    expect(describeSchema(todoSchema.properties?.action)).toBe('"list" | "add" | "start" | "complete"');
  });

  test('primitives render as their type', () => {
    expect(describeSchema({ type: 'number' })).toBe('number');
    expect(describeSchema({ type: 'boolean' })).toBe('boolean');
  });

  test('array renders as items[]', () => {
    expect(describeSchema(todoSchema.properties?.items)).toBe('object[]');
  });

  test('unknown → (unknown)', () => {
    expect(describeSchema(undefined)).toBe('(unknown)');
    expect(describeSchema({})).toBe('(unknown)');
  });

  test('anyOf / oneOf renders as union', () => {
    expect(describeSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe('string | number');
  });
});

describe('exampleValue', () => {
  test('enum returns first value', () => {
    expect(exampleValue(todoSchema.properties?.action)).toBe('list');
  });

  test('number → 0', () => {
    expect(exampleValue({ type: 'number' })).toBe(0);
  });

  test('object includes required children', () => {
    const ex = exampleValue(todoSchema.properties?.items?.items) as { body: unknown };

    expect(ex).toHaveProperty('body');
    // `id` is not required, so it should be absent.
    expect(Object.keys(ex)).toEqual(['body']);
  });

  test('string with description uses first word as placeholder', () => {
    expect(exampleValue({ type: 'string', description: 'Todo text here' })).toBe('<Todo>');
  });

  test('deeply nested stops at depth', () => {
    const recursive: SchemaNode = { type: 'object' };
    recursive.properties = { child: recursive };
    recursive.required = ['child'];
    const ex = exampleValue(recursive);

    expect(ex).toBeDefined();
    // Just ensure it doesn't blow the stack.
    expect(typeof ex).toBe('object');
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildCorrectedExample
// ──────────────────────────────────────────────────────────────────────

describe('buildCorrectedExample', () => {
  test('replaces the wrong type at the failing path', () => {
    const failure = parseValidationFailure(
      [
        'Validation failed for tool "todo":',
        '  - id: Expected number',
        '',
        'Received arguments:',
        '{ "action": "start", "id": "1" }',
      ].join('\n'),
    );

    expect(failure).toBeDefined();

    const ex = buildCorrectedExample(failure!, todoSchema) as Record<string, unknown>;

    expect(ex.action).toBe('start');
    expect(ex.id).toBe(0); // schema says number → default 0
  });

  test('fills in missing required root properties', () => {
    const failure = parseValidationFailure(
      ['Validation failed for tool "todo":', '  - action: Required property', '', 'Received arguments:', '{}'].join(
        '\n',
      ),
    );

    expect(failure).toBeDefined();

    const ex = buildCorrectedExample(failure!, todoSchema) as Record<string, unknown>;

    expect(ex.action).toBe('list');
  });

  test('when received is not an object, synthesizes from schema', () => {
    const failure = parseValidationFailure(
      ['Validation failed for tool "todo":', '  - root: Expected object', '', 'Received arguments:', '"bogus"'].join(
        '\n',
      ),
    );

    expect(failure).toBeDefined();

    const ex = buildCorrectedExample(failure!, todoSchema) as Record<string, unknown>;

    expect(ex.action).toBe('list');
  });

  test('handles nested numeric paths', () => {
    const failure = parseValidationFailure(
      [
        'Validation failed for tool "todo":',
        '  - items.0.body: Expected string',
        '',
        'Received arguments:',
        '{ "items": [{ "body": 123 }] }',
      ].join('\n'),
    );

    expect(failure).toBeDefined();

    const ex = buildCorrectedExample(failure!, todoSchema) as { items: { body: unknown }[] };

    expect(typeof ex.items[0].body).toBe('string');
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildRecoveryBlock
// ──────────────────────────────────────────────────────────────────────

describe('buildRecoveryBlock', () => {
  test('renders marker, problems list, and corrected example when schema is provided', () => {
    const failure = parseValidationFailure(
      [
        'Validation failed for tool "todo":',
        '  - id: Expected number',
        '',
        'Received arguments:',
        '{ "action": "start", "id": "1" }',
      ].join('\n'),
    );

    expect(failure).toBeDefined();

    const block = buildRecoveryBlock(failure!, todoSchema);

    expect(block).toContain('pi-tool-arg-recovery');
    expect(block).toContain('tool=todo');
    expect(block).toContain('`id`: Expected number');
    expect(block).toContain('expected number');
    expect(block).toContain('got `"1"` (string)');
    expect(block).toContain('```json');
    expect(block).toContain('"id": 0');
  });

  test('omits the corrected-example block when no schema is available', () => {
    const failure = parseValidationFailure(
      [
        'Validation failed for tool "mystery":',
        '  - foo: Expected string',
        '',
        'Received arguments:',
        '{ "foo": 1 }',
      ].join('\n'),
    );

    expect(failure).toBeDefined();

    const block = buildRecoveryBlock(failure!, undefined);

    expect(block).toContain('tool=mystery');
    expect(block).toContain('`foo`: Expected string');
    expect(block).not.toContain('```json');
  });

  test('honors `marker` + `maxExampleChars` options', () => {
    const failure = parseValidationFailure(
      ['Validation failed for tool "todo":', '  - id: Expected number', '', 'Received arguments:', '{}'].join('\n'),
    );

    expect(failure).toBeDefined();

    const block = buildRecoveryBlock(failure!, todoSchema, { marker: '!! TEST', maxExampleChars: 5 });

    expect(block).toContain('!! TEST');
    // Example was >5 chars so the fenced block is omitted.
    expect(block).not.toContain('```json');
  });

  test('includes "do not retry" footer', () => {
    const failure = parseValidationFailure(
      ['Validation failed for tool "todo":', '  - id: Expected number', '', 'Received arguments:', '{}'].join('\n'),
    );
    const block = buildRecoveryBlock(failure!, todoSchema);

    expect(block.toLowerCase()).toContain('do not retry');
  });
});
