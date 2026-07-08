/**
 * Pure validation for the `memory save` action.
 *
 * Extracted from `config/pi/extensions/memory.ts`'s `actSave` closure so
 * the validate-then-normalize chain is unit-testable without the pi
 * runtime or disk I/O. The extension shell keeps the impure parts
 * (slug choice, timestamps, `atomicWriteFile`, index rewrite,
 * `pi.appendEntry`) and only delegates the decision of "are these save
 * params well-formed, and what are the resolved scope/type/trimmed
 * fields?" to here.
 *
 * The chain and its exact error strings mirror the original closure
 * byte-for-byte: `content` is the full user-facing message (already
 * prefixed with `Error: `) and `error` is the short reason stored in the
 * tool-result `details.error`. The two intentionally differ for the four
 * required-field checks (`content` appends ` for \`save\``), so both are
 * returned rather than reconstructed at the call site.
 */

import {
  defaultMemoryScope,
  defaultMemoryTypeForScope,
  isMemoryTypeAllowedInScope,
  type MemoryScope,
  type MemoryType,
} from '../memory-reducer.ts';

/** The subset of the `memory` tool params that `save` validation reads. */
export interface SaveParamsInput {
  type?: MemoryType;
  scope?: MemoryScope;
  name?: string;
  description?: string;
  body?: string;
}

/** A validated, fully-resolved save request (all strings trimmed). */
export interface ValidatedSave {
  ok: true;
  type: MemoryType;
  scope: MemoryScope;
  name: string;
  description: string;
  body: string;
}

/** A rejected save request; `content` is the tool message, `error` the `details.error`. */
export interface RejectedSave {
  ok: false;
  content: string;
  error: string;
}

export type SaveValidation = ValidatedSave | RejectedSave;

const reject = (content: string, error: string): RejectedSave => ({ ok: false, content, error });

/**
 * Validate + normalize a `memory save` request.
 *
 * `sessionId` is the current session id (or `null` under `--no-session`)
 * so session-scoped saves can be rejected with a clear error. Pure: no
 * disk access, no clock; the shell supplies both.
 */
export function validateSaveParams(params: SaveParamsInput, sessionId: string | null): SaveValidation {
  // Resolve scope+type together so an explicit `scope: session` can
  // default `type` to `note` (the only type valid there).
  const type = params.type ?? (params.scope ? defaultMemoryTypeForScope(params.scope) : undefined);
  if (!type) {
    return reject('Error: `type` is required for `save`', '`type` is required');
  }
  if (!params.name || params.name.trim().length === 0) {
    return reject('Error: `name` is required for `save`', '`name` is required');
  }
  const description = (params.description ?? '').trim();
  if (description.length === 0) {
    return reject(
      'Error: `description` is required for `save` (used as the one-line hook in MEMORY.md)',
      '`description` is required',
    );
  }
  const body = (params.body ?? '').trim();
  if (body.length === 0) {
    return reject('Error: `body` is required for `save`', '`body` is required');
  }
  const scope = params.scope ?? defaultMemoryScope(type);
  if (!isMemoryTypeAllowedInScope(type, scope)) {
    const error = `type "${type}" cannot be saved in scope "${scope}"`;
    return reject(`Error: ${error}`, error);
  }
  if (scope === 'session' && !sessionId) {
    const error =
      'session memory is disabled: no active session id (running pi with --no-session?). Use scope `project` for durable notes instead.';
    return reject(`Error: ${error}`, error);
  }
  return { ok: true, type, scope, name: params.name.trim(), description, body };
}
