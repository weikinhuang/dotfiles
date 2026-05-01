/**
 * Subagent — Claude Code / opencode / codex-style task delegation for pi.
 *
 * The parent LLM calls a single `subagent(agent, task)` tool; the
 * extension spawns an in-process child `AgentSession` with its own
 * context window, tool allowlist, and — optionally — a dedicated model
 * or a git-worktree sandbox. The parent only sees the final answer text;
 * all intermediate tool churn stays in the child's own session file.
 *
 * Key shape:
 *
 *   - Single tool, `executionMode: "parallel"`. Parent fans out by
 *     calling it N times; we cap concurrency at `PI_SUBAGENT_CONCURRENCY`
 *     (default 4, hard ceiling 8) so fan-out fan-out can't melt the
 *     machine.
 *   - Agent definitions are Markdown files under:
 *       1. `~/.dotfiles/config/pi/agents/`   (global)
 *       2. `~/.pi/agents/`                   (user)
 *       3. `<cwd>/.pi/agents/`               (project)
 *     Higher layers override by `name`.
 *   - Collapsible renderer (mirrors subdir-agents.ts style) shows a
 *     one-liner while running, the markdown final answer on expand.
 *     Child tool calls are NEVER streamed inline.
 *   - Companion `/agents` command lists loaded agents; `/agents show
 *     <name>` prints the full frontmatter + body of a single agent.
 *
 * This commit ships the extension SKELETON only. The `subagent` tool
 * returns `isError: true` with "not yet wired" — commit 3 replaces the
 * stub with a real `createAgentSession(...)` call + child-session
 * persistence + worktree handling. The loader, renderer, command, and
 * startup plumbing are all real so a hot-reloaded pi picks them up
 * immediately and `/agents` already works.
 *
 * Environment:
 *   PI_SUBAGENT_DISABLED=1            skip the extension entirely
 *   PI_SUBAGENT_DEBUG=1               surface child events via ctx.ui.notify (commit 3)
 *   (additional env vars — concurrency, session root, retain days,
 *    status linger, timeout, max turns — land with the commit-3 wiring.)
 *
 * Commands:
 *   /agents            list every loaded agent with its source layer
 *   /agents show <n>   print full frontmatter + body of agent <n>
 *
 * Pure helpers live under `../../../lib/node/pi/subagent-*.ts` so they
 * can be unit-tested under vitest without the pi runtime.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, type ExtensionAPI, type ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Box, Markdown, Text } from '@mariozechner/pi-tui';
import { Type } from 'typebox';
import { formatAgentListDescription } from '../../../lib/node/pi/subagent-format.ts';
import {
  type AgentDef,
  type AgentLoadResult,
  type AgentLoadWarning,
  defaultAgentLayers,
  loadAgents,
  type ReadLayer,
} from '../../../lib/node/pi/subagent-loader.ts';

const SUBAGENT_CUSTOM_TYPE = 'subagent-run';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

interface SubagentParamsT {
  agent: string;
  task: string;
  modelOverride?: string;
  returnFormat?: 'text' | 'json';
}

export interface SubagentDetails {
  agent: string;
  agentSource?: 'global' | 'user' | 'project';
  task: string;
  model?: string;
  turns: number;
  tokens: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
  };
  cost: number;
  durationMs: number;
  stopReason: 'completed' | 'max_turns' | 'aborted' | 'error';
  workspace?: {
    isolation: 'shared-cwd' | 'worktree';
    worktreePath?: string;
  };
  childSessionFile?: string;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────
// File I/O glue (exported for commit-3 tests if needed)
// ──────────────────────────────────────────────────────────────────────

function makeReadLayer(): ReadLayer {
  return {
    listMarkdownFiles: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return null;
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function subagentExtension(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_DISABLED === '1') return;

  // Directory containing this extension file — used to resolve the
  // shipped `config/pi/agents/` sibling directory without relying on
  // `DOTFILES_ROOT` or similar.
  const extDir = dirname(fileURLToPath(import.meta.url));
  const userPiDir = `${homedir()}/.pi`;

  let loadResult: AgentLoadResult = { agents: new Map(), nameOrder: [], warnings: [] };
  const surfacedWarnings = new Set<string>();

  const reload = (cwd: string): void => {
    // Build the set of currently-known tool names so `tools:` entries
    // can be validated against reality rather than an inline allowlist.
    const knownToolNames = new Set(pi.getAllTools().map((t) => t.name));
    const layers = defaultAgentLayers({ extensionDir: extDir, userPiDir, cwd });
    loadResult = loadAgents({
      layers,
      knownToolNames,
      fs: makeReadLayer(),
      parseFrontmatter,
    });
  };

  const surfaceWarnings = (ctx: ExtensionContext, warnings: readonly AgentLoadWarning[]): void => {
    for (const w of warnings) {
      const key = `${w.path}:${w.reason}`;
      if (surfacedWarnings.has(key)) continue;
      surfacedWarnings.add(key);
      ctx.ui.notify(`subagent: ${w.path}: ${w.reason}`, 'warning');
    }
  };

  // ────────────────────────────────────────────────────────────────────
  // TUI rendering
  // ────────────────────────────────────────────────────────────────────

  // Custom-message renderer for the parent-side audit entry emitted on
  // completion. Collapsed form: one-liner with the agent name, glyph,
  // and counters. Expanded form: the child's final answer as markdown.
  pi.registerMessageRenderer<SubagentDetails>(SUBAGENT_CUSTOM_TYPE, (message, { expanded }, theme) => {
    const d = message.details;
    const prefix = theme.fg('accent', '[subagent]');
    const body = typeof message.content === 'string' ? message.content : '';
    if (!d) {
      const box = new Box(1, 1, (t) => theme.bg('customMessageBg', t));
      box.addChild(new Text(`${prefix} (no details)`, 0, 0));
      return box;
    }
    const glyph =
      d.stopReason === 'completed'
        ? theme.fg('success', '✓')
        : d.stopReason === 'max_turns'
          ? theme.fg('warning', '∎')
          : d.stopReason === 'aborted'
            ? theme.fg('warning', '⚠')
            : theme.fg('error', '✗');
    const durS = d.durationMs > 0 ? ` ${(d.durationMs / 1000).toFixed(1)}s` : '';
    const costS = d.cost > 0 ? ` $${d.cost.toFixed(4)}` : '';
    const head =
      `${prefix} ${glyph} ${theme.fg('toolTitle', theme.bold(d.agent))}` +
      theme.fg('muted', ` ${d.turns} turn${d.turns === 1 ? '' : 's'}${costS}${durS}`);
    if (!expanded) {
      const box = new Box(1, 1, (t) => theme.bg('customMessageBg', t));
      box.addChild(new Text(head, 0, 0));
      return box;
    }
    const box = new Box(1, 1, (t) => theme.bg('customMessageBg', t));
    box.addChild(new Text(head, 0, 0));
    if (d.error) box.addChild(new Text(theme.fg('error', d.error), 0, 0));
    if (body.trim()) box.addChild(new Markdown(body.trim(), 0, 0));
    return box;
  });

  // ────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ────────────────────────────────────────────────────────────────────

  // Eager load at factory time so `registerTool`'s description is
  // accurate before the first LLM turn runs. `session_start` reloads
  // against the canonical cwd the runtime chose (may differ from
  // `process.cwd()` for --cwd flags or certain RPC clients).
  try {
    reload(process.cwd());
  } catch {
    // Any I/O error here is benign — the session_start pass will retry
    // with the correct cwd and surface warnings at that point.
  }

  pi.on('session_start', (_event, ctx) => {
    reload(ctx.cwd);
    surfaceWarnings(ctx, loadResult.warnings);
  });

  pi.on('session_shutdown', () => {
    loadResult = { agents: new Map(), nameOrder: [], warnings: [] };
    surfacedWarnings.clear();
  });

  // ────────────────────────────────────────────────────────────────────
  // Tool schema + description
  // ────────────────────────────────────────────────────────────────────

  const toolDescription = (): string => {
    const items = loadResult.nameOrder.map((n) => {
      const a = loadResult.agents.get(n);
      return { name: n, description: a?.description ?? '', source: a?.source };
    });
    return [
      'Delegate a subtask to a specialized sub-agent that runs with its own fresh context, tool allowlist, and (optionally) model.',
      "The parent sees only the child's final answer text — intermediate tool calls stay in the child's own session file.",
      'Parallel fan-out is supported: call this tool multiple times in one assistant turn and the invocations run concurrently.',
      '',
      formatAgentListDescription(items),
    ].join('\n');
  };

  const SubagentParams = Type.Object({
    agent: Type.String({
      description:
        'Sub-agent type name (see the tool description for the enumerated list). Must match one of the loaded agent definitions.',
    }),
    task: Type.String({
      description:
        'What the sub-agent should do. Be specific — the sub-agent starts with NO context from this conversation. ' +
        'Include paths, constraints, and the expected answer shape. One task per call.',
    }),
    modelOverride: Type.Optional(
      Type.String({
        description:
          'Override the agent definition\'s model with `provider/modelId`. Useful for "run this explore subagent against a cheaper local model" style fan-outs.',
      }),
    ),
    returnFormat: Type.Optional(
      Type.Union([Type.Literal('text'), Type.Literal('json')], {
        description:
          "Parse the child's final answer as JSON before returning. Falls back to raw text when the answer isn't valid JSON.",
      }),
    ),
  });

  // ────────────────────────────────────────────────────────────────────
  // Tool registration
  // ────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: toolDescription(),
    promptSnippet:
      'Delegate a subtask to a fresh sub-agent session so intermediate exploration stays out of your context.',
    promptGuidelines: [
      'Use `subagent` when the next step would read many files, run a broad `grep`, or otherwise produce intermediate noise you will not use yourself. Prefer the `explore` agent for read-only discovery and the `plan` agent for implementation planning.',
      'The sub-agent starts with no context — describe the goal, constraints, and desired output shape inside `task`.',
      'To fan out work, call `subagent` multiple times in one turn. Runs execute concurrently; the tool aggregates per-call results.',
      'Do NOT call `subagent` from inside a sub-agent. Nesting is disabled by design.',
    ],
    parameters: SubagentParams,
    executionMode: 'parallel',

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as unknown as SubagentParamsT;
      const agent: AgentDef | undefined = loadResult.agents.get(params.agent);
      if (!agent) {
        const available = loadResult.nameOrder.join(', ') || '(none loaded)';
        return {
          content: [
            {
              type: 'text',
              text: `subagent: unknown agent "${params.agent}". Available: ${available}`,
            },
          ],
          details: {
            agent: params.agent,
            task: params.task,
            turns: 0,
            tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
            cost: 0,
            durationMs: 0,
            stopReason: 'error',
            error: `unknown agent "${params.agent}"`,
          } satisfies SubagentDetails,
          isError: true,
        };
      }
      // Suppress unused-var warnings for ctx until commit 3 uses it.
      void ctx;
      return {
        content: [
          {
            type: 'text',
            text:
              `subagent: "${agent.name}" is registered but delegation is not yet wired (commit 3).\n` +
              'This response confirms the tool + renderer + /agents plumbing works end-to-end.',
          },
        ],
        details: {
          agent: agent.name,
          agentSource: agent.source,
          task: params.task,
          turns: 0,
          tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          cost: 0,
          durationMs: 0,
          stopReason: 'error',
          error: 'delegation not yet wired (commit 3)',
        } satisfies SubagentDetails,
        isError: true,
      };
    },

    renderCall(args, theme, _context) {
      const a = args as SubagentParamsT;
      const name = a.agent || '(no agent)';
      const preview = a.task ? (a.task.length > 80 ? `${a.task.slice(0, 80)}…` : a.task) : '';
      let text = `${theme.fg('toolTitle', theme.bold('subagent '))}${theme.fg('accent', name)}`;
      if (preview) text += `\n  ${theme.fg('dim', preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = (result.details ?? {}) as Partial<SubagentDetails>;
      const glyph =
        details.stopReason === 'completed'
          ? theme.fg('success', '✓')
          : details.stopReason === 'max_turns'
            ? theme.fg('warning', '∎')
            : details.stopReason === 'aborted'
              ? theme.fg('warning', '⚠')
              : theme.fg('error', '✗');
      const agent = details.agent ?? '(agent)';
      const source = details.agentSource ? theme.fg('muted', ` (${details.agentSource})`) : '';
      const lead = `${glyph} ${theme.fg('toolTitle', theme.bold(agent))}${source}`;
      const first = result.content.find((c) => c.type === 'text');
      const body = first && first.type === 'text' ? first.text : '';
      if (expanded && body.trim()) {
        return new Text(`${lead}\n${theme.fg('text', body)}`, 0, 0);
      }
      const preview = body.length > 240 ? `${body.slice(0, 240)}…` : body;
      return new Text(`${lead}\n${theme.fg('dim', preview)}`, 0, 0);
    },
  });

  // ────────────────────────────────────────────────────────────────────
  // /agents command
  // ────────────────────────────────────────────────────────────────────

  pi.registerCommand('agents', {
    description: 'List loaded sub-agents (`/agents`) or show one definition (`/agents show <name>`)',
    getArgumentCompletions: (prefix) => {
      const arg = prefix.trim();
      if (arg === '' || 'show'.startsWith(arg)) {
        return [{ value: 'show', label: 'show', description: 'Show full frontmatter + body for an agent' }];
      }
      const tokens = prefix.split(/\s+/);
      if (tokens[0] === 'show') {
        const needle = tokens[1] ?? '';
        return loadResult.nameOrder
          .filter((n) => n.startsWith(needle))
          .map((n) => ({ value: `show ${n}`, label: n, description: loadResult.agents.get(n)?.description ?? '' }));
      }
      return null;
    },

    handler: async (args, ctx) => {
      const raw = (args ?? '').trim();
      // Keep the in-memory agent map fresh — project-scoped defs can
      // appear mid-session if the user drops a file into `.pi/agents/`.
      reload(ctx.cwd);
      surfaceWarnings(ctx, loadResult.warnings);

      if (!raw || raw === 'list') {
        if (loadResult.nameOrder.length === 0) {
          ctx.ui.notify(
            'subagent: no agents loaded. Drop Markdown definitions into ~/.pi/agents/ or .pi/agents/ in this project.',
            'info',
          );
          return;
        }
        const lines: string[] = ['Loaded sub-agents:'];
        const maxName = loadResult.nameOrder.reduce((m, n) => Math.max(m, n.length), 0);
        for (const n of loadResult.nameOrder) {
          const a = loadResult.agents.get(n);
          if (!a) continue;
          const pad = ' '.repeat(Math.max(1, maxName + 2 - n.length));
          lines.push(`  ${n}${pad}[${a.source}]  ${a.description}`);
        }
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      const match = /^show\s+(\S+)$/.exec(raw);
      if (match) {
        const name = match[1]!;
        const a = loadResult.agents.get(name);
        if (!a) {
          ctx.ui.notify(
            `subagent: no agent "${name}" loaded. Available: ${loadResult.nameOrder.join(', ') || '(none)'}`,
            'warning',
          );
          return;
        }
        let raw: string;
        try {
          raw = readFileSync(a.path, 'utf8');
          // Touch stat to make sure the file still exists before printing.
          statSync(a.path);
        } catch (e) {
          ctx.ui.notify(`subagent: cannot read ${a.path}: ${e instanceof Error ? e.message : String(e)}`, 'error');
          return;
        }
        ctx.ui.notify(`# ${a.name}  [${a.source}]\n# ${a.path}\n\n${raw}`, 'info');
        return;
      }

      ctx.ui.notify('subagent: usage: /agents [list] | /agents show <name>', 'warning');
    },
  });
}
