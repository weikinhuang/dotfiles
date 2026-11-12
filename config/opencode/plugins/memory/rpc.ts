/**
 * RPC contract between the memory server part (owner of the store config
 * and per-session delivery state) and its TUI part (the `/memory` dialog).
 * Inputs arrive as `unknown` and are validated in lib/node/opencode/memory.ts.
 */

import { Rpc } from '@opencode/plugin/rpc';

export const MemoryRpc = Rpc.define({
  id: 'dotfiles.memory',
  methods: {
    /** Text for one `/memory` view of a session. */
    report: {
      input: {
        type: 'object',
        properties: {
          sessionID: { type: 'string', minLength: 1 },
          view: { type: 'string', enum: ['list', 'preview', 'dir', 'stale'] },
        },
        required: ['sessionID', 'view'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
