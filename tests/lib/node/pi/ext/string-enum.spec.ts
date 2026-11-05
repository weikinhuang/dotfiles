import { validateToolArguments } from '@earendil-works/pi-ai';
import { Type, type Static } from 'typebox';
import { describe, expect, expectTypeOf, test } from 'vitest';

import { StringEnum } from '../../../../../lib/node/pi/ext/string-enum.ts';

describe('TypeBox-compatible StringEnum', () => {
  test('preserves a plain string enum without anyOf or const', () => {
    const schema = StringEnum(['list', 'save'] as const);

    expectTypeOf<Static<typeof schema>>().toEqualTypeOf<'list' | 'save'>();
    expect(JSON.parse(JSON.stringify(schema)) as unknown).toEqual({ type: 'string', enum: ['list', 'save'] });
  });

  test('preserves description and default annotations', () => {
    const schema = StringEnum(['sh', 'bash'] as const, { description: 'Shell to run', default: 'sh' });

    expect(JSON.parse(JSON.stringify(schema)) as unknown).toEqual({
      type: 'string',
      enum: ['sh', 'bash'],
      description: 'Shell to run',
      default: 'sh',
    });
  });

  test('keeps SDK validation of required and optional enum arguments', () => {
    const tool = {
      name: 'enum-test',
      description: 'Check enum arguments',
      parameters: Type.Object({
        action: StringEnum(['start', 'list'] as const),
        shell: Type.Optional(StringEnum(['sh', 'bash'] as const)),
      }),
    };
    const call = { type: 'toolCall' as const, id: 'call-1', name: tool.name, arguments: { action: 'start' } };

    expect(validateToolArguments(tool, call)).toEqual({ action: 'start' });
    expect(validateToolArguments(tool, { ...call, arguments: { action: 'start', shell: 'bash' } })).toEqual({
      action: 'start',
      shell: 'bash',
    });
    expect((): void => {
      validateToolArguments(tool, { ...call, arguments: {} });
    }).toThrow('action: missing');
    expect((): void => {
      validateToolArguments(tool, { ...call, arguments: { action: 'invalid' } });
    }).toThrow('action: expected one of');
    expect((): void => {
      validateToolArguments(tool, { ...call, arguments: { action: 'start', shell: 'invalid' } });
    }).toThrow('shell: expected one of');
  });

  test('retains literal unions and optional properties inside TypeBox objects', () => {
    const schema = Type.Object({
      action: StringEnum(['start', 'list'] as const),
      shell: Type.Optional(StringEnum(['sh', 'bash'] as const)),
    });

    expectTypeOf<Static<typeof schema>>().toEqualTypeOf<{
      action: 'start' | 'list';
      shell?: 'sh' | 'bash';
    }>();
    expect(schema.required).toEqual(['action']);
    expect(JSON.parse(JSON.stringify(schema.properties.shell)) as unknown).toEqual({
      type: 'string',
      enum: ['sh', 'bash'],
    });
  });
});
