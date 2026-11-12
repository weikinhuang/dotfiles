/**
 * RPC contract between the context-edit server part (owner of the
 * directive store) and its TUI part (the `/context-edit` picker).
 * JSON Schema only, so inputs arrive as `unknown` and are validated by
 * the helpers in lib/node/opencode/context-edit.ts.
 */

import { Rpc } from '@opencode/plugin/rpc';

const SESSION = { type: 'string', minLength: 1 } as const;

const ROW = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    kind: { type: 'string', enum: ['collapse', 'trim'] },
    label: { type: 'string' },
    bytes: { type: 'number' },
  },
  required: ['key', 'kind', 'label', 'bytes'],
  additionalProperties: false,
} as const;

const DIRECTIVE = {
  type: 'object',
  properties: {
    id: { type: 'number' },
    kind: { type: 'string', enum: ['collapse', 'trim'] },
    label: { type: 'string' },
    stale: { type: 'boolean' },
  },
  required: ['id', 'kind', 'label', 'stale'],
  additionalProperties: false,
} as const;

const RESULT = {
  type: 'object',
  properties: { changed: { type: 'number' }, message: { type: 'string' } },
  required: ['changed', 'message'],
  additionalProperties: false,
} as const;

export const ContextEditRpc = Rpc.define({
  id: 'dotfiles.context-edit',
  methods: {
    /** Candidates (heaviest first) and active directives for a session. */
    list: {
      input: {
        type: 'object',
        properties: { sessionID: SESSION },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          candidates: { type: 'array', items: ROW },
          directives: { type: 'array', items: DIRECTIVE },
        },
        required: ['candidates', 'directives'],
        additionalProperties: false,
      },
    },
    /** Collapse / trim the candidates with these keys. */
    apply: {
      input: {
        type: 'object',
        properties: {
          sessionID: SESSION,
          keys: { type: 'array', items: { type: 'string' }, minItems: 1 },
          reason: { type: 'string' },
        },
        required: ['sessionID', 'keys'],
        additionalProperties: false,
      },
      output: RESULT,
    },
    /** Remove directives by id, or all of them when `ids` is omitted. */
    restore: {
      input: {
        type: 'object',
        properties: {
          sessionID: SESSION,
          ids: { type: 'array', items: { type: 'number' } },
        },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: RESULT,
    },
  },
  events: {
    /** The directive set of a session changed (from the TUI or a model tool). */
    changed: {
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          count: { type: 'number' },
          source: { type: 'string', enum: ['tool', 'rpc'] },
          message: { type: 'string' },
        },
        required: ['sessionID', 'count', 'source', 'message'],
        additionalProperties: false,
      },
    },
  },
});
