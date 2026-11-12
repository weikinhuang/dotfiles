/**
 * Model-request projection for the opencode `secret-redactor` plugin
 * (`config/opencode/plugins/secret-redactor/`): walk the `system` parts
 * and `messages` an opencode session hook (`context`, `compaction`,
 * `generate`, `title`) is about to send, and rewrite every model-bound
 * string through an injected `redact` function.
 *
 * Shapes follow `@opencode/ai` `SystemPart` / `Message`:
 *
 *   - system parts: `{ type: 'text', text, metadata? }`; the instructions
 *     part also mirrors each source in `metadata.experimental.instructions`
 *     as `{ key, text }`, which is redacted too.
 *   - messages (`system` / `user` / `assistant` / `tool` roles): `content`
 *     is a string or an array of parts - `text`, `reasoning`, `tool-call`
 *     (`input` is arbitrary JSON), `tool-result` (`result` is
 *     `{ type: 'json' | 'text' | 'error', value }` or
 *     `{ type: 'content', value: Tool.Content[] }`), `compaction`, plus
 *     `media` / `effort` parts that carry no model text and pass through.
 *
 * Copy-on-write: an unchanged part, message, or system entry keeps its
 * identity, and a changed one is replaced by a shallow clone that keeps
 * its prototype (opencode messages are Effect `Schema.Class` instances).
 * Nothing the hook was handed is mutated below the top-level arrays, so
 * cached projections are never poisoned. With a deterministic `redact`,
 * the output is byte-stable across requests, keeping the prompt-cache
 * prefix intact.
 *
 * Signed or encrypted reasoning is passed through: providers verify
 * thinking blocks against their signature, so rewriting one would fail the
 * request. The model only ever saw placeholders, so its own reasoning
 * rarely holds a literal secret.
 *
 * Pure module - no opencode imports.
 */

/** Redact one string, returning the (possibly unchanged) result. */
export type RedactFn = (text: string) => string;

/** The mutable slice of an opencode session-hook event this module edits. */
export interface RedactableRequest {
  system: unknown[];
  messages: unknown[];
}

/** Recursion guard for arbitrary tool JSON. */
const MAX_DEPTH = 32;

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Rec {
  if (!isRecord(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Shallow clone of `obj` that keeps its prototype, with `patch` applied. */
export function cloneWith<T extends object>(obj: T, patch: Partial<T> | Rec): T {
  const proto = Object.getPrototypeOf(obj) as object | null;
  return Object.assign(Object.create(proto) as T, obj, patch);
}

/** Map an array, returning the original when no element changed. */
function mapParts(parts: readonly unknown[], fn: (part: unknown) => unknown): unknown[] {
  let out: unknown[] | undefined;
  parts.forEach((part, i) => {
    const next = fn(part);
    if (next === part) return;
    out ??= [...parts];
    out[i] = next;
  });
  return out ?? (parts as unknown[]);
}

/**
 * Map every string inside a JSON-ish value through `fn`. Arrays and plain
 * objects are copied only along changed paths; class instances (binary
 * media, dates) pass through untouched. Object keys are never rewritten.
 */
export function mapStrings(value: unknown, fn: RedactFn, depth = 0): unknown {
  if (typeof value === 'string') return fn(value);
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return mapParts(value as unknown[], (item) => mapStrings(item, fn, depth + 1));
  if (!isPlainObject(value)) return value;
  let out: Rec | undefined;
  for (const [key, item] of Object.entries(value)) {
    const next = mapStrings(item, fn, depth + 1);
    if (next === item) continue;
    out ??= { ...value };
    out[key] = next;
  }
  return out ?? value;
}

/** Every string inside a JSON-ish value, depth-first. */
export function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (depth < MAX_DEPTH && Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
  } else if (depth < MAX_DEPTH && isPlainObject(value)) {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
  return out;
}

/** Redact the `text` field of a record, returning a clone only when it changed. */
function redactTextField<T extends Rec>(part: T, redact: RedactFn): T {
  if (typeof part.text !== 'string') return part;
  const text = redact(part.text);
  return text === part.text ? part : cloneWith(part, { text });
}

function redactToolResult(result: unknown, redact: RedactFn): unknown {
  if (!isRecord(result)) return result;
  if (result.type === 'content' && Array.isArray(result.value)) {
    const items = result.value as unknown[];
    const value = mapParts(items, (item) =>
      isRecord(item) && item.type === 'text' ? redactTextField(item, redact) : item,
    );
    return value === items ? result : cloneWith(result, { value });
  }
  const value = mapStrings(result.value, redact);
  return value === result.value ? result : cloneWith(result, { value });
}

/** Redact the model-bound text of one content part. */
export function redactContentPart(part: unknown, redact: RedactFn): unknown {
  if (!isRecord(part)) return part;
  switch (part.type) {
    case 'text':
      return redactTextField(part, redact);
    case 'reasoning':
      // Signed / encrypted thinking must round-trip byte-identical.
      if (part.encrypted !== undefined || part.providerMetadata !== undefined) return part;
      return redactTextField(part, redact);
    case 'compaction':
      if (part.encrypted !== undefined) return part;
      return redactTextField(part, redact);
    case 'tool-call': {
      const input = mapStrings(part.input, redact);
      return input === part.input ? part : cloneWith(part, { input });
    }
    case 'tool-result': {
      const result = redactToolResult(part.result, redact);
      return result === part.result ? part : cloneWith(part, { result });
    }
    default:
      return part;
  }
}

/** Redact one message (any role), returning a clone only when it changed. */
export function redactMessage(message: unknown, redact: RedactFn): unknown {
  if (!isRecord(message)) return message;
  const { content } = message;
  if (typeof content === 'string') {
    const next = redact(content);
    return next === content ? message : cloneWith(message, { content: next });
  }
  if (!Array.isArray(content)) return message;
  const parts = content as unknown[];
  const next = mapParts(parts, (part) => redactContentPart(part, redact));
  return next === parts ? message : cloneWith(message, { content: next });
}

/** Redact one system part, including its `metadata.experimental.instructions` mirror. */
export function redactSystemPart(part: unknown, redact: RedactFn): unknown {
  if (!isRecord(part)) return part;
  let next = redactTextField(part, redact);
  const { metadata } = part;
  if (isRecord(metadata) && isRecord(metadata.experimental) && Array.isArray(metadata.experimental.instructions)) {
    const list = metadata.experimental.instructions as unknown[];
    const instructions = mapParts(list, (entry) => (isRecord(entry) ? redactTextField(entry, redact) : entry));
    if (instructions !== list) {
      const experimental = cloneWith(metadata.experimental, { instructions });
      next = cloneWith(next, { metadata: cloneWith(metadata, { experimental }) });
    }
  }
  return next;
}

/**
 * Redact every model-bound string in `request.system` and
 * `request.messages`, replacing changed entries in place (the arrays
 * themselves are the hook's owned draft). Returns how many entries changed.
 */
export function redactModelRequest(request: RedactableRequest, redact: RedactFn): number {
  let changed = 0;
  request.system.forEach((part, i) => {
    const next = redactSystemPart(part, redact);
    if (next === part) return;
    request.system[i] = next;
    changed++;
  });
  request.messages.forEach((message, i) => {
    const next = redactMessage(message, redact);
    if (next === message) return;
    request.messages[i] = next;
    changed++;
  });
  return changed;
}
