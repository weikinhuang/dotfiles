/**
 * Pure breakdown builder for `/context`. Turns the plain `BreakdownInput`
 * (adapted from pi APIs by the extension shell) into the treemap of
 * `CategoryNode`s the overlay renders. No pi imports.
 *
 * Token sizing replicates pi's own `estimateTokens` (chars / 4, images at
 * 4800 chars) so our numbers reconcile with `ctx.getContextUsage()`.
 *
 * Treemap invariant: for every node except the root, `node.tokens ===
 * Σ children.tokens`. The root's `tokens` is the whole context window, so
 * the difference (`window − Σ used categories`) is the free tail the grid
 * paints and the legend lists as "Free space".
 */

import type {
  Breakdown,
  BreakdownInput,
  CategoryNode,
  ContentPartLike,
  MessageLike,
  ToolInfoLike,
  UsageLike,
} from './types.ts';

const IMAGE_CHARS = 4800;

/** chars → tokens, matching pi's `Math.ceil(chars / 4)`. */
export function charsToTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

function contentChars(content: string | ContentPartLike[] | undefined): number {
  if (content == null) return 0;
  if (typeof content === 'string') return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length;
    else if (block.type === 'image') chars += IMAGE_CHARS;
  }
  return chars;
}

function countImages(content: string | ContentPartLike[] | undefined): number {
  if (!content || typeof content === 'string') return 0;
  let n = 0;
  for (const block of content) if (block.type === 'image') n++;
  return n;
}

function safeJsonLen(value: unknown): number {
  try {
    return JSON.stringify(value ?? '').length;
  } catch {
    return 0;
  }
}

function safeJsonPretty(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return '';
  }
}

/** Per-message token estimate (mirrors pi's `estimateTokens`). */
export function estimateMessageTokens(message: MessageLike): number {
  switch (message.role) {
    case 'user':
      return charsToTokens(contentChars(message.content));
    case 'assistant': {
      let chars = 0;
      for (const block of message.content) {
        if (block.type === 'text') chars += block.text.length;
        else if (block.type === 'thinking') chars += block.thinking.length;
        else if (block.type === 'toolCall') chars += block.name.length + safeJsonLen(block.arguments);
      }
      return charsToTokens(chars);
    }
    case 'custom':
    case 'toolResult':
      return charsToTokens(contentChars(message.content));
    case 'bashExecution':
      return charsToTokens(message.command.length + message.output.length);
    case 'branchSummary':
    case 'compactionSummary':
      return charsToTokens(message.summary.length);
    default:
      return 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Small helpers for building nodes whose children sum to the parent.
// ──────────────────────────────────────────────────────────────────────────

function sumTokens(nodes: readonly CategoryNode[]): number {
  let s = 0;
  for (const n of nodes) s += n.tokens;
  return s;
}

/** Drop zero-token children but never drop them all silently. */
function nonZero(nodes: CategoryNode[]): CategoryNode[] {
  const kept = nodes.filter((n) => n.tokens > 0);
  return kept;
}

// ──────────────────────────────────────────────────────────────────────────
// System prompt
// ──────────────────────────────────────────────────────────────────────────

/**
 * Best-effort split of the injected-addenda blob (the suffix of the
 * effective prompt beyond the base) into labeled sections. Splits on blank
 * lines and uses the first non-empty line as the label. Returns [] when it
 * can't find a clean tail (caller then shows a single row).
 */
export function splitInjectedAddenda(effective: string, base: string): CategoryNode[] {
  if (!effective.startsWith(base.slice(0, Math.min(base.length, 200)))) {
    // Effective doesn't obviously extend base; bail to a single row.
    return [];
  }
  const tail = effective.slice(base.length);
  const blocks = tail
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  if (blocks.length <= 1) return [];
  return blocks.map((block, i) => {
    const firstLine = block
      .split('\n', 1)[0]
      .replace(/[#>*\-:\s]+$/, '')
      .slice(0, 48);
    return {
      id: `sys.injected.${i}`,
      label: firstLine || `section ${i + 1}`,
      tokens: charsToTokens(block.length),
      content: block,
    };
  });
}

function buildSystemPromptNode(input: BreakdownInput): CategoryNode {
  const opts = input.systemPromptOptions;
  const totalTokens = charsToTokens(input.effectiveSystemPrompt.length);

  const children: CategoryNode[] = [];

  // Context files - each AGENTS.md / CLAUDE.md, sized individually.
  const files = opts.contextFiles ?? [];
  if (files.length > 0) {
    const fileNodes = files.map((f) => ({
      id: `sys.ctx.${f.path}`,
      label: f.path,
      tokens: charsToTokens(f.content.length),
      detail: `${f.content.length.toLocaleString()} bytes`,
      content: f.content,
    }));
    children.push({
      id: 'sys.contextFiles',
      label: `Context files (${files.length})`,
      tokens: sumTokens(fileNodes),
      children: fileNodes.sort((a, b) => b.tokens - a.tokens),
    });
  }

  // Skills - approximate per skill from name + description + body.
  const skills = opts.skills ?? [];
  if (skills.length > 0) {
    const skillNodes = skills.map((s, i) => {
      const chars = (s.name?.length ?? 0) + (s.description?.length ?? 0) + (s.body?.length ?? 0);
      const body = s.body && s.body.length > 0 ? s.body : s.description;
      return {
        id: `sys.skill.${i}`,
        label: s.name ?? s.path ?? `skill ${i + 1}`,
        tokens: charsToTokens(chars),
        detail: s.description,
        content: body,
      };
    });
    children.push({
      id: 'sys.skills',
      label: `Skills index (${skills.length})`,
      tokens: sumTokens(skillNodes),
      children: skillNodes.sort((a, b) => b.tokens - a.tokens),
    });
  }

  // Tool one-line snippets section (NOT schemas - those are System tools).
  const snippets = opts.toolSnippets ?? {};
  const snippetNames = Object.keys(snippets);
  if (snippetNames.length > 0) {
    let chars = 0;
    for (const name of snippetNames) chars += name.length + snippets[name].length + 4;
    children.push({
      id: 'sys.toolSnippets',
      label: 'Tool snippets',
      tokens: charsToTokens(chars),
      content: snippetNames.map((name) => `${name}\n  ${snippets[name]}`).join('\n\n'),
    });
  }

  // Guidelines.
  const guidelines = opts.promptGuidelines ?? [];
  if (guidelines.length > 0) {
    let chars = 0;
    for (const g of guidelines) chars += g.length + 3;
    children.push({
      id: 'sys.guidelines',
      label: 'Guidelines',
      tokens: charsToTokens(chars),
      content: guidelines.join('\n\n'),
    });
  }

  // appendSystemPrompt.
  if (opts.appendSystemPrompt && opts.appendSystemPrompt.length > 0) {
    children.push({
      id: 'sys.append',
      label: 'Appended prompt',
      tokens: charsToTokens(opts.appendSystemPrompt.length),
    });
  }

  // Injected per-turn addenda = effective − base.
  const injectedChars = Math.max(0, input.effectiveSystemPrompt.length - input.baseSystemPrompt.length);
  if (injectedChars > 0) {
    const sections = splitInjectedAddenda(input.effectiveSystemPrompt, input.baseSystemPrompt);
    children.push({
      id: 'sys.injected',
      label: 'Injected addenda',
      tokens: charsToTokens(injectedChars),
      detail: 'per-turn: todo / scratchpad / memory / context-budget …',
      children: sections.length > 1 ? sections : undefined,
    });
  }

  // Remainder = core instructions & framing (default prompt body + date/cwd
  // + structural wrapper): whatever the effective-prompt estimate has beyond
  // the measured parts. We can't cleanly slice the remainder out of the base
  // prompt, so the content viewer shows the full captured base prompt (the
  // other measured sections are subsets of it).
  const remainder = Math.max(0, totalTokens - sumTokens(children));
  const baseText = input.baseSystemPrompt;
  const coreContent =
    baseText.length > 0
      ? `[ Full captured base system prompt – the measured sections (guidelines, tool snippets,\n  skills, context files) are subsets of the text below. ]\n\n${baseText}`
      : undefined;
  children.unshift({
    id: 'sys.core',
    label: 'Core instructions & framing',
    tokens: remainder,
    content: coreContent,
  });

  const kept = nonZero(children).sort((a, b) => b.tokens - a.tokens);
  return {
    id: 'sys',
    label: 'System prompt',
    tokens: sumTokens(kept),
    children: kept,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// System tools (serialized schemas)
// ──────────────────────────────────────────────────────────────────────────

function toolSchemaChars(tool: ToolInfoLike): { total: number; desc: number; params: number; name: number } {
  const name = tool.name.length;
  const desc = tool.description?.length ?? 0;
  const params = safeJsonLen(tool.parameters);
  return { total: name + desc + params, desc, params, name };
}

function buildToolsNode(input: BreakdownInput): CategoryNode {
  const active = new Set(input.activeToolNames);
  const activeTools = input.allTools.filter((t) => active.has(t.name));
  const inactive = input.allTools.filter((t) => !active.has(t.name));

  const toolNodes = activeTools.map((t) => {
    const c = toolSchemaChars(t);
    const children: CategoryNode[] = [
      {
        id: `tool.${t.name}.params`,
        label: 'parameters schema',
        tokens: charsToTokens(c.params),
        content: safeJsonPretty(t.parameters),
      },
      {
        id: `tool.${t.name}.desc`,
        label: 'description',
        tokens: charsToTokens(c.desc + c.name),
        content: t.description,
      },
    ];
    return {
      id: `tool.${t.name}`,
      label: t.name,
      tokens: charsToTokens(c.total),
      children: nonZero(children),
    };
  });

  toolNodes.sort((a, b) => b.tokens - a.tokens);

  const node: CategoryNode = {
    id: 'tools',
    label: `System tools (${activeTools.length})`,
    tokens: sumTokens(toolNodes),
    children: toolNodes,
  };
  if (inactive.length > 0) {
    node.detail = `${inactive.length} configured but inactive (not sent)`;
  }
  return node;
}

// ──────────────────────────────────────────────────────────────────────────
// Conversation
// ──────────────────────────────────────────────────────────────────────────

function fullContentText(content: string | ContentPartLike[] | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  let text = '';
  for (const block of content) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'image') text += '[image]\n';
  }
  return text;
}

function previewContent(content: string | ContentPartLike[] | undefined): string | undefined {
  if (content == null) return undefined;
  let text = '';
  if (typeof content === 'string') text = content;
  else {
    for (const block of content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'image') text += '[image]';
      if (text.length > 120) break;
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return undefined;
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

const DEFAULT_TOP_N = 8;

function buildConversationNode(input: BreakdownInput, topN = DEFAULT_TOP_N): CategoryNode {
  const messages = input.messages;

  let userTok = 0;
  let assistantText = 0;
  let assistantThinking = 0;
  let assistantToolArgs = 0;
  let bashTok = 0;
  let summaryTok = 0;
  let imageCount = 0;
  let imageTok = 0;
  const customByType = new Map<string, number>();
  // tool results grouped by tool name, retaining individual entries for drill.
  const toolGroups = new Map<string, { tokens: number; entries: CategoryNode[] }>();

  messages.forEach((m, idx) => {
    switch (m.role) {
      case 'user': {
        userTok += estimateMessageTokens(m);
        const imgs = countImages(m.content);
        imageCount += imgs;
        imageTok += charsToTokens(imgs * IMAGE_CHARS);
        break;
      }
      case 'assistant': {
        for (const block of m.content) {
          if (block.type === 'text') assistantText += charsToTokens(block.text.length);
          else if (block.type === 'thinking') assistantThinking += charsToTokens(block.thinking.length);
          else if (block.type === 'toolCall')
            assistantToolArgs += charsToTokens(block.name.length + safeJsonLen(block.arguments));
        }
        break;
      }
      case 'toolResult': {
        const name = m.toolName && m.toolName.length > 0 ? m.toolName : 'unknown';
        const tok = estimateMessageTokens(m);
        const imgs = countImages(m.content);
        imageCount += imgs;
        imageTok += charsToTokens(imgs * IMAGE_CHARS);
        const g = toolGroups.get(name) ?? { tokens: 0, entries: [] };
        g.tokens += tok;
        g.entries.push({
          id: `conv.tool.${name}.${idx}`,
          label: `#${idx + 1}${m.isError ? ' (error)' : ''}`,
          tokens: tok,
          detail: previewContent(m.content),
          content: fullContentText(m.content),
        });
        toolGroups.set(name, g);
        break;
      }
      case 'bashExecution':
        bashTok += estimateMessageTokens(m);
        break;
      case 'custom': {
        const type = m.customType && m.customType.length > 0 ? m.customType : 'custom';
        customByType.set(type, (customByType.get(type) ?? 0) + estimateMessageTokens(m));
        break;
      }
      case 'branchSummary':
      case 'compactionSummary':
        summaryTok += estimateMessageTokens(m);
        break;
      default:
        break;
    }
  });

  const children: CategoryNode[] = [];
  if (userTok > 0) children.push({ id: 'conv.user', label: 'User messages', tokens: userTok });

  const assistantChildren = nonZero([
    { id: 'conv.asst.text', label: 'Response text', tokens: assistantText },
    {
      id: 'conv.asst.think',
      label: 'Retained reasoning',
      tokens: assistantThinking,
      detail: 'thinking blocks still in context',
    },
    { id: 'conv.asst.args', label: 'Tool-call args', tokens: assistantToolArgs },
  ]);
  if (assistantChildren.length > 0) {
    children.push({
      id: 'conv.assistant',
      label: 'Assistant messages',
      tokens: sumTokens(assistantChildren),
      children: assistantChildren.sort((a, b) => b.tokens - a.tokens),
    });
  }

  if (toolGroups.size > 0) {
    const groupNodes: CategoryNode[] = [];
    for (const [name, g] of toolGroups) {
      g.entries.sort((a, b) => b.tokens - a.tokens);
      groupNodes.push({
        id: `conv.tool.${name}`,
        label: name,
        tokens: g.tokens,
        detail: `${g.entries.length} result${g.entries.length === 1 ? '' : 's'}`,
        children: g.entries.slice(0, topN),
      });
    }
    groupNodes.sort((a, b) => b.tokens - a.tokens);
    children.push({
      id: 'conv.toolResults',
      label: 'Tool results',
      tokens: sumTokens(groupNodes),
      children: groupNodes,
    });
  }

  if (bashTok > 0) children.push({ id: 'conv.bash', label: 'Bash executions', tokens: bashTok });

  if (customByType.size > 0) {
    const customNodes: CategoryNode[] = [];
    for (const [type, tok] of customByType) {
      customNodes.push({ id: `conv.custom.${type}`, label: type, tokens: tok });
    }
    customNodes.sort((a, b) => b.tokens - a.tokens);
    children.push({
      id: 'conv.custom',
      label: 'Injected messages',
      tokens: sumTokens(customNodes),
      children: customNodes.length > 1 ? customNodes : undefined,
    });
  }

  if (summaryTok > 0)
    children.push({ id: 'conv.summaries', label: 'Branch / compaction summaries', tokens: summaryTok });

  if (imageTok > 0)
    children.push({
      id: 'conv.images',
      label: `Images (${imageCount})`,
      tokens: imageTok,
      detail: `${imageCount} image${imageCount === 1 ? '' : 's'} ≈ ${IMAGE_CHARS}-char est. each`,
    });

  return {
    id: 'conv',
    label: 'Conversation',
    tokens: sumTokens(children),
    children: children.sort((a, b) => b.tokens - a.tokens),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Top level
// ──────────────────────────────────────────────────────────────────────────

function lastAssistantUsage(messages: readonly MessageLike[]): UsageLike | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.usage) return m.usage;
  }
  return null;
}

/** Build the full breakdown treemap from plain inputs. */
export function buildBreakdown(input: BreakdownInput, opts: { topN?: number } = {}): Breakdown {
  const sys = buildSystemPromptNode(input);
  const tools = buildToolsNode(input);
  const conv = buildConversationNode(input, opts.topN ?? DEFAULT_TOP_N);

  const topLevel = nonZero([sys, tools, conv]);
  const estimatedUsed = sumTokens(topLevel);
  const window = input.contextWindow > 0 ? input.contextWindow : estimatedUsed;

  const root: CategoryNode = {
    id: 'root',
    label: 'Context window',
    tokens: window,
    children: topLevel,
  };

  const lastUsage = lastAssistantUsage(input.messages);

  return {
    root,
    estimatedUsed,
    realTokens: input.realTokens,
    contextWindow: window,
    lastUsage,
    modelId: input.modelId,
    provider: input.provider,
  };
}
