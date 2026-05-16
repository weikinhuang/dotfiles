/**
 * Tool-output-condenser extension for pi - tighter head+tail truncation
 * for noisy tool results so they don't eat the session.
 *
 * Pi's built-in bash / rg / grep tools already truncate at 50KB / 2000
 * lines, which is fine for "don't crash the process" but loose for
 * "don't burn 10k tokens per turn on log noise". This extension
 * intercepts `tool_result` for configurable tools (bash by default)
 * and, when the content exceeds a configurable head+tail budget,
 * rewrites the SESSION-STORED result to a condensed head+tail+marker
 * view while stashing the full output to a tempfile the model can
 * re-`read` with `--offset / --limit` if it truly needs more.
 *
 * The compounding win matters: smaller session ⇒ less frequent
 * compaction ⇒ the todo / scratchpad auto-injection stays visible
 * across more turns. For weak models chained across many bash / rg
 * calls this is one of the biggest wins available.
 *
 * Design notes:
 *
 *   - We hook `tool_result` (not `tool_call`), so the command still
 *     executes with full output. The full output is preserved on disk
 *     for the model to retrieve; only the SESSION copy gets condensed.
 *     That means no behavior change in what the user sees in the TUI
 *     at the moment the call completes (pi renders `content` from the
 *     event, which we return patched).
 *
 *   - We only touch text-content parts. Image parts pass through
 *     unchanged (and are rare in tool output anyway).
 *
 *   - We coexist cleanly with pi's own truncation: if pi already
 *     truncated the output and stored a `fullOutputPath` in details,
 *     we POINT at that path instead of writing a new tempfile. The
 *     model therefore sees a single breadcrumb, not two competing
 *     ones.
 *
 *   - We do NOT touch results that the built-in bash tool already
 *     condensed BELOW our budget. Double-truncation would just waste
 *     cycles.
 *
 *   - Errors during tempfile writing are logged via ctx.ui.notify
 *     (warning level) but do not block - we fall back to returning
 *     the condensed text without the "full output saved to" pointer.
 *
 * Pure logic (line counting, head/tail windowing, budget accounting,
 * tool-name allowlist parsing) lives in `./lib/output-condense.ts` so
 * it can be unit-tested under `vitest`.
 *
 * Environment:
 *   PI_CONDENSER_DISABLED=1          skip the extension entirely
 *   PI_CONDENSER_TOOLS=t1,t2,…       comma list of tool names to
 *                                    condense (default: bash)
 *   PI_CONDENSER_MAX_BYTES=N         byte cap on the condensed body
 *                                    (default 12288 = 12 KB)
 *   PI_CONDENSER_MAX_LINES=N         line cap on the condensed body
 *                                    (default 400)
 *   PI_CONDENSER_HEAD_LINES=N        lines kept from the head
 *                                    (default 80)
 *   PI_CONDENSER_TAIL_LINES=N        lines kept from the tail
 *                                    (default 80)
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import { condense, type CondenseOptions, parseToolList } from '../../../lib/node/pi/output-condense.ts';

const DEFAULT_TOOLS = ['bash'] as const;
const MARKER_HEADER = '⟨ [pi-tool-output-condenser] ⟩';

function parseIntEnv(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < minimum) return fallback;
  return n;
}

function extractFullOutputPath(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const path = (details as { fullOutputPath?: unknown }).fullOutputPath;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

async function writeFullOutputFile(text: string, toolName: string, _ctx: ExtensionContext): Promise<string> {
  const prefix = join(tmpdir(), `pi-${toolName}-condensed-`);
  const dir = await mkdtemp(prefix);
  const file = join(dir, 'output.txt');
  try {
    await writeFile(file, text, 'utf8');
  } catch (err) {
    // Don't orphan the mkdtemp dir if the write fails.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return file;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function buildBanner(
  result: { originalBytes: number; originalLines: number; outputBytes: number; outputLines: number },
  fullOutputPath: string | undefined,
  toolName: string,
): string {
  const savedLines = result.originalLines - result.outputLines;
  const savedBytes = result.originalBytes - result.outputBytes;
  const parts = [
    MARKER_HEADER,
    `${toolName} output was condensed: kept ${result.outputLines} of ${result.originalLines} lines`,
    `(${formatSize(result.outputBytes)} of ${formatSize(result.originalBytes)}); omitted ${savedLines} lines (${formatSize(savedBytes)}).`,
  ];
  if (fullOutputPath) {
    parts.push(
      `Full output saved to: ${fullOutputPath} - re-read with the \`read\` tool (\`offset\` / \`limit\`) if you need specific lines.`,
    );
  } else {
    parts.push(
      'Full output was not written to a tempfile (I/O error). Re-run the command if you need the complete text.',
    );
  }
  return parts.join(' ');
}

export default function toolOutputCondenser(pi: ExtensionAPI): void {
  if (process.env.PI_CONDENSER_DISABLED === '1') return;

  const tools = parseToolList(process.env.PI_CONDENSER_TOOLS, DEFAULT_TOOLS);
  const options: CondenseOptions = {
    maxBytes: parseIntEnv('PI_CONDENSER_MAX_BYTES', 12 * 1024, 512),
    maxLines: parseIntEnv('PI_CONDENSER_MAX_LINES', 400, 20),
    headLines: parseIntEnv('PI_CONDENSER_HEAD_LINES', 80, 1),
    tailLines: parseIntEnv('PI_CONDENSER_TAIL_LINES', 80, 1),
  };

  pi.on('tool_result', async (event, ctx) => {
    const toolName = (event as { toolName?: string }).toolName;
    if (typeof toolName !== 'string') return undefined;
    if (!tools.has(toolName.toLowerCase())) return undefined;

    // event.content is an array of content parts. We only condense
    // text parts - image parts pass through unchanged.
    const content = (event as { content?: unknown }).content;
    if (!Array.isArray(content) || content.length === 0) return undefined;

    let firstTextIdx = -1;
    let firstTextValue = '';
    for (let i = 0; i < content.length; i++) {
      const part = content[i] as { type?: unknown; text?: unknown } | undefined;
      if (part && part.type === 'text' && typeof part.text === 'string') {
        firstTextIdx = i;
        firstTextValue = part.text;
        break;
      }
    }
    if (firstTextIdx === -1) return undefined;

    const result = condense(firstTextValue, options);
    if (!result.truncated) return undefined;

    // Reuse pi's own fullOutputPath if the built-in already wrote one -
    // avoids leaving two breadcrumbs / two tempfiles for the same call.
    let fullOutputPath = extractFullOutputPath((event as { details?: unknown }).details);
    if (!fullOutputPath) {
      fullOutputPath = await writeFullOutputFile(firstTextValue, toolName, ctx).catch((err) => {
        if (ctx.hasUI) ctx.ui.notify(`tool-output-condenser: failed to write tempfile: ${String(err)}`, 'warning');
        return undefined;
      });
    }

    // Build the breadcrumb the model sees: condensed text + footer
    // explaining what happened and where to find the rest.
    const banner = buildBanner(result, fullOutputPath, toolName);
    const replacementText = `${result.text}\n\n${banner}`;

    const newContent = content.slice();
    const original = newContent[firstTextIdx] as Record<string, unknown>;
    newContent[firstTextIdx] = { ...original, type: 'text', text: replacementText };

    // Thread our bookkeeping onto `details` so downstream renderers /
    // debuggers can see what happened without parsing the text.
    const prevDetails =
      typeof (event as { details?: unknown }).details === 'object' && (event as { details?: unknown }).details !== null
        ? ((event as { details?: object }).details as Record<string, unknown>)
        : {};
    const newDetails: Record<string, unknown> = {
      ...prevDetails,
      condenser: {
        truncated: true,
        originalBytes: result.originalBytes,
        originalLines: result.originalLines,
        outputBytes: result.outputBytes,
        outputLines: result.outputLines,
        fullOutputPath: fullOutputPath ?? null,
      },
    };
    if (fullOutputPath && !('fullOutputPath' in prevDetails)) {
      newDetails.fullOutputPath = fullOutputPath;
    }

    return { content: newContent, details: newDetails };
  });
}
