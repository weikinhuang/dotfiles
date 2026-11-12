/**
 * RPC contract between the cost-guard server part (implements it) and the
 * TUI part (subscribes to `update`, calls `status`). See ./README.md.
 *
 * JSON Schema keeps `effect` out of the plugin; payloads arrive untyped and
 * are validated by `parseUpdateEvent` / `parseStatusInput` in
 * lib/node/opencode/cost-guard.ts.
 */

import { Rpc } from '@opencode/plugin/rpc';

const LEVEL = { type: 'string', enum: ['ok', 'warning', 'critical'] } as const;

export const CostGuardRpc = Rpc.define({
  id: 'dotfiles.cost-guard',
  methods: {
    /** Current state of a session's tree; `known: false` until the server has observed or replayed it. */
    status: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          known: { type: 'boolean' },
          status: LEVEL,
          totalDollars: { type: 'number' },
        },
        required: ['sessionID', 'known', 'status', 'totalDollars'],
        additionalProperties: false,
      },
    },
  },
  events: {
    /** Pushed once per response with new notices, or when the status level changes. */
    update: {
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          status: LEVEL,
          totalDollars: { type: 'number' },
          message: { type: 'string' },
          variant: { type: 'string', enum: ['warning', 'error'] },
        },
        required: ['sessionID', 'status', 'totalDollars'],
        additionalProperties: false,
      },
    },
  },
});
