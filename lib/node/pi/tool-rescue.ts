/**
 * tool-rescue core - recover a tool call a model emitted as literal text.
 *
 * Problem: a weak / local model reliably *decides* to call a tool, but after a
 * few turns of prose momentum it sometimes emits the call as literal text in
 * its reply instead of as a real function call, e.g.
 *
 *     generate_image(prompt="masterpiece, ...", negative="worst quality, ...")
 *     <schedule action="create" after="1h" prompt="..." />
 *
 * so the harness never runs it AND the raw call text breaks frame. This is an
 * output-format degradation, not a prompt gap.
 *
 * The fix is at the harness layer (the `message_end` hook): parse the literal
 * call's arguments, strip the literal text, and append a real tool-call block so
 * the agent loop executes the tool normally.
 *
 * This module is the pure logic: the quote/paren-aware locators, the argument
 * parser, the spec-from-live-schema derivation, the layered config loader, and
 * the HARD-DENY safety boundary. No pi imports - directly unit-testable.
 *
 * SAFETY: which tools are rescued is an opt-in allowlist, AND a built-in,
 * non-overridable denylist of execute/mutate tools is subtracted from it - so a
 * prose-leaked `bash(...)` / `edit(...)` is never auto-executed even if the
 * allowlist mistakenly lists it.
 */

import { readJsonOrUndefined } from './fs-safe.ts';
import { piAgentPath, piProjectPath } from './pi-paths.ts';

/**
 * Execute / mutate tools that must NEVER be auto-run from a prose leak,
 * regardless of the configured allowlist. The load-bearing safety boundary: a
 * leaked destructive call is dropped from the allowlist, not rescued.
 */
export const HARD_DENY: ReadonlySet<string> = new Set(['bash', 'bg_bash', 'edit', 'write', 'apply_patch']);

/** Per-tool rescue spec, derived from a tool's live parameter schema. */
export interface ToolSpec {
  tool: string;
  /** String-valued args to extract from the leaked call. */
  str: string[];
  /** Numeric-valued args to extract. */
  num: string[];
  /** Args that must all be present (non-empty strings) or the rescue is skipped. */
  required: string[];
}

/** Minimal shape of a registered tool's info from `pi.getAllTools()`. */
export interface ToolInfoLike {
  name: string;
  parameters?: unknown;
}

export interface ParsedCall {
  /** Index range of the literal call within the source text. */
  start: number;
  end: number;
  args: Record<string, unknown>;
}

/**
 * Derive a rescue ToolSpec from a tool's live parameter schema: string props ->
 * str args, number/integer props -> num args. `required` is the schema's
 * required list intersected with the string props (a leaked literal call only
 * carries scalar `key="value"` pairs, so gating on a non-scalar required field
 * would make rescue never fire). Returns null when the tool exposes no usable
 * object schema.
 */
export function specFromToolInfo(info: ToolInfoLike): ToolSpec | null {
  const params = info?.parameters as { properties?: Record<string, unknown>; required?: unknown } | undefined;
  const props = params?.properties;
  if (!props || typeof props !== 'object') return null;
  const str: string[] = [];
  const num: string[] = [];
  for (const [key, schema] of Object.entries(props)) {
    const rawType = (schema as { type?: unknown })?.type;
    const types = Array.isArray(rawType) ? rawType : [rawType];
    if (types.includes('string')) str.push(key);
    else if (types.includes('number') || types.includes('integer')) num.push(key);
  }
  const schemaRequired = Array.isArray(params?.required)
    ? (params.required as unknown[]).filter((k): k is string => typeof k === 'string')
    : [];
  const strSet = new Set(str);
  const required = schemaRequired.filter((k) => strSet.has(k));
  return { tool: info.name, str, num, required };
}

/**
 * Locate the first literal `<tool>(...)` call and return its index range plus
 * the raw inner argument text. Quote- and paren-aware so commas or parens
 * inside a string arg don't end the scan early.
 */
export function locateCall(text: string, tool: string): { start: number; end: number; inner: string } | null {
  const m = new RegExp(`${tool}\\s*\\(`).exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1; // index of '('
  let depth = 0;
  let quote: string | null = null;
  let i = open;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i++; // skip escaped char
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        i++; // include the closing paren
        break;
      }
    }
  }
  if (depth !== 0) return null; // never balanced - not a complete call
  return { start: m.index, end: i, inner: text.slice(open + 1, i - 1) };
}

/**
 * Locate an XML/tag-style leak, e.g. `<schedule action="create" after="1h" .../>`.
 * Quote-aware scan to the closing `>`; `inner` is the attribute text (trailing
 * `/` stripped), which `strArg`/`numArg` read the same as paren-call args.
 */
export function locateXmlCall(text: string, tool: string): { start: number; end: number; inner: string } | null {
  const m = new RegExp(`<${tool}(?=[\\s/>])`).exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  let quote: string | null = null;
  let closed = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '>') {
      i++; // include the closing '>'
      closed = true;
      break;
    }
  }
  if (quote !== null || !closed) return null; // unterminated - not a complete tag
  const inner = text.slice(m.index + m[0].length, i - 1).replace(/\/\s*$/, '');
  return { start: m.index, end: i, inner };
}

/** Earliest of the paren-style and XML-style leak for a tool. */
export function locateAny(text: string, tool: string): { start: number; end: number; inner: string } | null {
  const a = locateCall(text, tool);
  const b = locateXmlCall(text, tool);
  if (a && b) return a.start <= b.start ? a : b;
  return a ?? b;
}

function unquote(raw: string): string {
  const body = raw.slice(1, -1);
  return body
    .replace(/\\(["'`\\])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

/** Extract a string-valued keyword argument (`key="..."` or `key: '...'`). */
export function strArg(inner: string, key: string): string | undefined {
  const re = new RegExp(
    `(?:^|[,({\\s])${key}\\s*[:=]\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)`,
  );
  const m = re.exec(inner);
  return m ? unquote(m[1]) : undefined;
}

/** Extract a numeric keyword argument (`key=0.6` or `key: 3`). */
export function numArg(inner: string, key: string): number | undefined {
  const re = new RegExp(`(?:^|[,({\\s])${key}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`);
  const m = re.exec(inner);
  return m ? Number(m[1]) : undefined;
}

/** Parse a leaked call for one tool spec, or null if it isn't a real/complete leak. */
export function parseLeakedCall(text: string, spec: ToolSpec): ParsedCall | null {
  const loc = locateAny(text, spec.tool);
  if (!loc) return null;
  const args: Record<string, unknown> = {};
  for (const k of spec.str) {
    const v = strArg(loc.inner, k);
    if (v !== undefined) args[k] = v;
  }
  for (const k of spec.num) {
    const v = numArg(loc.inner, k);
    if (v !== undefined) args[k] = v;
  }
  // Required args (a bare mention like "use generate_image()" carries none).
  for (const k of spec.required) {
    if (typeof args[k] !== 'string' || !args[k].trim()) return null;
  }
  return { start: loc.start, end: loc.end, args };
}

/** Remove the literal call and tidy up any code fence / blank lines it left. */
export function stripCall(text: string, start: number, end: number): string {
  let out = text.slice(0, start) + text.slice(end);
  // Drop a code fence that is now empty (```tool_code\n\n``` etc).
  out = out.replace(/```[a-zA-Z_]*[ \t]*(?:\r?\n[ \t]*)*```/g, '');
  // Collapse 3+ newlines and trim.
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

/**
 * Apply the HARD-DENY safety boundary to a configured allowlist: returns the
 * tools that survive (eligible for rescue) and the ones that were denied (for a
 * one-time operator warning). Order-preserving and de-duplicated.
 */
export function resolveRescueTools(configured: readonly string[]): { allowed: string[]; denied: string[] } {
  const seen = new Set<string>();
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const raw of configured) {
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    if (HARD_DENY.has(t)) denied.push(t);
    else allowed.push(t);
  }
  return { allowed, denied };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate one untrusted JSON layer into a `tools` list. */
export function coerceToolRescueLayer(raw: unknown): { tools?: string[] } {
  if (!isObject(raw)) return {};
  if (!Array.isArray(raw.tools)) return {};
  return { tools: raw.tools.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()) };
}

/**
 * Load + merge the layered config: the `tools` allowlist is the UNION of project
 * `.pi/tool-rescue.json` and user `<agentDir>/tool-rescue.json`. Missing /
 * invalid files contribute an empty layer, so the default is an empty allowlist
 * (the extension is inert). The HARD-DENY filter is applied by the caller via
 * {@link resolveRescueTools}.
 */
export function loadToolRescueConfig(cwd: string): { tools: string[] } {
  const user = coerceToolRescueLayer(readJsonOrUndefined(piAgentPath('tool-rescue.json')));
  const project = coerceToolRescueLayer(readJsonOrUndefined(piProjectPath(cwd, 'tool-rescue.json')));
  return { tools: Array.from(new Set([...(user.tools ?? []), ...(project.tools ?? [])])) };
}
