/**
 * tool-rescue extension for pi.
 *
 * A weak / local model sometimes emits a tool call as literal text in its reply
 * instead of as a real function call (`generate_image(prompt="...")` or
 * `<schedule action="create" .../>`), so the harness never runs it and the raw
 * call text breaks frame. On `message_end`, this extension parses such a leaked
 * call, strips the literal text from the message, and appends a real tool-call
 * block so the agent loop executes the tool normally.
 *
 * OPT-IN, default no-op. A tool is only rescued when it is (1) listed in the
 * `tool-rescue.json` allowlist, (2) currently active, and (3) not on the
 * built-in HARD-DENY list of execute/mutate tools (`bash`, `bg_bash`, `edit`,
 * `write`, `apply_patch`). The denylist is the load-bearing safety boundary: a
 * prose-leaked destructive call is never auto-run even if the allowlist lists
 * it.
 *
 * Parsing, the spec-from-live-schema derivation, the denylist, and the config
 * loader live in `lib/node/pi/tool-rescue.ts` and are unit-tested without the pi
 * runtime.
 *
 * Environment:
 *   PI_TOOL_RESCUE_ENABLED=1   opt in (OFF by default). Unlike the read-side,
 *     non-destructive `strip-reasoning` overlay (active-by-default kill-switch),
 *     tool-rescue AUTO-EXECUTES a tool the model only named in prose, so it must
 *     be an explicit per-launch opt-in (RP / eval launchers export it) rather
 *     than fire in a plain dev session sharing the same project `.pi/`.
 *
 * Config (`tool-rescue.json`):
 *   { "tools": ["generate_image"] }
 */

import { randomUUID } from 'node:crypto';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import {
  loadToolRescueConfig,
  parseLeakedCall,
  resolveRescueTools,
  specFromToolInfo,
  stripCall,
  type ToolInfoLike,
  type ToolSpec,
} from '../../../lib/node/pi/tool-rescue.ts';

export default function toolRescueExtension(pi: ExtensionAPI): void {
  // OFF by default; opt in per-launch (RP / eval launchers export PI_TOOL_RESCUE_ENABLED=1).
  if (!envTruthy(process.env.PI_TOOL_RESCUE_ENABLED)) return;

  let warnedDenied = false;

  pi.on('message_end', (event, ctx) => {
    const msg = event.message;
    if (msg?.role !== 'assistant') return undefined;

    const content = msg.content as unknown as Record<string, unknown>[];
    if (!Array.isArray(content)) return undefined;

    const textParts = content.filter((p) => p.type === 'text');
    if (textParts.length === 0) return undefined;
    const joined = textParts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n');

    // Resolve the opt-in allowlist, then subtract the HARD-DENY tools. The
    // denylist is enforced here, not just in config, so a leaked destructive
    // call is never auto-executed even if the allowlist mistakenly lists it.
    const cwd = (ctx as ExtensionContext & { cwd?: string })?.cwd ?? process.cwd();
    const { tools: configured } = loadToolRescueConfig(cwd);
    const { allowed, denied } = resolveRescueTools(configured);
    if (denied.length > 0 && !warnedDenied) {
      warnedDenied = true;
      console.warn(
        `[tool-rescue] ignoring denylisted tool(s) in allowlist: ${denied.join(', ')} ` +
          '(execute/mutate tools are never auto-rescued from prose).',
      );
    }
    if (allowed.length === 0) return undefined;
    const rescue = new Set(allowed);

    // Cheap pre-check: skip the getAllTools() call on the overwhelming majority
    // of messages that mention no rescue tool by name.
    if (![...rescue].some((t) => joined.includes(t))) return undefined;

    let active: string[] = [];
    try {
      active = pi.getActiveTools();
    } catch {
      active = [];
    }

    // Build a parse spec for each active, rescue-listed tool from its live schema.
    let allTools: ToolInfoLike[] = [];
    try {
      allTools = pi.getAllTools() as ToolInfoLike[];
    } catch {
      allTools = [];
    }
    const infoByName = new Map(allTools.map((t) => [t.name, t]));
    const specs: ToolSpec[] = [];
    for (const name of active) {
      if (!rescue.has(name)) continue;
      const info = infoByName.get(name);
      const spec = info && specFromToolInfo(info);
      if (spec) specs.push(spec);
    }

    // Earliest leaked call among tools not already fired in this message wins.
    let best: { spec: ToolSpec; parsed: ReturnType<typeof parseLeakedCall> } | null = null;
    for (const spec of specs) {
      const alreadyFired = content.some((p) => p.type === 'toolCall' && p.name === spec.tool);
      if (alreadyFired) continue;
      const parsed = parseLeakedCall(joined, spec);
      if (!parsed) continue;
      if (!best || (best.parsed && parsed.start < best.parsed.start)) best = { spec, parsed };
    }
    if (!best?.parsed) return undefined;

    // Strip the literal call from the combined text, collapse to a single text
    // block, then append a real tool-call block.
    const stripped = stripCall(joined, best.parsed.start, best.parsed.end);
    const nonText = content.filter((p) => p.type !== 'text');
    const newContent: Record<string, unknown>[] = [];
    if (stripped) newContent.push({ type: 'text', text: stripped });
    for (const p of nonText) newContent.push(p);
    newContent.push({
      type: 'toolCall',
      id: `call_${randomUUID()}`,
      name: best.spec.tool,
      arguments: best.parsed.args,
    });

    const replacement = { ...(msg as unknown as Record<string, unknown>), content: newContent, stopReason: 'toolUse' };
    return { message: replacement as unknown as typeof msg };
  });
}
