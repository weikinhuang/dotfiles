/**
 * Shared `path`-argument extraction for read / write / edit tool-call events.
 *
 * The filesystem gate (`filesystem.ts`) and the subdir-agents context
 * injector (`subdir-agents.ts`) both need the target path from a
 * `tool_call` event, and each had a byte-identical local `getPathInput`.
 * This lives under `ext/` because it imports pi's `ToolCallEvent` /
 * `isToolCallEventType` type guard.
 */

import { isToolCallEventType, type ToolCallEvent } from '@earendil-works/pi-coding-agent';

/**
 * Pull the trimmed `path` argument out of a `read` / `write` / `edit`
 * tool-call event. Returns the empty string when the event is any other
 * tool, or when the input is missing / malformed (callers skip the event in
 * that case).
 */
export function getToolCallPathInput(event: ToolCallEvent): string {
  if (isToolCallEventType('read', event) || isToolCallEventType('write', event) || isToolCallEventType('edit', event)) {
    return String(event.input?.path ?? '').trim();
  }
  return '';
}
