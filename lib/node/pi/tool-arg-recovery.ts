/**
 * Pure helpers for the tool-arg-recovery extension.
 *
 * No pi imports so this module can be unit-tested under `vitest` without
 * the pi runtime.
 *
 * ## What this solves
 *
 * When the LLM emits a tool call whose arguments don't match the tool's
 * TypeBox schema, pi-ai's `validateToolArguments` throws a message of
 * the form:
 *
 *   Validation failed for tool "<name>":
 *     - <path>: <message>
 *     - <path>: <message>
 *
 *   Received arguments:
 *   {
 *     "foo": "..."
 *   }
 *
 * Pi then wraps that via `createErrorToolResult(error.message)` and the
 * tool_result event fires with `isError: true` and a single text part
 * containing the message.
 *
 * Small models read that error, guess at a fix, and often retry the
 * same shape — because the raw error tells them WHAT's wrong (type
 * mismatch at `id`) but doesn't show them a working example. This
 * module converts a parsed validation failure plus the tool's
 * (optional) TypeBox schema into a terse recovery block with:
 *
 *   - each failed argument path
 *   - the rule that was violated in plain English
 *   - a concrete corrected example when we can synthesize one
 *
 * The extension appends that block to the tool_result content; pi's
 * original error text stays intact at the top.
 */

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export interface ValidationIssue {
  /** JSON-pointer-ish path from pi-ai's `formatValidationPath` (e.g. `id`, `items.0.body`, `root`). */
  path: string;
  /** Raw message from TypeBox (e.g. `Expected number`, `Required property`, `Expected string`). */
  message: string;
}

export interface ParsedValidationFailure {
  kind: 'validation';
  toolName: string;
  issues: ValidationIssue[];
  /** The parsed `Received arguments:` JSON if present + well-formed, else undefined. */
  received: unknown;
  /** The raw `Received arguments:` block text (for fallback display). */
  receivedRaw: string | undefined;
}

/**
 * Minimal read-only schema shape. Matches TypeBox / JSON-Schema objects
 * well enough to walk the relevant fields without depending on typebox
 * at runtime. All fields are optional; we treat anything we don't
 * recognize as `unknown` and emit a generic hint.
 */
export interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  enum?: unknown[];
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  description?: string;
}

export interface RecoveryBlockOptions {
  /** Marker inserted at the top of the block for discoverability. */
  marker?: string;
  /** Hard cap on the serialized corrected example (chars). */
  maxExampleChars?: number;
}

const DEFAULT_MARKER = '⚠ [pi-tool-arg-recovery]';
const DEFAULT_MAX_EXAMPLE_CHARS = 1500;

// ──────────────────────────────────────────────────────────────────────
// parseValidationFailure
// ──────────────────────────────────────────────────────────────────────

const TOOL_HEADER_RE = /^Validation failed for tool "([^"]+)":\s*$/;
const ISSUE_LINE_RE = /^\s*-\s+([^:]+):\s*(.+?)\s*$/;

/**
 * Parse a `Validation failed for tool "X":` error block emitted by
 * pi-ai's `validateToolArguments`. Returns `undefined` on anything that
 * doesn't start with the exact canonical header — we don't want to
 * false-trigger on tool execute errors that happen to contain the word
 * "validation".
 */
export function parseValidationFailure(errorText: string | undefined): ParsedValidationFailure | undefined {
  if (!errorText || typeof errorText !== 'string') return undefined;

  // Header may have leading blank lines (pi sometimes pads errors).
  const lines = errorText.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return undefined;

  const headerMatch = TOOL_HEADER_RE.exec(lines[i].trim());
  if (!headerMatch) return undefined;
  const toolName = headerMatch[1];
  i++;

  // Issue lines follow immediately, each starting with `  - `.
  const issues: ValidationIssue[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') break;
    const m = ISSUE_LINE_RE.exec(line);
    if (!m) break;
    issues.push({ path: m[1].trim(), message: m[2].trim() });
    i++;
  }
  if (issues.length === 0) return undefined;

  // Then a blank line, then `Received arguments:`, then JSON body.
  while (i < lines.length && lines[i].trim() === '') i++;
  let receivedRaw: string | undefined;
  let received: unknown;
  if (i < lines.length && lines[i].trim() === 'Received arguments:') {
    i++;
    const body = lines.slice(i).join('\n').trim();
    if (body.length > 0) {
      receivedRaw = body;
      try {
        received = JSON.parse(body);
      } catch {
        // Leave `received` undefined; caller falls back to raw.
      }
    }
  }

  return { kind: 'validation', toolName, issues, received, receivedRaw };
}

// ──────────────────────────────────────────────────────────────────────
// Schema helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a dotted/bracketed validation path (e.g. `items.0.body` or
 * `root`) against a schema. Returns undefined when the path walks out
 * of known territory or hits a union we can't confidently pick from.
 */
export function resolveSchemaPath(schema: SchemaNode | undefined, path: string): SchemaNode | undefined {
  if (!schema) return undefined;
  if (!path || path === 'root') return schema;
  const parts = path.split('.');
  let node: SchemaNode | undefined = schema;
  for (const raw of parts) {
    if (!node) return undefined;
    if (/^\d+$/.test(raw)) {
      // array index — descend into `items`
      node = node.items;
      continue;
    }
    node = node.properties?.[raw];
  }
  return node;
}

/**
 * Render a short, human-friendly description of the expected type at
 * this schema node. Falls back to `(unknown)` when the node is absent
 * or opaque. Deliberately terse — this goes into a tool-result text
 * block for small models.
 */
export function describeSchema(node: SchemaNode | undefined): string {
  if (!node) return '(unknown)';
  if (node.enum && node.enum.length > 0) {
    return node.enum.map((v) => JSON.stringify(v)).join(' | ');
  }
  if (node.anyOf || node.oneOf) {
    const members = [...(node.anyOf ?? []), ...(node.oneOf ?? [])];
    const typeList = members.map((m) => describeSchema(m)).join(' | ');
    return typeList || '(union)';
  }
  const t = node.type;
  if (Array.isArray(t)) return t.join(' | ');
  if (typeof t === 'string') {
    if (t === 'array' && node.items) {
      return `${describeSchema(node.items)}[]`;
    }
    return t;
  }
  if (node.properties) return 'object';
  return '(unknown)';
}

function firstWord(s: string): string {
  const m = /[A-Za-z_][A-Za-z0-9_-]*/.exec(s);
  return m ? m[0] : 'value';
}

/**
 * Produce a concrete JSON-compatible example value for this schema
 * node. Used to synthesize a corrected payload when the model passed
 * the wrong type. Prefers enum[0] / item descriptions / type defaults.
 *
 * `depth` guards against deeply recursive schemas — past 3 levels we
 * emit a placeholder rather than recurse further.
 */
export function exampleValue(node: SchemaNode | undefined, depth = 0): unknown {
  if (!node || depth > 3) return '<value>';
  if (node.enum && node.enum.length > 0) return node.enum[0];
  if (node.anyOf?.[0]) return exampleValue(node.anyOf[0], depth + 1);
  if (node.oneOf?.[0]) return exampleValue(node.oneOf[0], depth + 1);
  const t = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (t) {
    case 'string':
      return node.description ? `<${firstWord(node.description)}>` : '<string>';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array':
      return [exampleValue(node.items, depth + 1)];
    case 'object': {
      const out: Record<string, unknown> = {};
      const required = node.required ?? [];
      const props = node.properties ?? {};
      for (const key of required) {
        if (props[key]) out[key] = exampleValue(props[key], depth + 1);
      }
      return out;
    }
    default:
      return '<value>';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Path walk on received data
// ──────────────────────────────────────────────────────────────────────

function getAtPath(obj: unknown, path: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const raw of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (/^\d+$/.test(raw)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(raw)];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[raw];
    } else {
      return undefined;
    }
  }
  return cur;
}

function ensureChild(parent: Record<string, unknown> | unknown[], key: string, nextIsIndex: boolean): unknown {
  if (Array.isArray(parent)) {
    const idx = Number(key);
    const existing = parent[idx];
    if (existing === undefined || existing === null || typeof existing !== 'object') {
      parent[idx] = nextIsIndex ? [] : {};
    }
    return parent[idx];
  }
  const obj = parent;
  const existing = obj[key];
  if (existing === undefined || existing === null || typeof existing !== 'object') {
    obj[key] = nextIsIndex ? [] : {};
  }
  return obj[key];
}

function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (!path || path === 'root') return;
  const parts = path.split('.');
  let cur: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const raw = parts[i];
    const nextRaw = parts[i + 1];
    const nextIsIndex = /^\d+$/.test(nextRaw);
    const next = ensureChild(cur, raw, nextIsIndex);
    if (next === null || typeof next !== 'object') return;
    cur = next as Record<string, unknown> | unknown[];
  }
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) {
    if (Array.isArray(cur)) cur[Number(last)] = value;
  } else {
    (cur as Record<string, unknown>)[last] = value;
  }
}

/**
 * Human-readable one-liner summarizing the actual value at `path`
 * inside `received`. Returns `undefined` when we have nothing to show.
 * Never stringifies raw objects via `String(…)` (which would yield
 * `[object Object]`); falls back to generic placeholders instead.
 */
function summarizeActual(received: unknown, path: string): string | undefined {
  if (received === undefined) return undefined;
  const val: unknown = path === 'root' || path === '' ? received : getAtPath(received, path);
  if (val === undefined) return '`undefined`';
  if (val === null) return '`null`';
  if (typeof val === 'string') {
    const trimmed = val.length > 40 ? `${val.slice(0, 40)}…` : val;
    return `\`"${trimmed.replace(/`/g, '\\`')}"\` (string)`;
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return `\`${String(val)}\` (${typeof val})`;
  }
  if (Array.isArray(val)) return `\`[…]\` (array of ${val.length})`;
  if (typeof val === 'object') return '`{…}` (object)';
  return '`?` (unknown)';
}

// ──────────────────────────────────────────────────────────────────────
// Recovery block + corrected example
// ──────────────────────────────────────────────────────────────────────

/**
 * Merge the received arguments with schema-driven example values at the
 * failed paths, to produce a concrete corrected payload. The result is
 * always a JSON-compatible plain object/array, suitable for
 * `JSON.stringify`.
 *
 * When a required property is missing at the root, we add it. When a
 * property has the wrong type, we replace it. When the root received
 * value isn't an object at all (e.g. model passed `"search term"` as
 * the whole args) we synthesize a fresh example.
 */
export function buildCorrectedExample(failure: ParsedValidationFailure, schema: SchemaNode): unknown {
  const base = failure.received;
  if (base === undefined || base === null || typeof base !== 'object' || Array.isArray(base)) {
    return exampleValue(schema);
  }
  // Deep clone so we don't mutate the parsed failure.
  const out = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  for (const issue of failure.issues) {
    setAtPath(out, issue.path, exampleValue(resolveSchemaPath(schema, issue.path)));
  }
  // Ensure all required root properties exist.
  for (const key of schema.required ?? []) {
    if (!(key in out)) out[key] = exampleValue(schema.properties?.[key]);
  }
  return out;
}

/**
 * Build the recovery block appended to the tool_result content.
 *
 * Layout:
 *   ⚠ [pi-tool-arg-recovery] tool=<name>
 *
 *   Problems with the arguments:
 *     - <path>: <message>. Expected <type>. Got <value>.
 *     - ...
 *
 *   Corrected example (replace placeholders):
 *   ```json
 *   { ... }
 *   ```
 *
 * The corrected example is a best-effort merge of the received
 * arguments with schema-driven defaults for each failed path. When no
 * schema is available we still emit the diagnosis; the example block is
 * omitted.
 */
export function buildRecoveryBlock(
  failure: ParsedValidationFailure,
  schema: SchemaNode | undefined,
  opts: RecoveryBlockOptions = {},
): string {
  const marker = opts.marker ?? DEFAULT_MARKER;
  const maxChars = opts.maxExampleChars ?? DEFAULT_MAX_EXAMPLE_CHARS;
  const lines: string[] = [];
  lines.push(`${marker} tool=${failure.toolName}`);
  lines.push('');
  lines.push('Problems with the arguments:');
  for (const issue of failure.issues) {
    const node = resolveSchemaPath(schema, issue.path);
    const expected = describeSchema(node);
    const got = summarizeActual(failure.received, issue.path);
    const parts = [`  - \`${issue.path}\`: ${issue.message}`];
    if (expected !== '(unknown)') parts.push(`expected ${expected}`);
    if (got !== undefined) parts.push(`got ${got}`);
    lines.push(parts.join('. ') + '.');
  }

  const example = schema ? buildCorrectedExample(failure, schema) : undefined;
  if (example !== undefined) {
    const serialized = JSON.stringify(example, null, 2);
    if (serialized.length <= maxChars) {
      lines.push('');
      lines.push('Corrected example (replace placeholders, then retry):');
      lines.push('```json');
      lines.push(serialized);
      lines.push('```');
    }
  }

  lines.push('');
  lines.push(
    'Do NOT retry with the same arguments. Fix the types/fields above, then call the tool again with a corrected payload.',
  );
  return lines.join('\n');
}
