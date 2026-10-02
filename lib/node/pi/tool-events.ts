/** Minimal tool-event shape shared by extension hook helpers. */
export interface ToolEventMetadata<T = unknown> {
  parentToolCallId?: string;
  structuredContent?: T;
}

/** Whether a tool event came from another tool through `ctx.executeTool()`. */
export function isNestedToolEvent(event: Pick<ToolEventMetadata, 'parentToolCallId'>): boolean {
  return event.parentToolCallId !== undefined;
}

/**
 * Preserve a tool result's machine-readable value when replacing its text.
 *
 * Pi v1 drops existing structured content when a `tool_result` hook returns
 * replacement `content` without explicitly returning `structuredContent`.
 * Omit the property when the source result did not contain one.
 */
export function preserveStructuredContent<T>(event: Pick<ToolEventMetadata<T>, 'structuredContent'>): {
  structuredContent?: T;
} {
  return event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent };
}
