/**
 * Mode overlay for pi.
 *
 * Claude-Code-plan-mode-equivalent: pick a named *mode* (planner,
 * chat, knowledge-base, journal, ...) for the main session and
 * the parent gets:
 *
 *   - The mode's persona body prepended to the system prompt.
 *   - The mode's tool allowlist applied via `pi.setActiveTools`.
 *   - Optional model + thinkingLevel swap.
 *   - A positive `writeRoots` gate that asks-on-violation when
 *     a `write` / `edit` resolves outside the declared roots.
 *   - Optional `bashAllow` / `bashDeny` per-mode policy that
 *     layers on top of `bash-permissions.ts`.
 *
 * Modes are markdown files (frontmatter + body) loaded from three
 * layered directories — same project → user → repo precedence
 * `agents/` and `presets.json` use:
 *
 *   1. `config/pi/modes/` shipped with the dotfiles repo.
 *   2. `~/.pi/modes/` — user-global.
 *   3. `<cwd>/.pi/modes/` — project-local.
 *
 * A mode file may declare `agent: <name>` to inherit `tools`,
 * `model`, `thinkingLevel`, and `body` from an existing
 * `config/pi/agents/<name>.md` (resolved through the same
 * layered registry); standalone modes (no `agent:` ref) supply
 * everything themselves.
 *
 * Surfaces:
 *
 *   - `--mode <name>` CLI flag — activate at `session_start`.
 *   - `/mode` lists every loaded mode and shows the active one.
 *   - `/mode <name>` activates.
 *   - `/mode off` / `/mode (none)` clears and restores the
 *     pre-mode snapshot.
 *   - `/mode info <name>` prints the resolved frontmatter +
 *     `writeRoots` + body length + inheritance source.
 *   - `Ctrl+Shift+M` cycles modes (parity with preset's
 *     `Ctrl+Shift+U`).
 *
 * Composition with preset.ts: orthogonal — both extensions
 * snapshot/restore independently. The EFFECTIVE tool set is the
 * intersection because each extension calls `pi.setActiveTools`
 * with its own list. Subagents (D4) are NOT gated by mode; the
 * tool_call interception explicitly skips `subagent` /
 * `subagent_send`.
 *
 * Environment:
 *   PI_MODE_DISABLED=1                skip the extension entirely
 *   PI_MODE_DEBUG=1                   notify on every internal decision
 *   PI_MODE_DEFAULT=<name>            auto-activate at session_start
 *                                     when no --mode flag and no
 *                                     session-restored mode
 *   PI_MODE_VIOLATION_DEFAULT=allow   in non-UI mode, allow writes
 *                                     outside writeRoots instead of
 *                                     blocking
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
  parseFrontmatter,
  type ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import { Key } from '@earendil-works/pi-tui';

import { askForPermission } from '../../../lib/node/pi/approval-prompt.ts';
import { mergeAgentInheritance, type AgentRecord } from '../../../lib/node/pi/mode/inherit.ts';
import { isInsideWriteRoots } from '../../../lib/node/pi/mode/match.ts';
import { type ParsedMode, parseModeFile, type ModeWarning } from '../../../lib/node/pi/mode/parse.ts';
import { resolveWriteRoots } from '../../../lib/node/pi/mode/resolve.ts';
import { loadModeSettings, type ModeSettings, type SettingsLayer } from '../../../lib/node/pi/mode/settings.ts';
import {
  restoreSession,
  snapshotSession,
  type SnapshotApi,
  type SnapshotState,
} from '../../../lib/node/pi/mode/snapshot.ts';
import { loadAgents, defaultAgentLayers } from '../../../lib/node/pi/subagent-loader.ts';

const STATUS_KEY = 'mode';
const CUSTOM_TYPE = 'mode-state';

/** Resolved mode + the runtime extras we layer on top at activation time. */
interface ActiveMode {
  parsed: ParsedMode;
  /** writeRoots already substituted + resolved against cwd/homedir. */
  resolvedWriteRoots: string[];
  /** Combined system-prompt addendum (body + optional appendSystemPrompt). */
  systemPromptAddendum: string;
  /** Inheritance source for `/mode info` debug output. `null` = standalone. */
  inheritedFrom: string | null;
}

export default function modeExtension(pi: ExtensionAPI): void {
  if (process.env.PI_MODE_DISABLED === '1') return;

  const debug = process.env.PI_MODE_DEBUG === '1';
  const violationDefault = process.env.PI_MODE_VIOLATION_DEFAULT === 'allow' ? 'allow' : 'deny';

  const extDir = dirname(fileURLToPath(import.meta.url));
  const shippedModesDir = join(extDir, '..', 'modes');
  const userPiDir = join(homedir(), '.pi');

  // ────────────────────────────────────────────────────────────────────
  // Module-level state
  // ────────────────────────────────────────────────────────────────────

  let modes: Record<string, ParsedMode> = {};
  /** Alphabetical name order for /mode listing + cycle. */
  let nameOrder: string[] = [];
  /** Layered settings (writeRoots overrides etc). */
  let settings: ModeSettings = { writeRoots: {} };
  /** Available agent records, keyed by name, for `agent: <name>` resolution. */
  let agentsByName = new Map<string, AgentRecord>();
  /** Currently-active mode + the snapshot taken at activation time. */
  let activeName: string | undefined;
  let active: ActiveMode | undefined;
  let originalSnapshot: SnapshotState | undefined;
  /** Approval allowlist: resolved-absolute paths the user OK'd this session. */
  const sessionAllow = new Set<string>();
  const notifiedWarnings = new Set<string>();

  // ────────────────────────────────────────────────────────────────────
  // SnapshotApi adapter — wraps pi's runtime surfaces. Pi's
  // ThinkingLevel is wider than the parsed mode's enum (it includes
  // 'minimal' and 'xhigh'); the adapter accepts the wider set so
  // snapshot/restore round-trips don't silently coerce.
  // ────────────────────────────────────────────────────────────────────

  const snapshotApi = (ctx: ExtensionContext): SnapshotApi => ({
    getModel: () => {
      const m = ctx.model as { provider?: string; id?: string } | undefined;
      if (!m?.provider || !m?.id) return undefined;
      return `${m.provider}/${m.id}`;
    },
    setModel: (spec) => {
      // Snapshot/restore writes the model back via ctx.modelRegistry;
      // see restoreFromSnapshot below for the actual setter call.
      // The SnapshotApi.setModel is only used by snapshot.ts itself,
      // which doesn't roundtrip through this adapter — leave a no-op
      // here and apply via the explicit restore path below.
      void spec;
    },
    getThinkingLevel: () => pi.getThinkingLevel() as SnapshotState['thinkingLevel'],
    setThinkingLevel: (level) => {
      if (level !== undefined) pi.setThinkingLevel(level);
    },
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: (tools) => pi.setActiveTools(tools),
  });

  // ────────────────────────────────────────────────────────────────────
  // Loading
  // ────────────────────────────────────────────────────────────────────

  const listMarkdown = (dir: string): string[] | null => {
    try {
      return readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md'));
    } catch {
      return null;
    }
  };

  const readUtf8 = (path: string): string | null => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  };

  const loadModes = (cwd: string): ModeWarning[] => {
    const warnings: ModeWarning[] = [];
    const layers: { source: 'shipped' | 'user' | 'project'; dir: string }[] = [
      { source: 'shipped', dir: shippedModesDir },
      { source: 'user', dir: join(userPiDir, 'modes') },
      { source: 'project', dir: join(cwd, '.pi', 'modes') },
    ];
    const knownToolNames = new Set(pi.getAllTools().map((t) => t.name));
    const collected: Record<string, ParsedMode> = {};
    for (const { source, dir } of layers) {
      const files = listMarkdown(dir);
      if (!files) continue;
      for (const filename of files) {
        if (filename.toLowerCase() === 'readme.md') continue;
        const path = join(dir, filename);
        const raw = readUtf8(path);
        if (raw === null) continue;
        const parsed = parseModeFile({
          path,
          source,
          raw,
          knownToolNames,
          parseFrontmatter,
          warnings,
        });
        if (parsed) collected[parsed.name] = parsed;
      }
    }
    modes = collected;
    nameOrder = Object.keys(collected).sort();
    return warnings;
  };

  const loadAgentsRegistry = (cwd: string): void => {
    // Reuse the same loader pi's subagent extension uses so a fork
    // of an agent file (e.g. `<cwd>/.pi/agents/plan.md`) is what mode
    // inheritance picks up — the layered-registry decision (D5).
    const knownToolNames = new Set(pi.getAllTools().map((t) => t.name));
    const result = loadAgents({
      layers: defaultAgentLayers({ extensionDir: extDir, userPiDir, cwd }),
      knownToolNames,
      fs: { listMarkdownFiles: listMarkdown, readFile: readUtf8 },
      parseFrontmatter,
    });
    agentsByName = new Map();
    for (const def of result.agents.values()) {
      const modelStr = def.model === 'inherit' ? undefined : `${def.model.provider}/${def.model.modelId}`;
      agentsByName.set(def.name, {
        name: def.name,
        tools: def.tools,
        model: modelStr,
        thinkingLevel: def.thinkingLevel as AgentRecord['thinkingLevel'],
        body: def.body,
      });
    }
  };

  const loadSettingsLayers = (cwd: string): ModeWarning[] => {
    const layers: SettingsLayer[] = [];
    const userPath = join(userPiDir, 'mode-settings.json');
    const projectPath = join(cwd, '.pi', 'mode-settings.json');
    for (const path of [userPath, projectPath]) {
      const raw = readUtf8(path);
      if (raw === null) continue;
      layers.push({ source: path, raw });
    }
    const result = loadModeSettings(layers);
    settings = result.merged;
    return result.warnings;
  };

  const surfaceWarnings = (ctx: ExtensionContext, warnings: ModeWarning[]): void => {
    for (const w of warnings) {
      const key = `${w.path}:${w.reason}`;
      if (notifiedWarnings.has(key)) continue;
      notifiedWarnings.add(key);
      ctx.ui.notify(`mode: ${w.path}: ${w.reason}`, 'warning');
    }
  };

  const loadAll = (ctx: ExtensionContext): void => {
    const warnings = [...loadModes(ctx.cwd), ...loadSettingsLayers(ctx.cwd)];
    loadAgentsRegistry(ctx.cwd);
    surfaceWarnings(ctx, warnings);
  };

  // ────────────────────────────────────────────────────────────────────
  // Resolving a parsed mode to its runtime form
  // ────────────────────────────────────────────────────────────────────

  /** Look up the named mode, fold in agent inheritance + settings overrides, resolve writeRoots. */
  const resolveActive = (name: string, ctx: ExtensionContext): ActiveMode | undefined => {
    const parsed = modes[name];
    if (!parsed) return undefined;

    // Agent inheritance.
    let merged = parsed;
    let inheritedFrom: string | null = null;
    if (parsed.agent) {
      const agent = agentsByName.get(parsed.agent);
      if (!agent) {
        ctx.ui.notify(`mode "${name}": agent "${parsed.agent}" not found in any layered agent registry`, 'warning');
      } else {
        merged = mergeAgentInheritance(parsed, agent);
        inheritedFrom = parsed.agent;
      }
    }

    // settings.json override for writeRoots.
    const overrideRoots = settings.writeRoots[name];
    const rawRoots = overrideRoots !== undefined ? overrideRoots : merged.writeRoots;

    const resolvedWriteRoots = resolveWriteRoots(rawRoots, {
      cwd: ctx.cwd,
      homedir: homedir(),
      projectSlug: basename(ctx.cwd),
    });

    const addendumParts: string[] = [];
    if (merged.body && merged.body.trim().length > 0) addendumParts.push(merged.body.trim());
    if (merged.appendSystemPrompt && merged.appendSystemPrompt.trim().length > 0) {
      addendumParts.push(merged.appendSystemPrompt.trim());
    }
    const systemPromptAddendum = addendumParts.join('\n\n');

    return { parsed: merged, resolvedWriteRoots, systemPromptAddendum, inheritedFrom };
  };

  // ────────────────────────────────────────────────────────────────────
  // Apply / clear
  // ────────────────────────────────────────────────────────────────────

  const updateStatus = (ctx: ExtensionContext): void => {
    if (activeName) {
      ctx.ui.setStatus(STATUS_KEY, `mode:${activeName}`);
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined as unknown as string);
    }
  };

  const applyModelAndThinking = async (mode: ActiveMode, ctx: ExtensionContext): Promise<boolean> => {
    if (mode.parsed.model && mode.parsed.model !== 'inherit') {
      const slash = mode.parsed.model.indexOf('/');
      if (slash > 0) {
        const provider = mode.parsed.model.slice(0, slash);
        const modelId = mode.parsed.model.slice(slash + 1);
        const model = ctx.modelRegistry.find(provider, modelId);
        if (!model) {
          ctx.ui.notify(`mode "${activeName}": model ${provider}/${modelId} not found`, 'warning');
          return false;
        }
        const ok = await pi.setModel(model);
        if (!ok) {
          ctx.ui.notify(`mode "${activeName}": no auth for ${provider}/${modelId}`, 'warning');
          return false;
        }
      } else {
        ctx.ui.notify(`mode "${activeName}": invalid model "${mode.parsed.model}" (expected provider/id)`, 'warning');
        return false;
      }
    }
    if (mode.parsed.thinkingLevel) {
      pi.setThinkingLevel(mode.parsed.thinkingLevel);
    }
    return true;
  };

  const applyMode = async (name: string, ctx: ExtensionContext): Promise<void> => {
    const resolved = resolveActive(name, ctx);
    if (!resolved) {
      ctx.ui.notify(`mode: unknown "${name}". Available: ${nameOrder.join(', ') || '(none)'}`, 'error');
      return;
    }

    // Snapshot BEFORE we mutate anything so /mode off can roll back cleanly.
    if (!originalSnapshot) {
      originalSnapshot = snapshotSession(snapshotApi(ctx));
      if (debug) ctx.ui.notify('mode: snapshot taken', 'info');
    }

    // Validate model / thinking BEFORE marking active so a failure
    // doesn't leave the badge claiming a half-applied mode.
    const ok = await applyModelAndThinking(resolved, ctx);
    if (!ok) return;

    // Tools — validate against the live tool registry; skip silently
    // if the mode declares no tools (e.g. `chat` mode body-only).
    const requestedTools = resolved.parsed.tools;
    if (requestedTools && requestedTools.length > 0) {
      const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
      const valid = requestedTools.filter((t) => allToolNames.has(t));
      const invalid = requestedTools.filter((t) => !allToolNames.has(t));
      if (invalid.length > 0) {
        ctx.ui.notify(`mode "${name}": unknown tools ignored: ${invalid.join(', ')}`, 'warning');
      }
      if (valid.length > 0) pi.setActiveTools(valid);
    }

    activeName = name;
    active = resolved;
    updateStatus(ctx);
    pi.appendEntry(CUSTOM_TYPE, { name });
    if (debug) ctx.ui.notify(`mode: activated "${name}"`, 'info');
  };

  const clearMode = async (ctx: ExtensionContext): Promise<void> => {
    if (!activeName) return;
    if (originalSnapshot) {
      // Restore tools + thinking via the snapshot helper, model
      // explicitly via ctx.modelRegistry (snapshot.setModel is a no-op
      // — the SnapshotApi adapter doesn't roundtrip model setters).
      restoreSession(snapshotApi(ctx), originalSnapshot);
      if (originalSnapshot.model) {
        const slash = originalSnapshot.model.indexOf('/');
        if (slash > 0) {
          const provider = originalSnapshot.model.slice(0, slash);
          const modelId = originalSnapshot.model.slice(slash + 1);
          const model = ctx.modelRegistry.find(provider, modelId);
          if (model) await pi.setModel(model);
        }
      }
    }
    activeName = undefined;
    active = undefined;
    originalSnapshot = undefined;
    pi.appendEntry(CUSTOM_TYPE, { name: null });
    updateStatus(ctx);
    if (debug) ctx.ui.notify('mode: cleared', 'info');
  };

  // ────────────────────────────────────────────────────────────────────
  // tool_call gating
  // ────────────────────────────────────────────────────────────────────

  const getInputPath = (event: ToolCallEvent): string => {
    if (isToolCallEventType('write', event) || isToolCallEventType('edit', event)) {
      return String(event.input?.path ?? '').trim();
    }
    return '';
  };

  const matchBashPrefix = (cmd: string, patterns: readonly string[]): boolean => {
    const head = cmd.trim().split(/\s+/)[0] ?? '';
    for (const pat of patterns) {
      // Trivial matcher: exact, prefix-with-trailing-`*`, or wildcard `*`.
      // Defer richer glob semantics to v2; the catalog's bashAllow lists
      // (e.g. `"ai-fetch-web *"`, `"rg *"`) only ever care about the
      // command name plus a `*` placeholder.
      if (pat === '*') return true;
      const star = pat.indexOf('*');
      if (star === -1) {
        if (head === pat) return true;
      } else {
        const prefix = pat.slice(0, star).trim();
        if (prefix === '' || head === prefix.replace(/\s+$/, '')) return true;
      }
    }
    return false;
  };

  pi.on('tool_call', async (event, ctx) => {
    if (!active) return undefined;

    // D4: subagent dispatch is never gated by the parent's mode.
    if (event.toolName === 'subagent' || event.toolName === 'subagent_send') return undefined;

    // ── Bash policy ────────────────────────────────────────────────
    if (isToolCallEventType('bash', event)) {
      const cmd = String((event.input as { command?: unknown })?.command ?? '');
      const allow = active.parsed.bashAllow;
      const deny = active.parsed.bashDeny;
      if (deny.length > 0 && matchBashPrefix(cmd, deny)) {
        return {
          block: true,
          reason: `mode "${activeName}" denies bash command (matched bashDeny)`,
        };
      }
      if (allow.length > 0 && !matchBashPrefix(cmd, allow)) {
        return {
          block: true,
          reason: `mode "${activeName}" allows only: ${allow.join(', ')}`,
        };
      }
      return undefined;
    }

    // ── Write-roots gate ───────────────────────────────────────────
    const isWrite = isToolCallEventType('write', event) || isToolCallEventType('edit', event);
    if (!isWrite) return undefined;

    const inputPath = getInputPath(event);
    if (!inputPath) return undefined;

    const absolute = resolve(ctx.cwd, inputPath);
    if (sessionAllow.has(absolute)) return undefined;

    // Empty writeRoots ⇒ this mode disallows writes entirely.
    // Non-empty + path inside ⇒ allow without prompting.
    const insideRoots = active.resolvedWriteRoots.length > 0 && isInsideWriteRoots(absolute, active.resolvedWriteRoots);
    if (insideRoots) return undefined;

    const detail =
      active.resolvedWriteRoots.length === 0
        ? `mode "${activeName}" disallows writes`
        : `mode "${activeName}" writeRoots: ${active.resolvedWriteRoots.join(', ')}`;

    if (!ctx.hasUI) {
      if (violationDefault === 'allow') return undefined;
      return {
        block: true,
        reason:
          `No UI for approval. Path "${inputPath}" is outside ${detail}. ` +
          'Set PI_MODE_VIOLATION_DEFAULT=allow to override, or pick a path under writeRoots.',
      };
    }

    const decision = await askForPermission(ctx, {
      tool: event.toolName,
      path: inputPath,
      detail,
    });
    if (decision.kind === 'deny') {
      return {
        block: true,
        reason: decision.feedback ?? `Blocked by user (${detail})`,
      };
    }
    if (decision.kind === 'allow-session') {
      sessionAllow.add(absolute);
    }
    return undefined;
  });

  // ────────────────────────────────────────────────────────────────────
  // System-prompt injection
  // ────────────────────────────────────────────────────────────────────

  pi.on('before_agent_start', (event) => {
    if (!active || active.systemPromptAddendum.length === 0) return undefined;
    const base = (event as { systemPrompt?: string }).systemPrompt ?? '';
    return { systemPrompt: `${base.replace(/\s+$/, '')}\n\n${active.systemPromptAddendum}` };
  });

  // ────────────────────────────────────────────────────────────────────
  // CLI flag + commands
  // ────────────────────────────────────────────────────────────────────

  pi.registerFlag('mode', {
    description: 'Activate a named mode at startup (see /mode for the list)',
    type: 'string',
  });

  pi.registerCommand('mode', {
    description: 'Switch mode: `/mode` lists, `/mode <name>` activates, `/mode off` clears, `/mode info <name>` debugs',
    getArgumentCompletions: (prefix: string) => {
      const items: { value: string; label: string; description: string }[] = nameOrder.map((n) => ({
        value: n,
        label: n,
        description: modes[n]?.description ?? '',
      }));
      items.push({ value: 'off', label: 'off', description: 'Clear mode, restore prior state' });
      items.push({ value: 'info', label: 'info', description: 'Print resolved mode (info <name>)' });
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = (args ?? '').trim();
      if (!arg) {
        if (nameOrder.length === 0) {
          ctx.ui.notify(
            'mode: no modes loaded (try shipping a catalog under config/pi/modes/ or ~/.pi/modes/)',
            'warning',
          );
          return;
        }
        const activeLine = activeName ? `(active: ${activeName})` : '(no mode active)';
        const lines = nameOrder.map((n) => {
          const star = n === activeName ? '* ' : '  ';
          const desc = modes[n]?.description ?? '';
          return `${star}${n} — ${desc}`;
        });
        ctx.ui.notify([activeLine, ...lines].join('\n'), 'info');
        return;
      }
      if (arg === 'off' || arg === '(none)') {
        await clearMode(ctx);
        ctx.ui.notify('mode: cleared, prior state restored', 'info');
        return;
      }
      if (arg.startsWith('info')) {
        const name = arg.slice(4).trim();
        if (!name) {
          ctx.ui.notify('mode info: usage `/mode info <name>`', 'warning');
          return;
        }
        const resolved = resolveActive(name, ctx);
        if (!resolved) {
          ctx.ui.notify(`mode info: unknown "${name}"`, 'error');
          return;
        }
        const lines = [
          `mode "${name}"`,
          `  source:        ${resolved.parsed.source}`,
          `  inheritedFrom: ${resolved.inheritedFrom ?? '(standalone)'}`,
          `  tools:         ${(resolved.parsed.tools ?? []).join(', ') || '(inherit / none)'}`,
          `  writeRoots:    ${resolved.resolvedWriteRoots.join(', ') || '(none — writes disallowed)'}`,
          `  bashAllow:     ${resolved.parsed.bashAllow.join(', ') || '(empty)'}`,
          `  bashDeny:      ${resolved.parsed.bashDeny.join(', ') || '(empty)'}`,
          `  model:         ${resolved.parsed.model ?? '(inherit)'}`,
          `  thinkingLevel: ${resolved.parsed.thinkingLevel ?? '(inherit)'}`,
          `  body length:   ${resolved.parsed.body.length} chars`,
          `  prompt length: ${resolved.systemPromptAddendum.length} chars`,
        ];
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }
      const target = modes[arg];
      if (!target) {
        ctx.ui.notify(`mode: unknown "${arg}". Available: ${nameOrder.join(', ') || '(none)'}`, 'error');
        return;
      }
      await applyMode(arg, ctx);
      if (activeName === arg) ctx.ui.notify(`mode: "${arg}" activated`, 'info');
    },
  });

  pi.registerShortcut(Key.ctrlShift('m'), {
    description: 'Cycle modes',
    handler: async (ctx) => {
      if (nameOrder.length === 0) {
        ctx.ui.notify('mode: no modes loaded', 'warning');
        return;
      }
      const cycle = [...nameOrder, '(none)'];
      const current = activeName ?? '(none)';
      const idx = cycle.indexOf(current);
      const next = cycle[(idx === -1 ? 0 : idx + 1) % cycle.length];
      if (next === '(none)') {
        await clearMode(ctx);
        ctx.ui.notify('mode: cleared', 'info');
        return;
      }
      await applyMode(next, ctx);
      if (activeName === next) ctx.ui.notify(`mode: "${next}" activated`, 'info');
    },
  });

  // ────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ────────────────────────────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    loadAll(ctx);

    // Restore from session entries (on /resume): last `mode-state`
    // entry's `name`, or null if it was explicitly cleared.
    const entries = ctx.sessionManager.getEntries();
    const restored = [...entries]
      .reverse()
      .find(
        (e) =>
          (e as { type?: string; customType?: string }).type === 'custom' &&
          (e as { customType?: string }).customType === CUSTOM_TYPE,
      ) as { data?: { name?: string | null } } | undefined;
    const restoredName = restored?.data?.name ?? null;

    const flag = pi.getFlag('mode');
    const flagName = typeof flag === 'string' && flag ? flag : undefined;
    const envDefault =
      process.env.PI_MODE_DEFAULT && process.env.PI_MODE_DEFAULT.length > 0 ? process.env.PI_MODE_DEFAULT : undefined;

    // Precedence: --mode flag > session-restored > env default.
    const targetName = flagName ?? (typeof restoredName === 'string' ? restoredName : undefined) ?? envDefault;

    if (!targetName) {
      updateStatus(ctx);
      return;
    }
    const target = modes[targetName];
    if (!target) {
      ctx.ui.notify(`mode: unknown "${targetName}" (available: ${nameOrder.join(', ') || '(none)'})`, 'warning');
      updateStatus(ctx);
      return;
    }
    await applyMode(targetName, ctx);
  });

  pi.on('session_shutdown', () => {
    modes = {};
    nameOrder = [];
    settings = { writeRoots: {} };
    agentsByName = new Map();
    activeName = undefined;
    active = undefined;
    originalSnapshot = undefined;
    sessionAllow.clear();
    notifiedWarnings.clear();
  });
}
