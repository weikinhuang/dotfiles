/**
 * Pure helpers for the opencode `statusline` TUI plugin
 * (`config/opencode/plugins/statusline/`), a port of the pi `statusline`
 * extension that adds to opencode's native prompt footer instead of
 * replacing it.
 *
 * The native footer already shows the directory and branch, context tokens
 * and percent, session cost, running subagents / shells, and (in the prompt's
 * metadata row) agent, model, provider, and variant. This module only builds
 * what is missing: git decoration, linked-worktree name, prompt-cache hit
 * ratio, cache-write tokens, tool-call count, short session id, `user#host`,
 * and an opt-in last-step token breakdown.
 *
 * Covers config resolution (`OPENCODE_STATUSLINE_*`), usage extraction from
 * session messages, segment building, and priority-based width fitting.
 *
 * Pure module - no opencode imports. Message shapes are structural subsets
 * of `@opencode/client` types.
 */

import { cacheHitRatioPct, fmtSi, formatUsageLine } from '../pi/token-format.ts';
import { createOptionReader, type EnvBag, type PluginOptionBag } from './plugin-options.ts';

/** Env override prefix: option `segments` -> `OPENCODE_STATUSLINE_SEGMENTS`. */
export const OPENCODE_STATUSLINE_ENV_PREFIX = 'OPENCODE_STATUSLINE_';

/** Segment ids in display order. */
export const SEGMENT_IDS = ['git', 'worktree', 'cache', 'tokens', 'write', 'tools', 'id', 'user'] as const;
export type SegmentId = (typeof SEGMENT_IDS)[number];

/** Segments shown when `segments` is unset (`tokens` is opt-in). */
export const DEFAULT_SEGMENTS: readonly SegmentId[] = ['git', 'worktree', 'cache', 'write', 'tools', 'id', 'user'];

/** Drop order under width pressure: lower survives longer. */
const SEGMENT_PRIORITY: Readonly<Record<SegmentId, number>> = {
  git: 1,
  worktree: 2,
  cache: 3,
  tools: 4,
  write: 5,
  tokens: 6,
  id: 7,
  user: 8,
};

/** Theme role a segment is painted with; the TUI shell maps it to a color. */
export type SegmentTone = 'muted' | 'git' | 'worktree' | 'good' | 'warn';

export interface Segment {
  id: SegmentId;
  text: string;
  tone: SegmentTone;
}

/** Resolved plugin configuration. */
export interface StatuslineConfig {
  enabled: boolean;
  /** Enabled segments, in display order. */
  segments: SegmentId[];
  /** Run `__git_ps1` for the git segment. */
  gitPrompt: boolean;
  /** Repeat the branch name inside the git segment. */
  gitBranch: boolean;
  /** Extra periodic git refresh, in seconds; `0` keeps it purely event-driven. */
  gitIntervalSeconds: number;
}

function isSegmentId(word: string): word is SegmentId {
  return (SEGMENT_IDS as readonly string[]).includes(word);
}

/**
 * Parse a segment list: `git,cache,id` picks exactly those; entries that all
 * start with `+` / `-` edit {@link DEFAULT_SEGMENTS} (`+tokens,-user`);
 * `all` / `none` are shorthands. Unknown ids are ignored; display order is
 * always {@link SEGMENT_IDS}. Returns `undefined` for a non-string or blank
 * value so the next layer applies.
 */
export function parseSegmentList(raw: unknown): SegmentId[] | undefined {
  if (typeof raw !== 'string' && !Array.isArray(raw)) return undefined;
  const words = (typeof raw === 'string' ? raw.split(/[\s,]+/) : (raw as unknown[]))
    .filter((w): w is string => typeof w === 'string')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  if (words.length === 0) return undefined;
  if (words.length === 1 && words[0] === 'all') return [...SEGMENT_IDS];
  if (words.length === 1 && words[0] === 'none') return [];
  const picked = new Set<SegmentId>();
  if (words.every((w) => w.startsWith('+') || w.startsWith('-'))) {
    for (const id of DEFAULT_SEGMENTS) picked.add(id);
    for (const w of words) {
      const id = w.slice(1);
      if (!isSegmentId(id)) continue;
      if (w.startsWith('+')) picked.add(id);
      else picked.delete(id);
    }
  } else {
    for (const w of words) if (isSegmentId(w)) picked.add(w);
  }
  return SEGMENT_IDS.filter((id) => picked.has(id));
}

/**
 * Resolve {@link StatuslineConfig} from plugin options with
 * `OPENCODE_STATUSLINE_*` env overrides. TUI parts get empty options in
 * opencode 2.2.7, so env is the working layer.
 */
export function resolveStatuslineConfig(options: PluginOptionBag | undefined, env: EnvBag): StatuslineConfig {
  const read = createOptionReader(options, env, OPENCODE_STATUSLINE_ENV_PREFIX);
  return {
    enabled: read.bool('enabled', true),
    segments: read.get('segments', parseSegmentList) ?? [...DEFAULT_SEGMENTS],
    gitPrompt: read.bool('gitPrompt', true),
    gitBranch: read.bool('gitBranch', false),
    gitIntervalSeconds: read.number('gitInterval', 0),
  };
}

/** `TokenUsageInfo` from `@opencode/client`. */
export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

/** Structural subset of `SessionMessageInfo` this module reads. */
export interface MessageLike {
  id: string;
  type: string;
  status?: string;
  tokens?: TokenUsage;
  content?: readonly { type: string }[];
}

/** Sum of every token bucket, as the native footer counts context usage. */
export function totalTokens(t: TokenUsage): number {
  return t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
}

/**
 * Last assistant step with usage, mirroring `lastAssistantWithUsage` from
 * `@opencode/client/solid`: only steps after the last completed compaction
 * and before the revert `boundary` message count.
 */
export function lastStepUsage(messages: readonly MessageLike[], boundary?: string): TokenUsage | undefined {
  const boundaryIndex = boundary ? messages.findIndex((m) => m.id === boundary) : -1;
  if (boundary && boundaryIndex === -1) return undefined;
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex;
  for (let i = end - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.type === 'compaction' && m.status === 'completed') return undefined;
    if (m.type === 'assistant' && m.tokens && totalTokens(m.tokens) > 0) return m.tokens;
  }
  return undefined;
}

/** Tool calls across every assistant step. */
export function countToolCalls(messages: readonly MessageLike[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.type !== 'assistant' || !m.content) continue;
    for (const part of m.content) if (part.type === 'tool') n++;
  }
  return n;
}

/** Cache-hit percent over `input + cache.read` (same formula as pi). */
export function cacheRatio(t: TokenUsage | undefined): number | null {
  if (!t) return null;
  return cacheHitRatioPct({ input: t.input, cacheRead: t.cache.read });
}

/**
 * Short session id: the last 8 characters. opencode ids are
 * `ses_<12 hex timestamp><14 random>`, so the head is shared by sessions
 * created close together while the tail is random.
 */
export function shortSessionId(id: string | undefined): string {
  if (!id) return '';
  const bare = id.replace(/^ses_/, '');
  return bare.slice(-8);
}

export interface SegmentInput {
  /** `formatGitDecoration` output; `''` hides the segment. */
  git?: string;
  worktree?: string | null;
  sessionID?: string;
  /** Last step with usage, from {@link lastStepUsage}. */
  last?: TokenUsage;
  /** Session totals (`SessionInfo.tokens`). */
  session?: TokenUsage;
  toolCalls?: number;
  user?: string;
}

/** Build the enabled, non-empty segments in display order. */
export function buildSegments(input: SegmentInput, enabled: readonly SegmentId[]): Segment[] {
  const on = new Set(enabled);
  const out: Segment[] = [];
  const add = (id: SegmentId, text: string | undefined, tone: SegmentTone = 'muted'): void => {
    if (on.has(id) && text) out.push({ id, text, tone });
  };
  add('git', input.git, 'git');
  add('worktree', input.worktree ? `⎇ ${input.worktree}` : undefined, 'worktree');
  const lastPct = cacheRatio(input.last);
  const sessionPct = cacheRatio(input.session);
  if (lastPct !== null || sessionPct !== null) {
    const lastText = lastPct === null ? '-' : `${lastPct}%`;
    const text = sessionPct === null || sessionPct === lastPct ? `R ${lastText}` : `R ${lastText}/${sessionPct}%`;
    const pct = lastPct ?? sessionPct ?? 0;
    add('cache', text, pct >= 50 ? 'good' : 'warn');
  }
  if (input.last) {
    const { input: inp, output, cache } = input.last;
    add('tokens', formatUsageLine({ input: inp, cacheRead: cache.read, output }));
  }
  const write = input.session?.cache.write ?? 0;
  add('write', write > 0 ? `W ${fmtSi(write)}` : undefined);
  add('tools', input.toolCalls ? `⚒ ${input.toolCalls}` : undefined);
  const sid = shortSessionId(input.sessionID);
  add('id', sid ? `§${sid}` : undefined);
  add('user', input.user);
  return out;
}

/** Separator between segments, matching the native footer. */
export const SEGMENT_SEPARATOR = ' · ';

/**
 * Terminal cell width. Counts code points, with East Asian wide / emoji
 * ranges as two cells; every glyph this module emits (`⎇ ⚒ § ↑ ↓ ↻`) is one.
 */
export function cellWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x300 && cp < 0x370) || cp === 0x200d || cp === 0xfe0f) {
      continue;
    }
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

/** Rendered width of `segments` joined with {@link SEGMENT_SEPARATOR}. */
export function segmentsWidth(segments: readonly Segment[]): number {
  if (segments.length === 0) return 0;
  return segments.reduce((sum, s) => sum + cellWidth(s.text), 0) + cellWidth(SEGMENT_SEPARATOR) * (segments.length - 1);
}

/**
 * Drop the lowest-priority segments until the rest fit in `budget` cells,
 * keeping display order. Returns `[]` when even the top segment does not fit.
 */
export function fitSegments(segments: readonly Segment[], budget: number): Segment[] {
  const kept = [...segments];
  while (kept.length > 0 && segmentsWidth(kept) > budget) {
    let worst = 0;
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i];
      const b = kept[worst];
      if (a && b && SEGMENT_PRIORITY[a.id] >= SEGMENT_PRIORITY[b.id]) worst = i;
    }
    kept.splice(worst, 1);
  }
  return kept;
}

/** `Locale.number` from opencode's TUI: `1.2K`, `3.4M`. */
export function nativeNumber(n: number): string {
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

/**
 * The native prompt footer's usage text (`12.3K (6%) · $0.04`), or `''` when
 * it shows none. Mirrors `opencode.prompt.footer` so the budget can leave
 * room for it.
 */
export function nativeUsageText(input: { last?: TokenUsage; contextLimit?: number; cost: number }): string {
  const parts: string[] = [];
  if (input.last) {
    const tokens = totalTokens(input.last);
    const pct = input.contextLimit ? Math.round((tokens / input.contextLimit) * 100) : undefined;
    parts.push(pct === undefined ? nativeNumber(tokens) : `${nativeNumber(tokens)} (${pct}%)`);
  }
  if (input.cost > 0) parts.push(`$${input.cost.toFixed(2)}`);
  return parts.join(SEGMENT_SEPARATOR);
}

/** Gap between footer row children (`gap={2}` on the host row). */
export const FOOTER_GAP = 2;
/** Cells kept for the native `<dir>:<branch>` label (or the running spinner) before our segments. */
export const LOCATION_RESERVE = 24;

/**
 * Width the native footer occupies, replicating `promptFooterLayout`, which
 * decides from the terminal width: with usage, usage and the command shortcut
 * each show only while they fit in `width - 8` minus `min(28, half)`;
 * without usage, the agent and command shortcuts show from 44 columns.
 */
export function nativeFooterWidth(input: {
  /** Terminal columns. */
  width: number;
  usage: string;
  /** `command.palette.show` binding, e.g. `ctrl+p`. */
  shortcut?: string;
  /** `agent.cycle` binding, e.g. `tab`. */
  agentShortcut?: string;
}): number {
  const shortcut = input.shortcut ? `${input.shortcut} commands` : '';
  if (!input.usage) {
    if (input.width < 44) return 0;
    const texts = [input.agentShortcut ? `${input.agentShortcut} agents` : '', shortcut].filter(Boolean);
    if (texts.length === 0) return 0;
    return texts.reduce((sum, t) => sum + cellWidth(t), 0) + FOOTER_GAP * (texts.length - 1);
  }
  const width = Math.max(0, input.width - 8);
  const available = Math.max(0, width - Math.min(28, Math.floor(width / 2)));
  const usage = cellWidth(input.usage);
  // The host renders usage and shortcut as separate texts in a gap-2 row.
  if (shortcut && usage + cellWidth(SEGMENT_SEPARATOR) + cellWidth(shortcut) <= available) {
    return usage + FOOTER_GAP + cellWidth(shortcut);
  }
  return usage <= available ? usage : 0;
}

/**
 * Cells left for the statusline in a footer row `rowWidth` wide, after the
 * native footer, the location label (up to {@link LOCATION_RESERVE}), and the
 * row gaps.
 */
export function statuslineBudget(input: { rowWidth: number; nativeWidth: number; locationWidth: number }): number {
  const location = Math.min(input.locationWidth, LOCATION_RESERVE);
  const gaps = FOOTER_GAP * (input.nativeWidth > 0 ? 2 : 1);
  return Math.max(0, input.rowWidth - input.nativeWidth - location - gaps);
}
