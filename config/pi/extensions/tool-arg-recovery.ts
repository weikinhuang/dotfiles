/**
 * Tool-arg-recovery extension for pi.
 *
 * When the LLM calls a tool with arguments that fail the tool's
 * TypeBox schema, pi-ai throws a message of the form:
 *
 *   Validation failed for tool "<name>":
 *     - <path>: <message>
 *     - ...
 *
 *   Received arguments:
 *   { ... }
 *
 * Pi wraps that via `createErrorToolResult(error.message)` and fires
 * `tool_result` with `isError: true`. Small self-hosted models
 * (qwen3-30B-A3B, gpt-oss-20B, …) respond to that error text by
 * guessing at a fix and retrying the same shape — `id: "1"` instead
 * of `1`, missing required props, swapped `text`/`body`, etc. —
 * because the raw error tells them WHAT's wrong but not what a
 * working payload looks like.
 *
 * This extension hooks `tool_result`, detects validation failures,
 * resolves the active tool's TypeBox schema via `pi.getAllTools()`,
 * and appends a recovery block containing:
 *
 *   - each failed argument path + expected type + what was received
 *   - a concrete corrected-example JSON payload when a schema is
 *     available (placeholders like `<string>` / `0` where the model
 *     still has to supply real values)
 *   - a "do not retry with the same arguments" footer
 *
 * Pi's original error stays intact; we append our block as a second
 * text part, matching the pattern used by `edit-recovery`.
 *
 * Composition:
 *
 *   - We do NOT auto-retry — surfacing the mistake keeps
 *     `verify-before-claim` / `loop-breaker` / `stall-recovery`
 *     honest, and lets the model actually see what it got wrong.
 *   - Runs BEFORE `tool-output-condenser` (alphabetical extension
 *     load order) so the condenser sees the augmented content and
 *     can apply its budget if the block pushes us over.
 *
 * Pure logic (parser, schema walker, example synthesis, block
 * formatting) lives in `lib/node/pi/tool-arg-recovery.ts` so it can
 * be unit-tested under `vitest` without the pi runtime.
 *
 * Environment:
 *   PI_TOOL_ARG_RECOVERY_DISABLED=1     skip the extension entirely
 *   PI_TOOL_ARG_RECOVERY_DEBUG=1        ctx.ui.notify on each decision
 *   PI_TOOL_ARG_RECOVERY_TRACE=<path>   append one line per decision to
 *                                       <path> (useful in -p / RPC mode
 *                                       where notify is silent)
 *   PI_TOOL_ARG_RECOVERY_MAX_EXAMPLE_CHARS=N
 *                                       cap on the corrected-example JSON
 *                                       (default 1500; past the cap we
 *                                       skip the fenced block but keep
 *                                       the diagnosis)
 */

import { appendFileSync } from 'node:fs';

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import { buildRecoveryBlock, parseValidationFailure, type SchemaNode } from '../../../lib/node/pi/tool-arg-recovery.ts';

const DEFAULT_MAX_EXAMPLE_CHARS = 1500;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default function toolArgRecovery(pi: ExtensionAPI): void {
  if (process.env.PI_TOOL_ARG_RECOVERY_DISABLED === '1') return;

  const debug = process.env.PI_TOOL_ARG_RECOVERY_DEBUG === '1';
  const tracePath = process.env.PI_TOOL_ARG_RECOVERY_TRACE;
  const maxExampleChars = parsePositiveInt(
    process.env.PI_TOOL_ARG_RECOVERY_MAX_EXAMPLE_CHARS,
    DEFAULT_MAX_EXAMPLE_CHARS,
  );

  const trace = (msg: string): void => {
    if (!tracePath) return;
    try {
      appendFileSync(tracePath, `[tool-arg-recovery] ${msg}\n`, 'utf8');
    } catch {
      /* diagnostics must never break a turn */
    }
  };

  const notify = (ctx: ExtensionContext, msg: string): void => {
    if (debug && ctx.hasUI) ctx.ui.notify(msg, 'info');
  };

  const lookupSchema = (toolName: string): SchemaNode | undefined => {
    try {
      const tools = pi.getAllTools();
      const found = tools.find((t) => t.name === toolName);
      if (!found) return undefined;
      // ToolInfo.parameters is a TypeBox TSchema. At runtime these
      // share the JSON-Schema shape our SchemaNode duck-type expects
      // (type, properties, required, items, enum, anyOf/oneOf).
      return found.parameters as unknown as SchemaNode;
    } catch {
      return undefined;
    }
  };

  pi.on('tool_result', (event, ctx) => {
    if (!event.isError) return undefined;

    const first = event.content[0];
    if (!first || first.type !== 'text') return undefined;
    const errorText = first.text;

    const failure = parseValidationFailure(errorText);
    if (!failure) {
      trace(`skip: not a validation failure (tool=${event.toolName})`);
      return undefined;
    }

    const schema = lookupSchema(failure.toolName);
    const block = buildRecoveryBlock(failure, schema, { maxExampleChars });

    trace(
      `emit tool=${failure.toolName} issues=${failure.issues.length} schema=${schema ? 'yes' : 'no'} paths=[${failure.issues
        .map((i) => i.path)
        .join(',')}]`,
    );
    notify(
      ctx,
      `tool-arg-recovery: ${failure.toolName} (${failure.issues.length} issue${failure.issues.length === 1 ? '' : 's'})`,
    );

    return {
      content: [...event.content, { type: 'text', text: `\n${block}` }],
    };
  });
}
