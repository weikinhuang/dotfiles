/**
 * Pure helpers for the opencode `context-edit` plugin
 * (`config/opencode/plugins/context-edit/`), the port of pi's
 * `tool-collapse` + `context-trim` extensions.
 *
 * The directive container, placeholders, recency-ordinal resolver, and
 * candidate labels are shared with pi (`lib/node/pi/context-edit/`); this
 * module adapts them to opencode's two message shapes:
 *
 *   - **LLM messages** (`@opencode/ai` `Message`), what the session
 *     `context` hook edits: assistant `tool-call` parts, `tool` messages
 *     holding `tool-result` parts, and user `media` parts. The overlay
 *     ({@link applyOverlay}) runs on these.
 *   - **Session messages** (`ctx.session.context`), the projected history
 *     since the latest compaction, used to list candidates for the TUI
 *     and the model tools without waiting for a request.
 *
 * Both shapes reduce to the same {@link ContentRecord} list, so a
 * candidate found in session history addresses the same content in the
 * next request:
 *
 *   - a tool pair is keyed on its tool-call id; a result image on
 *     `(toolCallId, index in the result content)`, which is the session
 *     tool state's `content` index verbatim;
 *   - a user attachment image on `(messageId, Nth media part)`; opencode
 *     lowers each image / PDF attachment to exactly one media part.
 *
 * Pure module - no opencode imports.
 */

import { type DropResolution, resolveRecencyTargets } from '../pi/context-edit/agent-drop.ts';
import {
  addCollapse,
  addTrim,
  type ContextEditState,
  type Directive,
  emptyState,
  isContextEditStateShape,
} from '../pi/context-edit/directive.ts';
import { type Candidate, candidateLabel } from '../pi/context-edit/enumerate.ts';
import { capDescription } from '../pi/context-edit/image-description.ts';
import { collapsePlaceholder, countLines, imagePlaceholder, isPlaceholder } from '../pi/context-edit/placeholder.ts';
import { type Target, targetKey } from '../pi/context-edit/target.ts';
import { byteLen } from '../pi/shared/bytes.ts';
import { isRecord } from '../pi/shared/guards.ts';
import { collapseWhitespace, truncate } from '../pi/shared/strings.ts';
import { createOptionReader, type EnvBag, type PluginOptionBag } from './plugin-options.ts';

// ──────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────

/** Env override prefix: option `minBytes` -> `OPENCODE_CONTEXT_EDIT_MIN_BYTES`. */
export const OPENCODE_CONTEXT_EDIT_ENV_PREFIX = 'OPENCODE_CONTEXT_EDIT_';
/** Placeholder prefix stamped on every overlaid part. Byte-stable on purpose (prompt caching). */
export const CONTEXT_EDIT_MARKER = '⟨context-edit⟩';
/** Permission action for `collapse_output` / `drop_image`; resources are the tool names. */
export const CONTEXT_EDIT_PERMISSION = 'context_edit';
export const COLLAPSE_TOOL = 'collapse_output';
export const DROP_IMAGE_TOOL = 'drop_image';

export interface ContextEditConfig {
  enabled: boolean;
  /** Register `collapse_output` and `drop_image`. */
  tools: boolean;
  /** Minimum tool-pair size listed in the TUI picker. */
  minBytes: number;
  snippetChars: number;
  /** Most-recent pairs / images the model tools refuse to drop. */
  tailGuard: number;
  /** Append one JSON line per overlaid request (and dump the projection beside it). */
  debugFile?: string;
}

export function resolveContextEditConfig(options: PluginOptionBag | undefined, env: EnvBag): ContextEditConfig {
  const read = createOptionReader(options, env, OPENCODE_CONTEXT_EDIT_ENV_PREFIX);
  return {
    enabled: read.bool('enabled', true),
    tools: read.bool('tools', true),
    minBytes: Math.floor(read.number('minBytes', 2048)),
    snippetChars: Math.max(10, Math.floor(read.number('snippetChars', 80))),
    tailGuard: Math.floor(read.number('tailGuard', 1)),
    debugFile: read.optionalString('debugFile'),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Loose message shapes
// ──────────────────────────────────────────────────────────────────────

/** A content part of an `@opencode/ai` message, duck-typed. */
export interface OcPart {
  type: string;
  [k: string]: unknown;
}

/** An `@opencode/ai` message as the `context` hook sees it, duck-typed. */
export interface OcMessage {
  role: string;
  id?: string;
  content: readonly OcPart[];
  [k: string]: unknown;
}

/** One tool-result content item (`Tool.Content`): text or a file reference. */
type ToolContent = { type: 'text'; text: string } | { type: 'file'; uri: string; mime: string; name?: string };

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Attachment mimes opencode lowers to one media part each (`to-llm-message.ts`). */
const MEDIA_MIMES = new Set([...IMAGE_MIMES, 'application/pdf']);

function isImageMime(mime: unknown): boolean {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Decoded size of a base64 payload, from its length. */
function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4);
}

/** Approximate decoded size of a tool-result file item: data URIs only, else 0. */
function fileBytes(uri: string): number {
  if (!uri.startsWith('data:')) return 0;
  const comma = uri.indexOf(',');
  return comma === -1 ? 0 : base64Bytes(uri.slice(comma + 1));
}

/** `@opencode/ai` media part: `media` is a `Media.Asset` whose `source` holds base64, bytes, or a reference. */
function mediaInfo(part: OcPart): { mime: string; bytes: number } {
  const media = isRecord(part.media) ? part.media : {};
  const source = isRecord(media.source) ? media.source : {};
  const mime = str(media.mediaType) ?? str(source.mediaType) ?? '';
  let bytes = 0;
  if (source.type === 'base64' && typeof source.data === 'string') bytes = base64Bytes(source.data);
  else if (source.type === 'bytes' && source.data instanceof Uint8Array) bytes = source.data.byteLength;
  return { mime, bytes };
}

function toolContentList(value: unknown): ToolContent[] {
  if (!Array.isArray(value)) return [];
  const out: ToolContent[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string') out.push({ type: 'text', text: item.text });
    else if (item.type === 'file' && typeof item.uri === 'string' && typeof item.mime === 'string') {
      out.push({ type: 'file', uri: item.uri, mime: item.mime, name: str(item.name) });
    } else out.push({ type: 'text', text: '' });
  }
  return out;
}

/** Normalize an LLM `tool-result` value (`text` / `json` / `content` / `error`) to content items. */
function resultContent(result: unknown): ToolContent[] {
  if (!isRecord(result)) return [];
  switch (result.type) {
    case 'text':
      return [{ type: 'text', text: typeof result.value === 'string' ? result.value : JSON.stringify(result.value) }];
    case 'json':
      return [{ type: 'text', text: JSON.stringify(result.value) ?? '' }];
    case 'content':
      return toolContentList(result.value);
    case 'error':
      return isRecord(result.value) ? toolContentList(result.value.content) : [];
    default:
      return [];
  }
}

// ──────────────────────────────────────────────────────────────────────
// Content records (shape-neutral) and candidates
// ──────────────────────────────────────────────────────────────────────

/** A collapsible tool call + result pair. */
export interface ToolRecord {
  type: 'tool';
  toolCallId: string;
  toolName: string;
  inputBytes: number;
  content: ToolContent[];
}

/** An image attached to a user message, addressed by its media ordinal. */
export interface UserImageRecord {
  type: 'user-image';
  messageId: string;
  mediaIndex: number;
  mime: string;
  bytes: number;
  name?: string;
}

export type ContentRecord = ToolRecord | UserImageRecord;

function jsonBytes(v: unknown): number {
  if (v === undefined) return 0;
  return byteLen(JSON.stringify(v) ?? '');
}

/**
 * Records from the LLM message list the `context` hook receives. Only
 * local tool pairs (a `tool-call` plus its `tool-result` in a `tool`
 * message) count; provider-executed calls replay provider data and are left
 * alone.
 */
export function recordsFromLlmMessages(messages: readonly OcMessage[]): ContentRecord[] {
  const calls = new Map<string, { name: string; inputBytes: number }>();
  const out: ContentRecord[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const p of m.content) {
        if (p.type !== 'tool-call' || p.providerExecuted === true || typeof p.id !== 'string') continue;
        calls.set(p.id, { name: str(p.name) ?? 'tool', inputBytes: jsonBytes(p.input) });
      }
    } else if (m.role === 'tool') {
      for (const p of m.content) {
        if (p.type !== 'tool-result' || typeof p.id !== 'string') continue;
        const call = calls.get(p.id);
        if (!call) continue;
        out.push({
          type: 'tool',
          toolCallId: p.id,
          toolName: str(p.name) ?? call.name,
          inputBytes: call.inputBytes,
          content: resultContent(p.result),
        });
      }
    } else if (m.role === 'user' && typeof m.id === 'string') {
      let mediaIndex = 0;
      for (const p of m.content) {
        if (p.type !== 'media') continue;
        const { mime, bytes } = mediaInfo(p);
        if (isImageMime(mime)) {
          out.push({ type: 'user-image', messageId: m.id, mediaIndex, mime, bytes, name: str(p.filename) });
        }
        mediaIndex++;
      }
    }
  }
  return out;
}

/**
 * Records from `ctx.session.context` (projected `SessionMessage.Info[]`).
 * Mirrors opencode's lowering: local tools with a completed / error state
 * become pairs; user image / PDF attachments are one media part each.
 */
export function recordsFromSessionMessages(messages: readonly unknown[]): ContentRecord[] {
  const out: ContentRecord[] = [];
  for (const m of messages) {
    if (!isRecord(m) || typeof m.id !== 'string') continue;
    if (m.type === 'assistant' && Array.isArray(m.content)) {
      for (const item of m.content as unknown[]) {
        if (!isRecord(item) || item.type !== 'tool' || item.executed === true || typeof item.id !== 'string') continue;
        const state = isRecord(item.state) ? item.state : {};
        if (state.status !== 'completed' && state.status !== 'error') continue;
        out.push({
          type: 'tool',
          toolCallId: item.id,
          toolName: str(item.name) ?? 'tool',
          inputBytes: jsonBytes(state.input),
          content: toolContentList(state.content),
        });
      }
    } else if (m.type === 'user' && Array.isArray(m.files)) {
      let mediaIndex = 0;
      for (const file of m.files as unknown[]) {
        if (!isRecord(file) || typeof file.mime !== 'string' || !MEDIA_MIMES.has(file.mime)) continue;
        if (IMAGE_MIMES.has(file.mime)) {
          out.push({
            type: 'user-image',
            messageId: m.id,
            mediaIndex,
            mime: file.mime,
            bytes: typeof file.data === 'string' ? base64Bytes(file.data) : 0,
            name: str(file.name),
          });
        }
        mediaIndex++;
      }
    }
  }
  return out;
}

export interface CandidateOptions {
  snippetChars?: number;
  /** Tool names never offered for collapse (default: this plugin's own tools). */
  excludeTools?: readonly string[];
  /** Minimum pair weight (result text + call input) for the `tools` list; images are always listed. */
  minBytes?: number;
}

export interface CandidateSet {
  /** Collapsible tool pairs, heaviest first. */
  tools: Candidate[];
  /** Droppable images (tool results and user attachments), heaviest first. */
  images: Candidate[];
}

function snippetOf(text: string, chars: number): string {
  return truncate(collapseWhitespace(text), chars);
}

function heaviestFirst(cands: Candidate[]): Candidate[] {
  return cands
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.bytes - a.c.bytes || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * Turn records into pi {@link Candidate}s (so `candidateLabel` and the
 * recency resolver apply unchanged). `seq` is document order, one per
 * candidate. Content already overlaid by `state` is skipped.
 */
export function buildCandidates(
  records: readonly ContentRecord[],
  state: ContextEditState = emptyState(),
  opts: CandidateOptions = {},
): CandidateSet {
  const chars = opts.snippetChars ?? 80;
  const minBytes = opts.minBytes ?? 0;
  const excluded = new Set(opts.excludeTools ?? [COLLAPSE_TOOL, DROP_IMAGE_TOOL]);
  const collapsed = new Set<string>();
  const trimmed = new Set<string>();
  for (const d of state.directives) {
    if (d.kind === 'collapse') collapsed.add(d.toolCallId);
    else if (d.kind === 'trim') trimmed.add(targetKey(d.target));
  }
  const tools: Candidate[] = [];
  const images: Candidate[] = [];
  let seq = 0;
  for (const r of records) {
    if (r.type === 'user-image') {
      const target: Target = { by: 'messageId', messageId: r.messageId, partIndex: r.mediaIndex };
      if (trimmed.has(targetKey(target))) continue;
      const snippet = `image in user message${r.name ? ` (${r.name})` : ''}`;
      images.push({
        id: `img${images.length + 1}`,
        seq: seq++,
        kind: 'image',
        target,
        role: 'user',
        bytes: r.bytes,
        lines: 0,
        snippet,
        search: snippet,
      });
      continue;
    }
    let textBytes = 0;
    let lines = 0;
    let first = '';
    for (let p = 0; p < r.content.length; p++) {
      const item = r.content[p];
      if (item.type === 'file') {
        if (!isImageMime(item.mime)) continue;
        const target: Target = { by: 'toolCallId', toolCallId: r.toolCallId, partIndex: p };
        if (trimmed.has(targetKey(target)) || collapsed.has(r.toolCallId)) continue;
        const snippet = `image from ${r.toolName}${item.name ? ` (${item.name})` : ''}`;
        images.push({
          id: `img${images.length + 1}`,
          seq: seq++,
          kind: 'image',
          target,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          bytes: fileBytes(item.uri),
          lines: 0,
          snippet,
          search: snippet,
        });
      } else if (!isPlaceholder(item.text, CONTEXT_EDIT_MARKER)) {
        textBytes += byteLen(item.text);
        lines += countLines(item.text);
        if (!first && item.text.trim()) first = item.text;
      }
    }
    const bytes = textBytes + r.inputBytes;
    if (collapsed.has(r.toolCallId) || excluded.has(r.toolName) || bytes < minBytes) continue;
    tools.push({
      id: `tool${tools.length + 1}`,
      seq: seq++,
      kind: 'tool-result',
      target: { by: 'toolCallId', toolCallId: r.toolCallId },
      toolCallId: r.toolCallId,
      toolName: r.toolName,
      bytes,
      lines,
      snippet: snippetOf(first || '(no text output)', chars),
      search: snippetOf(first, 512),
    });
  }
  return { tools: heaviestFirst(tools), images: heaviestFirst(images) };
}

/** Stable selection key for a candidate (`collapse:<id>` / `trim:<targetKey>`), used across RPC. */
export function candidateKey(c: Candidate): string {
  if (c.kind === 'image' && c.target) return `trim:${targetKey(c.target)}`;
  return `collapse:${c.toolCallId ?? c.id}`;
}

// ──────────────────────────────────────────────────────────────────────
// Overlay
// ──────────────────────────────────────────────────────────────────────

export interface OverlayResult {
  messages: OcMessage[];
  applied: number;
  /** Directive ids whose target is absent from this request (compacted, other session state). */
  stale: number[];
}

/** Call inputs up to this size survive a collapse; larger ones are blanked to `{}`. */
export const COLLAPSE_KEEP_INPUT_BYTES = 512;
/** Placeholder note: the call completed and only its output left the context. */
const COLLAPSE_NOTE = 'ran; output removed from context';

interface Located {
  messageIndex: number;
  partIndex: number;
}

function findPart(messages: readonly OcMessage[], role: string, match: (p: OcPart) => boolean): Located | null {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== role) continue;
    const p = m.content.findIndex(match);
    if (p !== -1) return { messageIndex: i, partIndex: p };
  }
  return null;
}

/** Replace one part, copying the message so the hook's input objects stay untouched. */
function replacePart(messages: OcMessage[], at: Located, next: OcPart): void {
  const m = messages[at.messageIndex];
  const content = [...m.content];
  content[at.partIndex] = next;
  messages[at.messageIndex] = { ...m, content };
}

function applyCollapse(messages: OcMessage[], toolCallId: string, reason: string | undefined, marker: string): boolean {
  const call = findPart(
    messages,
    'assistant',
    (p) => p.type === 'tool-call' && p.id === toolCallId && p.providerExecuted !== true,
  );
  const result = findPart(messages, 'tool', (p) => p.type === 'tool-result' && p.id === toolCallId);
  // Collapse only a complete local pair, so the provider still sees one call answered by one result.
  if (!call || !result) return false;
  const callPart = messages[call.messageIndex].content[call.partIndex];
  // A small input stays so the model still knows what ran (a blank call reads as "never ran").
  if (jsonBytes(callPart.input) > COLLAPSE_KEEP_INPUT_BYTES) replacePart(messages, call, { ...callPart, input: {} });
  const resultPart = messages[result.messageIndex].content[result.partIndex];
  const name = str(resultPart.name) ?? str(callPart.name);
  const note = `${COLLAPSE_NOTE}${reason ? `: ${reason}` : ''}`;
  replacePart(messages, result, {
    ...resultPart,
    result: { type: 'text', value: collapsePlaceholder(name, note, marker) },
  });
  return true;
}

function applyToolImageTrim(
  messages: OcMessage[],
  toolCallId: string,
  partIndex: number,
  placeholder: (bytes: number) => string,
): boolean {
  const at = findPart(messages, 'tool', (p) => p.type === 'tool-result' && p.id === toolCallId);
  if (!at) return false;
  const part = messages[at.messageIndex].content[at.partIndex];
  const result = isRecord(part.result) ? part.result : {};
  if (result.type !== 'content' || !Array.isArray(result.value)) return false;
  const value = [...(result.value as unknown[])];
  const item = value[partIndex];
  if (!isRecord(item) || item.type !== 'file' || !isImageMime(item.mime) || typeof item.uri !== 'string') return false;
  value[partIndex] = { type: 'text', text: placeholder(fileBytes(item.uri)) };
  replacePart(messages, at, { ...part, result: { ...result, value } });
  return true;
}

function applyUserImageTrim(
  messages: OcMessage[],
  messageId: string,
  mediaIndex: number,
  placeholder: (bytes: number) => string,
): boolean {
  const i = messages.findIndex((m) => m.id === messageId);
  if (i === -1) return false;
  let seen = 0;
  const parts = messages[i].content;
  for (let p = 0; p < parts.length; p++) {
    if (parts[p].type !== 'media') continue;
    if (seen++ !== mediaIndex) continue;
    const { mime, bytes } = mediaInfo(parts[p]);
    if (!isImageMime(mime)) return false;
    replacePart(messages, { messageIndex: i, partIndex: p }, { type: 'text', text: placeholder(bytes) });
    return true;
  }
  return false;
}

function applyOne(messages: OcMessage[], d: Directive, marker: string): boolean {
  if (d.kind === 'collapse') return applyCollapse(messages, d.toolCallId, d.reason, marker);
  if (d.kind !== 'trim' || d.target.partIndex === undefined) return false;
  const placeholder = (approxBytes: number): string =>
    imagePlaceholder({ reason: d.reason, approxBytes, description: d.description, marker });
  if (d.target.by === 'toolCallId') {
    return applyToolImageTrim(messages, d.target.toolCallId, d.target.partIndex, placeholder);
  }
  if (d.target.by === 'messageId') {
    return applyUserImageTrim(messages, d.target.messageId, d.target.partIndex, placeholder);
  }
  return false;
}

/**
 * Apply `directives` (in id order) to a copy of `messages`. Untouched
 * messages keep their identity; touched ones are shallow copies, so the
 * caller can assign the result back onto the hook event. Output bytes
 * depend only on the directives and the original content, so the same
 * overlay renders identically every request.
 */
export function applyOverlay(
  messages: readonly OcMessage[],
  directives: readonly Directive[],
  marker: string = CONTEXT_EDIT_MARKER,
): OverlayResult {
  const out = [...messages];
  let applied = 0;
  const stale: number[] = [];
  for (const d of [...directives].sort((a, b) => a.id - b.id)) {
    if (applyOne(out, d, marker)) applied++;
    else stale.push(d.id);
  }
  return { messages: out, applied, stale };
}

// ──────────────────────────────────────────────────────────────────────
// Directive bookkeeping
// ──────────────────────────────────────────────────────────────────────

/** Parse a stored value back into a state, falling back to empty on junk. */
export function parseStoredState(value: unknown): ContextEditState {
  return isContextEditStateShape(value) ? value : emptyState();
}

export interface DirectiveRow {
  id: number;
  kind: 'collapse' | 'trim';
  label: string;
  /** Target absent from the current session history (compacted); restoring is still allowed. */
  stale: boolean;
}

/** List collapse / trim directives for display, flagging those whose target left the history. */
export function describeDirectives(state: ContextEditState, records: readonly ContentRecord[]): DirectiveRow[] {
  const tools = new Set<string>();
  const images = new Set<string>();
  for (const r of records) {
    if (r.type === 'user-image') {
      images.add(targetKey({ by: 'messageId', messageId: r.messageId, partIndex: r.mediaIndex }));
      continue;
    }
    tools.add(r.toolCallId);
    r.content.forEach((item, p) => {
      if (item.type === 'file') images.add(targetKey({ by: 'toolCallId', toolCallId: r.toolCallId, partIndex: p }));
    });
  }
  const rows: DirectiveRow[] = [];
  for (const d of state.directives) {
    if (d.kind === 'collapse') {
      rows.push({
        id: d.id,
        kind: 'collapse',
        label: d.label ?? `tool call ${d.toolCallId}`,
        stale: !tools.has(d.toolCallId),
      });
    } else if (d.kind === 'trim') {
      rows.push({ id: d.id, kind: 'trim', label: d.label ?? 'image', stale: !images.has(targetKey(d.target)) });
    }
  }
  return rows;
}

/** One-line row text: `#3 collapse result bash (120L 48KB): ... [stale]`. */
export function directiveRowText(row: DirectiveRow): string {
  return `#${row.id} ${row.kind} ${row.label}${row.stale ? ' [not in context]' : ''}`;
}

export interface SelectionOutcome {
  state: ContextEditState;
  applied: Candidate[];
  missing: string[];
}

/**
 * Add one directive per selected candidate key (from {@link candidateKey}).
 * Keys that no longer match a candidate are reported in `missing`.
 * `description` becomes the image caption (agent `summary`).
 */
export function applySelection(
  state: ContextEditState,
  candidates: CandidateSet,
  keys: readonly string[],
  opts: { reason?: string; description?: string; now: number },
): SelectionOutcome {
  const byKey = new Map<string, Candidate>();
  for (const c of [...candidates.tools, ...candidates.images]) byKey.set(candidateKey(c), c);
  let next = state;
  const applied: Candidate[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const c = byKey.get(key);
    if (!c) {
      missing.push(key);
      continue;
    }
    const label = candidateLabel(c);
    const r =
      c.kind === 'image' && c.target
        ? addTrim(next, c.target, opts.reason, opts.now, capDescription(opts.description), label)
        : addCollapse(next, c.toolCallId ?? '', opts.reason, opts.now, label);
    if (!r.ok) continue;
    next = r.state;
    applied.push(c);
  }
  return { state: next, applied, missing };
}

// ──────────────────────────────────────────────────────────────────────
// Model tools: input schemas, parsing, planning, replies
// ──────────────────────────────────────────────────────────────────────

const DROP_PROPERTY = {
  type: 'array',
  items: { type: 'integer', minimum: 1 },
  description: 'Recency ordinals to drop (1 = most recent), e.g. [2].',
} as const;
const KEEP_RECENT_PROPERTY = {
  type: 'integer',
  minimum: 0,
  description: 'Batch form: drop everything beyond the most recent N.',
} as const;
const REASON_PROPERTY = {
  type: 'string',
  description: 'Why you are done with it; stored for audit and shown in the placeholder.',
} as const;

export const COLLAPSE_OUTPUT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    drop: DROP_PROPERTY,
    keepRecent: KEEP_RECENT_PROPERTY,
    toolName: { type: 'string', description: 'Only consider pairs from this tool (e.g. "bash", "read").' },
    reason: REASON_PROPERTY,
  },
  additionalProperties: false,
} as const;

export const DROP_IMAGE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    drop: DROP_PROPERTY,
    keepRecent: KEEP_RECENT_PROPERTY,
    summary: {
      type: 'string',
      description: 'One line describing what the image(s) showed; kept in the placeholder as the caption.',
    },
    reason: REASON_PROPERTY,
  },
  additionalProperties: false,
} as const;

export const COLLAPSE_OUTPUT_DESCRIPTION =
  'Collapse finished tool call+result pairs to a short `[TOOL CALLED]` marker to reclaim context. REVERSIBLE: ' +
  'only the outgoing request is edited; the session history is untouched and the user can restore with ' +
  '/context-edit. Targets tool pairs only. Address by recency among the pairs in context (1 = most recent): ' +
  '`drop: [2]` collapses the 2nd-most-recent; `keepRecent: N` collapses everything beyond the most recent N; ' +
  '`toolName` filters to one tool. Collapse a finished batch at once rather than one result per turn (each ' +
  'change re-pays the prompt cache). The most recent pair is protected.';

export const DROP_IMAGE_DESCRIPTION =
  'Drop images you are finished with from context, replaced by a placeholder carrying your `summary` as the ' +
  'caption. REVERSIBLE: only the outgoing request is edited; the user can restore with /context-edit. Targets ' +
  'images only (tool-result images and user attachments). Address by recency among images in context (1 = most ' +
  'recent): `drop: [2]` or `keepRecent: N`. Drop a batch at once; the most recent image is protected.';

export interface DropInput {
  drop?: number[];
  keepRecent?: number;
  toolName?: string;
  summary?: string;
  reason?: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function optionalString(raw: Record<string, unknown>, key: string): string | undefined | null {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return null;
  return v.trim() || undefined;
}

/** Validate a `collapse_output` / `drop_image` input. Unknown keys are rejected so typos surface. */
export function parseDropInput(raw: unknown, allowed: readonly ('toolName' | 'summary')[]): ParseResult<DropInput> {
  if (!isRecord(raw)) return { ok: false, error: 'Input must be an object.' };
  const known = new Set(['drop', 'keepRecent', 'reason', ...allowed]);
  const extra = Object.keys(raw).filter((k) => !known.has(k));
  if (extra.length > 0) return { ok: false, error: `Unknown field(s): ${extra.join(', ')}.` };
  const value: DropInput = {};
  if (raw.drop !== undefined) {
    if (!Array.isArray(raw.drop)) return { ok: false, error: '`drop` must be an array of positive integers.' };
    const drop = raw.drop as unknown[];
    if (!drop.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 1)) {
      return { ok: false, error: '`drop` must be an array of positive integers.' };
    }
    if (drop.length > 0) value.drop = drop as number[];
  }
  if (raw.keepRecent !== undefined) {
    const k = raw.keepRecent;
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 0) {
      return { ok: false, error: '`keepRecent` must be a non-negative integer.' };
    }
    value.keepRecent = k;
  }
  for (const key of ['reason', ...allowed] as const) {
    const v = optionalString(raw, key);
    if (v === null) return { ok: false, error: `\`${key}\` must be a string.` };
    if (v !== undefined) value[key] = v;
  }
  if (value.drop === undefined && value.keepRecent === undefined) {
    return {
      ok: false,
      error: 'Specify `drop` (recency ordinals, e.g. [2]) and/or `keepRecent` (keep the most recent N).',
    };
  }
  return { ok: true, value };
}

export type DropPlan =
  | { kind: 'none'; message: string }
  | { kind: 'confirm'; resolution: DropResolution; summary: string; keys: string[] };

/**
 * Resolve a validated input against the current candidates (already
 * filtered to tool pairs or images) and describe what would drop.
 */
export function planDrop(
  candidates: readonly Candidate[],
  input: DropInput,
  tailGuard: number,
  noun: { one: string; many: string },
): DropPlan {
  let pool = candidates;
  const want = input.toolName?.toLowerCase();
  if (want) pool = pool.filter((c) => (c.toolName ?? '').toLowerCase() === want);
  if (pool.length === 0) {
    return {
      kind: 'none',
      message: `No ${noun.many}${want ? ` from "${input.toolName}"` : ''} in the current context.`,
    };
  }
  const resolution = resolveRecencyTargets(pool, { drop: input.drop, keepRecent: input.keepRecent }, tailGuard);
  if (resolution.selected.length === 0) {
    const notes: string[] = [];
    if (resolution.guarded.length > 0)
      notes.push(`the most recent ${resolution.tailGuard} ${noun.one}(s) are protected`);
    if (resolution.missing.length > 0) notes.push(`nothing at ${resolution.missing.map((m) => `#${m}`).join(', ')}`);
    return {
      kind: 'none',
      message: `Nothing to drop (${pool.length} ${noun.many} in context${notes.length ? `; ${notes.join('; ')}` : ''}).`,
    };
  }
  const lines = resolution.selected.map((r) => `#${r.ordinal} ${candidateLabel(r.candidate)}`);
  return {
    kind: 'confirm',
    resolution,
    summary: lines.join('\n'),
    keys: resolution.selected.map((r) => candidateKey(r.candidate)),
  };
}

/** Tool reply after the directives were stored. */
export function dropReply(verb: string, plan: Extract<DropPlan, { kind: 'confirm' }>, applied: number): string {
  const ords = plan.resolution.selected.map((r) => `#${r.ordinal}`).join(', ');
  const guarded =
    plan.resolution.guarded.length > 0
      ? ` Protected: ${plan.resolution.guarded.map((r) => `#${r.ordinal}`).join(', ')}.`
      : '';
  const missing =
    plan.resolution.missing.length > 0
      ? ` No candidate at ${plan.resolution.missing.map((m) => `#${m}`).join(', ')}.`
      : '';
  return `${verb} ${applied} (${ords}) from the next request on. The user can restore with /context-edit.${guarded}${missing}\n${plan.summary}`;
}

// ──────────────────────────────────────────────────────────────────────
// Debug projection
// ──────────────────────────────────────────────────────────────────────

export interface Projection {
  /** Estimated payload bytes of the outgoing messages (text, tool input/output, media). */
  bytes: number;
  /** One line per part: `role[id] type: snippet`. */
  lines: string[];
}

/** Summarize the outgoing messages for the `debugFile` dump. */
export function describeProjection(messages: readonly OcMessage[], snippetChars = 120): Projection {
  let bytes = 0;
  const lines: string[] = [];
  for (const m of messages) {
    for (const p of m.content) {
      let text = '';
      let size = 0;
      if (p.type === 'text' || p.type === 'reasoning') {
        text = str(p.text) ?? '';
        size = byteLen(text);
      } else if (p.type === 'tool-call') {
        text = `${str(p.name) ?? ''} ${JSON.stringify(p.input) ?? ''}`;
        size = jsonBytes(p.input);
      } else if (p.type === 'tool-result') {
        const items = resultContent(p.result);
        text = items.map((it) => (it.type === 'text' ? it.text : `[file ${it.mime}]`)).join(' ');
        size = items.reduce((n, it) => n + (it.type === 'text' ? byteLen(it.text) : fileBytes(it.uri)), 0);
      } else if (p.type === 'media') {
        const info = mediaInfo(p);
        text = `[media ${info.mime}]`;
        size = info.bytes;
      }
      bytes += size;
      lines.push(`${m.role}${m.id ? `[${m.id}]` : ''} ${p.type} ${size}B: ${snippetOf(text, snippetChars)}`);
    }
  }
  return { bytes, lines };
}

// ──────────────────────────────────────────────────────────────────────
// RPC inputs and restore
// ──────────────────────────────────────────────────────────────────────

export interface RpcRequest {
  sessionID: string;
  keys?: string[];
  ids?: number[];
  reason?: string;
}

/**
 * Validate an RPC input (`list` / `apply` / `restore` in the plugin's
 * `rpc.ts`). opencode checks the JSON Schema first; this narrows the
 * `unknown` it hands the handler.
 */
export function parseRpcRequest(raw: unknown): ParseResult<RpcRequest> {
  if (!isRecord(raw) || typeof raw.sessionID !== 'string' || raw.sessionID === '') {
    return { ok: false, error: 'sessionID is required' };
  }
  const value: RpcRequest = { sessionID: raw.sessionID };
  if (raw.keys !== undefined) {
    if (!Array.isArray(raw.keys) || !(raw.keys as unknown[]).every((k) => typeof k === 'string')) {
      return { ok: false, error: 'keys must be strings' };
    }
    value.keys = raw.keys as string[];
  }
  if (raw.ids !== undefined) {
    if (!Array.isArray(raw.ids) || !(raw.ids as unknown[]).every((n) => typeof n === 'number' && Number.isInteger(n))) {
      return { ok: false, error: 'ids must be integers' };
    }
    value.ids = raw.ids as number[];
  }
  if (typeof raw.reason === 'string' && raw.reason.trim()) value.reason = raw.reason.trim();
  return { ok: true, value };
}

export interface RestoreOutcome {
  state: ContextEditState;
  restored: number[];
  missing: number[];
}

/** Drop the given directive ids, or every collapse / trim directive when `ids` is omitted. */
export function restoreDirectives(state: ContextEditState, ids?: readonly number[]): RestoreOutcome {
  const want = ids ? new Set(ids) : undefined;
  const restored: number[] = [];
  const directives = state.directives.filter((d) => {
    const drop = (d.kind === 'collapse' || d.kind === 'trim') && (!want || want.has(d.id));
    if (drop) restored.push(d.id);
    return !drop;
  });
  const missing = ids ? ids.filter((id) => !restored.includes(id)) : [];
  return { state: { directives, nextId: state.nextId }, restored, missing };
}

// ──────────────────────────────────────────────────────────────────────
// RPC outputs (TUI side)
// ──────────────────────────────────────────────────────────────────────

export interface CandidateRow {
  key: string;
  kind: 'collapse' | 'trim';
  label: string;
  bytes: number;
}

export interface ListOutput {
  candidates: CandidateRow[];
  directives: DirectiveRow[];
}

/** RPC `list` rows for one session: TUI-sized tool pairs plus every image, heaviest first. */
export function buildListOutput(
  records: readonly ContentRecord[],
  state: ContextEditState,
  opts: CandidateOptions,
): ListOutput {
  const { tools, images } = buildCandidates(records, state, opts);
  const rows = heaviestFirst([...tools, ...images]).map((c): CandidateRow => ({
    key: candidateKey(c),
    kind: c.kind === 'image' ? 'trim' : 'collapse',
    label: candidateLabel(c),
    bytes: c.bytes,
  }));
  return { candidates: rows, directives: describeDirectives(state, records) };
}

function isKind(v: unknown): v is 'collapse' | 'trim' {
  return v === 'collapse' || v === 'trim';
}

/** Narrow an RPC `list` result (typed `unknown` by the JSON Schema contract). */
export function parseListOutput(raw: unknown): ListOutput {
  const out: ListOutput = { candidates: [], directives: [] };
  if (!isRecord(raw)) return out;
  for (const c of Array.isArray(raw.candidates) ? (raw.candidates as unknown[]) : []) {
    if (!isRecord(c) || typeof c.key !== 'string' || !isKind(c.kind) || typeof c.label !== 'string') continue;
    out.candidates.push({ key: c.key, kind: c.kind, label: c.label, bytes: typeof c.bytes === 'number' ? c.bytes : 0 });
  }
  for (const d of Array.isArray(raw.directives) ? (raw.directives as unknown[]) : []) {
    if (!isRecord(d) || typeof d.id !== 'number' || !isKind(d.kind) || typeof d.label !== 'string') continue;
    out.directives.push({ id: d.id, kind: d.kind, label: d.label, stale: d.stale === true });
  }
  return out;
}

/** Narrow an RPC `apply` / `restore` result to its message. */
export function parseResultMessage(raw: unknown): string {
  return isRecord(raw) && typeof raw.message === 'string' ? raw.message : 'Done.';
}
