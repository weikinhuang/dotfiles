/**
 * Shared types for the `/context` context-usage breakdown.
 *
 * Pure module - no pi-runtime imports - so the tree builder, grid math,
 * navigation, formatting, and export logic stay vitest-testable under the
 * root `tsconfig.json`. The extension shell (`context-usage.ts`) adapts the
 * real `AgentMessage[]` / `BuildSystemPromptOptions` / `ToolInfo[]` into the
 * structural shapes below, which are intentionally permissive so the runtime
 * objects satisfy them without conversion.
 */

// ──────────────────────────────────────────────────────────────────────────
// Structural message shapes (mirror pi's AgentMessage union, loosely)
// ──────────────────────────────────────────────────────────────────────────

export interface TextPartLike {
  type: 'text';
  text: string;
}
export interface ThinkingPartLike {
  type: 'thinking';
  thinking: string;
  redacted?: boolean;
}
export interface ToolCallPartLike {
  type: 'toolCall';
  id?: string;
  name: string;
  arguments: unknown;
}
export interface ImagePartLike {
  type: 'image';
  data?: string;
  mimeType?: string;
}

/** Blocks that appear in an assistant message. */
export type AssistantPartLike = TextPartLike | ThinkingPartLike | ToolCallPartLike;
/** Blocks that appear in user / toolResult / custom message content arrays. */
export type ContentPartLike = TextPartLike | ImagePartLike;

export interface UserMessageLike {
  role: 'user';
  content: string | ContentPartLike[];
}
export interface AssistantMessageLike {
  role: 'assistant';
  content: AssistantPartLike[];
  usage?: UsageLike;
}
export interface ToolResultMessageLike {
  role: 'toolResult';
  toolName?: string;
  content: string | ContentPartLike[];
  isError?: boolean;
}
export interface BashExecutionMessageLike {
  role: 'bashExecution';
  command: string;
  output: string;
}
export interface CustomMessageLike {
  role: 'custom';
  customType?: string;
  content: string | ContentPartLike[];
}
export interface SummaryMessageLike {
  role: 'branchSummary' | 'compactionSummary';
  summary: string;
}

export type MessageLike =
  | UserMessageLike
  | AssistantMessageLike
  | ToolResultMessageLike
  | BashExecutionMessageLike
  | CustomMessageLike
  | SummaryMessageLike;

/** Provider token usage (mirrors pi-ai `Usage`, fields we read). */
export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Tool + system-prompt inputs
// ──────────────────────────────────────────────────────────────────────────

/** A configured tool (mirrors pi `ToolInfo`, fields we size). */
export interface ToolInfoLike {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** A pre-loaded context file (mirrors `BuildSystemPromptOptions.contextFiles[]`). */
export interface ContextFileLike {
  path: string;
  content: string;
}

/** A pre-loaded skill (mirrors `BuildSystemPromptOptions.skills[]`, fields we size). */
export interface SkillLike {
  name?: string;
  description?: string;
  /** Optional rendered body / instructions, when available. */
  body?: string;
  path?: string;
}

/** Base system-prompt build options (subset of `BuildSystemPromptOptions`). */
export interface SystemPromptOptionsLike {
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd?: string;
  contextFiles?: ContextFileLike[];
  skills?: SkillLike[];
}

/** Everything the tree builder needs, all plain data. */
export interface BreakdownInput {
  /** `ctx.getSystemPrompt()` - effective prompt incl. per-turn injections. */
  effectiveSystemPrompt: string;
  /** `buildSystemPrompt(ctx.getSystemPromptOptions())` - base prompt string. */
  baseSystemPrompt: string;
  /** `ctx.getSystemPromptOptions()`. */
  systemPromptOptions: SystemPromptOptionsLike;
  /** `pi.getAllTools()`. */
  allTools: ToolInfoLike[];
  /** `pi.getActiveTools()` - names currently sent to the provider. */
  activeToolNames: string[];
  /** `buildSessionContext(getBranch()).messages`. */
  messages: MessageLike[];
  /** `ctx.getContextUsage().contextWindow`. */
  contextWindow: number;
  /** `ctx.getContextUsage().tokens` - real total, or null when unknown. */
  realTokens: number | null;
  /** Model id / provider for the header (display only). */
  modelId?: string;
  provider?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// The treemap node model
// ──────────────────────────────────────────────────────────────────────────

/**
 * One node in the drill-down treemap. The root represents the whole context
 * window; each level's children partition their parent's tokens. `tokens` is
 * an estimate (chars/4) unless flagged otherwise via `meta`.
 */
export interface CategoryNode {
  id: string;
  label: string;
  /** Estimated tokens this node occupies. */
  tokens: number;
  /** Theme color token used to paint this node's grid cells / legend marker. */
  color?: string;
  /** Children partitioning `tokens` (omit / empty for leaves). */
  children?: CategoryNode[];
  /** Optional secondary line shown in detail views (path, preview, note). */
  detail?: string;
}

/** Result of building the whole breakdown. */
export interface Breakdown {
  /** Root node: label "Context window", tokens = contextWindow. */
  root: CategoryNode;
  /** Estimated total of all non-free categories. */
  estimatedUsed: number;
  /** Real total from the provider, or null. */
  realTokens: number | null;
  contextWindow: number;
  /** Last-turn provider usage split, when available. */
  lastUsage: UsageLike | null;
  modelId?: string;
  provider?: string;
}
