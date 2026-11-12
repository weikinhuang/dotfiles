/**
 * RPC contract between the secret-redactor server part (implements it) and
 * its TUI part (calls it from the `/secret-redactor` dialog). Plain JSON
 * Schema; inputs are narrowed by `parseSecretRedactorRpcInput`.
 */

import { Rpc } from '@opencode/plugin/rpc';

const sessionInput = {
  type: 'object',
  properties: { sessionID: { type: 'string' } },
  required: ['sessionID'],
  additionalProperties: false,
} as const;

export const SecretRedactorRpc = Rpc.define({
  id: 'dotfiles-secret-redactor',
  methods: {
    status: {
      input: sessionInput,
      output: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          secrets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                handle: { type: 'string' },
                label: { type: 'string' },
                state: { type: 'string' },
              },
              required: ['handle', 'label', 'state'],
            },
          },
        },
        required: ['summary', 'secrets'],
      },
    },
    reveal: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' }, handle: { type: 'string' } },
        required: ['sessionID', 'handle'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { handle: { type: 'string' }, label: { type: 'string' } },
        required: ['handle', 'label'],
      },
      errors: {
        not_found: {
          type: 'object',
          properties: { handle: { type: 'string' } },
          required: ['handle'],
        },
      },
    },
  },
  events: {},
});
