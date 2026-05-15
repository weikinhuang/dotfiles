/**
 * Persona overlay for pi.
 *
 * Claude-Code-plan-mode-equivalent: pick a named *persona* (planner,
 * chat, knowledge-base, journal, ...) for the main session and
 * the parent gets:
 *
 *   - The persona's body prepended to the system prompt.
 *   - The persona's tool allowlist applied via `pi.setActiveTools`.
 *   - Optional model + thinkingLevel swap.
 *   - A positive `writeRoots` gate that asks-on-violation when
 *     a `write` / `edit` resolves outside the declared roots.
 *   - Optional `bashAllow` / `bashDeny` per-persona policy that
 *     layers on top of `bash-permissions.ts`.
 *
 * Personas are markdown files (frontmatter + body) loaded from three
 * layered directories — same project → user → repo precedence
 * `agents/` and `presets.json` use:
 *
 *   1. `config/pi/personas/` shipped with the dotfiles repo.
 *   2. `~/.pi/personas/` — user-global.
 *   3. `<cwd>/.pi/personas/` — project-local.
 *
 * A persona file may declare `agent: <name>` to inherit `tools`,
 * `model`, `thinkingLevel`, and `body` from an existing
 * `config/pi/agents/<name>.md` (resolved through the same
 * layered registry); standalone personas (no `agent:` ref) supply
 * everything themselves.
 *
 * Surfaces:
 *
 *   - `--persona <name>` CLI flag — activate at `session_start`.
 *   - `/persona` lists every loaded persona and shows the active one.
 *   - `/persona <name>` activates.
 *   - `/persona off` / `/persona (none)` clears and restores the
 *     pre-persona snapshot.
 *   - `/persona info <name>` prints the resolved frontmatter +
 *     `writeRoots` + body length + inheritance source.
 *   - `Ctrl+Shift+M` cycles personas (parity with preset's
 *     `Ctrl+Shift+U`).
 *
 * Composition with preset.ts: orthogonal — both extensions
 * snapshot/restore independently. The EFFECTIVE tool set is the
 * intersection because each extension calls `pi.setActiveTools`
 * with its own list. Subagents (D4) are NOT gated by persona; the
 * tool_call interception explicitly skips `subagent` /
 * `subagent_send`.
 *
 * Environment:
 *   PI_PERSONA_DISABLED=1                skip the extension entirely
 *   PI_PERSONA_DEBUG=1                   notify on every internal decision
 *   PI_PERSONA_DEFAULT=<name>            auto-activate at session_start
 *                                     when no --persona flag and no
 *                                     session-restored persona
 *   PI_PERSONA_VIOLATION_DEFAULT=allow   in non-UI mode, allow writes
 *                                     outside writeRoots instead of
 *                                     blocking
 *   PI_PERSONA_REQUEST_OPTIONS_DEBUG=1   log merged payload from the
 *                                     `before_provider_request` handler
 *                                     to stderr (useful when validating
 *                                     a `requestOptions` block reaches
 *                                     the provider as expected)
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
import { evaluateBashPolicy } from '../../../lib/node/pi/persona/bash-policy.ts';
import { mergeAgentInheritance, type AgentRecord } from '../../../lib/node/pi/persona/inherit.ts';
import { formatPersonaListing } from '../../../lib/node/pi/persona/list.ts';
import {
  formatPersonaInfoLines,
  formatPersonaListLines,
  formatPersonaValidate,
  type PersonaInfoInput,
  type PersonaListItem,
} from '../../../lib/node/pi/persona/info.ts';
import { type PersonaWarning, parsePersonaFile, type ParsedPersona } from '../../../lib/node/pi/persona/parse.ts';
import { resolveWriteRoots } from '../../../lib/node/pi/persona/resolve.ts';
import { clearActivePersona, setActivePersona } from '../../../lib/node/pi/persona/active.ts';
import {
  loadPersonaSettings,
  type PersonaSettings,
  type SettingsLayer,
} from '../../../lib/node/pi/persona/settings.ts';
import {
  restoreSession,
  snapshotSession,
  type SnapshotApi,
  type SnapshotState,
} from '../../../lib/node/pi/persona/snapshot.ts';
import { decideWriteGate } from '../../../lib/node/pi/persona/write-gate.ts';
import { applyRequestOptions } from '../../../lib/node/pi/request-options.ts';
import { loadAgents, defaultAgentLayers } from '../../../lib/node/pi/subagent-loader.ts';

const STATUS_KEY = 'persona';
const CUSTOM_TYPE = 'persona-state';

/** Resolved persona + the runtime extras we layer on top at activation time. */
interface ActivePersona {
  parsed: ParsedPersona;
  /** writeRoots already substituted + resolved against cwd/homedir. */
  resolvedWriteRoots: string[];
  /** Combined system-prompt addendum (body + optional appendSystemPrompt). */
  systemPromptAddendum: string;
  /** Inheritance source for `/persona info` debug output. `null` = standalone. */
  inheritedFrom: string | null;
}

export default function personaExtension(pi: ExtensionAPI): void {
  if (process.env.PI_PERSONA_DISABLED === '1') return;

  const debug = process.env.PI_PERSONA_DEBUG === '1';
  const violationDefault = process.env.PI_PERSONA_VIOLATION_DEFAULT === 'allow' ? 'allow' : 'deny';

  const extDir = dirname(fileURLToPath(import.meta.url));
  const shippedPersonasDir = join(extDir, '..', 'personas');
  const userPiDir = join(homedir(), '.pi');

  // ────────────────────────────────────────────────────────────────────
  // Module-level state
  // ────────────────────────────────────────────────────────────────────

  let personas: Record<string, ParsedPersona> = {};
  /** Alphabetical name order for /persona listing + cycle. */
  let nameOrder: string[] = [];
  /** Layered settings (writeRoots overrides etc). */
  let settings: PersonaSettings = { writeRoots: {} };
  /** Available agent records, keyed by name, for `agent: <name>` resolution. */
  let agentsByName = new Map<string, AgentRecord>();
  /** Currently-active persona + the snapshot taken at activation time. */
  let activeName: string | undefined;
  let active: ActivePersona | undefined;
  let originalSnapshot: SnapshotState | undefined;
  /** Approval allowlist: resolved-absolute paths the user OK'd this session. */
  const sessionAllow = new Set<string>();
  const notifiedWarnings = new Set<string>();

  // ────────────────────────────────────────────────────────────────────
  // SnapshotApi adapter — wraps pi's runtime surfaces. Pi's
  // ThinkingLevel is wider than the parsed persona's enum (it includes
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

  const loadPersonas = (cwd: string): PersonaWarning[] => {
    const warnings: PersonaWarning[] = [];
    const layers: { source: 'shipped' | 'user' | 'project'; dir: string }[] = [
      { source: 'shipped', dir: shippedPersonasDir },
      { source: 'user', dir: join(userPiDir, 'personas') },
      { source: 'project', dir: join(cwd, '.pi', 'personas') },
    ];
    const knownToolNames = new Set(pi.getAllTools().map((t) => t.name));
    const collected: Record<string, ParsedPersona> = {};
    for (const { source, dir } of layers) {
      const files = listMarkdown(dir);
      if (!files) continue;
      for (const filename of files) {
        if (filename.toLowerCase() === 'readme.md') continue;
        const path = join(dir, filename);
        const raw = readUtf8(path);
        if (raw === null) continue;
        const parsed = parsePersonaFile({
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
    personas = collected;
    nameOrder = Object.keys(collected).sort();
    return warnings;
  };

  const loadAgentsRegistry = (cwd: string): void => {
    // Reuse the same loader pi's subagent extension uses so a fork
    // of an agent file (e.g. `<cwd>/.pi/agents/plan.md`) is what persona
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

  const loadSettingsLayers = (cwd: string): PersonaWarning[] => {
    const layers: SettingsLayer[] = [];
    const userPath = join(userPiDir, 'persona-settings.json');
    const projectPath = join(cwd, '.pi', 'persona-settings.json');
    for (const path of [userPath, projectPath]) {
      const raw = readUtf8(path);
      if (raw === null) continue;
      layers.push({ source: path, raw });
    }
    const result = loadPersonaSettings(layers);
    settings = result.merged;
    return result.warnings;
  };

  const surfaceWarnings = (ctx: ExtensionContext, warnings: PersonaWarning[]): void => {
    for (const w of warnings) {
      const key = `${w.path}:${w.reason}`;
      if (notifiedWarnings.has(key)) continue;
      notifiedWarnings.add(key);
      ctx.ui.notify(`persona: ${w.path}: ${w.reason}`, 'warning');
    }
  };

  const loadAll = (ctx: ExtensionContext): PersonaWarning[] => {
    const warnings = [...loadPersonas(ctx.cwd), ...loadSettingsLayers(ctx.cwd)];
    loadAgentsRegistry(ctx.cwd);
    surfaceWarnings(ctx, warnings);
    return warnings;
  };

  // ────────────────────────────────────────────────────────────────────
  // Resolving a parsed persona to its runtime form
  // ────────────────────────────────────────────────────────────────────

  /** Look up the named persona, fold in agent inheritance + settings overrides, resolve writeRoots. */
  const resolveActive = (name: string, ctx: ExtensionContext): ActivePersona | undefined => {
    const parsed = personas[name];
    if (!parsed) return undefined;

    // Agent inheritance.
    let merged = parsed;
    let inheritedFrom: string | null = null;
    if (parsed.agent) {
      const agent = agentsByName.get(parsed.agent);
      if (!agent) {
        ctx.ui.notify(`persona "${name}": agent "${parsed.agent}" not found in any layered agent registry`, 'warning');
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

  /**
   * Adapter that flattens the runtime `ActivePersona` shape into the
   * structural input expected by `formatPersonaInfoLines`. Pulled out
   * so both the `/persona info` slash command and the
   * `--persona-info` CLI flag can render the same output without
   * duplicating the field plumbing.
   */
  const toPersonaInfoInput = (name: string, a: ActivePersona): PersonaInfoInput => ({
    name,
    source: a.parsed.source,
    inheritedFrom: a.inheritedFrom,
    tools: a.parsed.tools ?? undefined,
    resolvedWriteRoots: a.resolvedWriteRoots,
    bashAllow: a.parsed.bashAllow,
    bashDeny: a.parsed.bashDeny,
    model: a.parsed.model ?? null,
    thinkingLevel: a.parsed.thinkingLevel ?? null,
    requestOptions: a.parsed.requestOptions,
    bodyLength: a.parsed.body.length,
    promptLength: a.systemPromptAddendum.length,
  });

  // ────────────────────────────────────────────────────────────────────
  // Apply / clear
  // ────────────────────────────────────────────────────────────────────

  const updateStatus = (ctx: ExtensionContext): void => {
    if (activeName) {
      ctx.ui.setStatus(STATUS_KEY, `persona:${activeName}`);
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined as unknown as string);
    }
  };

  const applyModelAndThinking = async (persona: ActivePersona, ctx: ExtensionContext): Promise<boolean> => {
    if (persona.parsed.model && persona.parsed.model !== 'inherit') {
      const slash = persona.parsed.model.indexOf('/');
      if (slash > 0) {
        const provider = persona.parsed.model.slice(0, slash);
        const modelId = persona.parsed.model.slice(slash + 1);
        const model = ctx.modelRegistry.find(provider, modelId);
        if (!model) {
          ctx.ui.notify(`persona "${activeName}": model ${provider}/${modelId} not found`, 'warning');
          return false;
        }
        const ok = await pi.setModel(model);
        if (!ok) {
          ctx.ui.notify(`persona "${activeName}": no auth for ${provider}/${modelId}`, 'warning');
          return false;
        }
      } else {
        ctx.ui.notify(
          `persona "${activeName}": invalid model "${persona.parsed.model}" (expected provider/id)`,
          'warning',
        );
        return false;
      }
    }
    if (persona.parsed.thinkingLevel) {
      pi.setThinkingLevel(persona.parsed.thinkingLevel);
    }
    return true;
  };

  const applyPersona = async (name: string, ctx: ExtensionContext): Promise<void> => {
    const resolved = resolveActive(name, ctx);
    if (!resolved) {
      ctx.ui.notify(`persona: unknown "${name}". Available: ${nameOrder.join(', ') || '(none)'}`, 'error');
      return;
    }

    // Snapshot BEFORE we mutate anything so /persona off can roll back cleanly.
    if (!originalSnapshot) {
      originalSnapshot = snapshotSession(snapshotApi(ctx));
      if (debug) ctx.ui.notify('persona: snapshot taken', 'info');
    }

    // Validate model / thinking BEFORE marking active so a failure
    // doesn't leave the badge claiming a half-applied persona.
    const ok = await applyModelAndThinking(resolved, ctx);
    if (!ok) return;

    // Tools — validate against the live tool registry; skip silently
    // if the persona declares no tools (e.g. `chat` persona body-only).
    const requestedTools = resolved.parsed.tools;
    if (requestedTools && requestedTools.length > 0) {
      const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
      const valid = requestedTools.filter((t) => allToolNames.has(t));
      const invalid = requestedTools.filter((t) => !allToolNames.has(t));
      if (invalid.length > 0) {
        ctx.ui.notify(`persona "${name}": unknown tools ignored: ${invalid.join(', ')}`, 'warning');
      }
      if (valid.length > 0) pi.setActiveTools(valid);
    }

    activeName = name;
    active = resolved;
    setActivePersona({
      name,
      resolvedWriteRoots: resolved.resolvedWriteRoots,
      bashAllow: resolved.parsed.bashAllow,
      bashDeny: resolved.parsed.bashDeny,
    });
    updateStatus(ctx);
    pi.appendEntry(CUSTOM_TYPE, { name });
    if (debug) ctx.ui.notify(`persona: activated "${name}"`, 'info');
  };

  const clearPersona = async (ctx: ExtensionContext): Promise<void> => {
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
    clearActivePersona();
    pi.appendEntry(CUSTOM_TYPE, { name: null });
    updateStatus(ctx);
    if (debug) ctx.ui.notify('persona: cleared', 'info');
  };

  // ────────────────────────────────────────────────────────────────────
  // tool_call gating
  // ────────────────────────────────────────────────────────────────────

  const matchToolCallPath = (event: ToolCallEvent): string => {
    if (isToolCallEventType('write', event) || isToolCallEventType('edit', event)) {
      return String(event.input?.path ?? '').trim();
    }
    return '';
  };

  pi.on('tool_call', async (event, ctx) => {
    if (!active) return undefined;

    // D4: subagent dispatch is never gated by the parent's persona.
    if (event.toolName === 'subagent' || event.toolName === 'subagent_send') return undefined;

    // ── Bash policy ────────────────────────────────────────────────
    if (isToolCallEventType('bash', event)) {
      const cmd = String((event.input as { command?: unknown })?.command ?? '');
      const policy = evaluateBashPolicy({
        command: cmd,
        bashAllow: active.parsed.bashAllow,
        bashDeny: active.parsed.bashDeny,
        personaName: activeName ?? '',
      });
      if (policy.kind === 'block') {
        return { block: true, reason: policy.reason };
      }
      return undefined;
    }

    // ── Write-roots gate ───────────────────────────────────────────
    const isWrite = isToolCallEventType('write', event) || isToolCallEventType('edit', event);
    if (!isWrite) return undefined;

    const inputPath = matchToolCallPath(event);
    if (!inputPath) return undefined;

    const absolute = resolve(ctx.cwd, inputPath);
    const gate = decideWriteGate({
      absolutePath: absolute,
      inputPath,
      resolvedWriteRoots: active.resolvedWriteRoots,
      sessionAllow,
      hasUI: ctx.hasUI,
      violationDefault,
      personaName: activeName ?? '',
    });
    if (gate.kind === 'allow') return undefined;
    if (gate.kind === 'block') {
      return { block: true, reason: gate.reason };
    }

    // gate.kind === 'prompt' — dispatch the approval UI.
    const decision = await askForPermission(ctx, {
      tool: event.toolName,
      path: inputPath,
      detail: gate.detail,
    });
    if (decision.kind === 'deny') {
      return {
        block: true,
        reason: decision.feedback ?? `Blocked by user (${gate.detail})`,
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
  // Provider-payload deep-merge from `requestOptions`
  // ────────────────────────────────────────────────────────────────────
  //
  // Pi's `before_provider_request` event lets handlers replace the
  // outgoing payload before it goes over HTTP. We use it to inject the
  // active persona's `requestOptions` (deep-merged via
  // `lib/node/pi/request-options.ts`) so a persona shipping
  // `requestOptions: { temperature: 0.7, chat_template_kwargs: { ... } }`
  // applies those fields to every request it drives. The optional
  // `apis: [...]` filter scopes the override to one or more API
  // families so a llama.cpp-only `chat_template_kwargs` block doesn't
  // leak into an Anthropic payload when the user changes models
  // mid-session.

  pi.on('before_provider_request', (event, ctx) => {
    if (!active || !active.parsed.requestOptions) return undefined;
    const payload = (event as { payload: unknown }).payload;
    const api = (ctx.model as { api?: string } | undefined)?.api;
    const merged = applyRequestOptions({ payload, options: active.parsed.requestOptions, api });
    if (merged === payload) return undefined;
    if (process.env.PI_PERSONA_REQUEST_OPTIONS_DEBUG === '1') {
      try {
        console.error(
          `[persona:requestOptions] api=${api ?? '(unknown)'} merged=${JSON.stringify(
            (merged as Record<string, unknown> | null) ?? null,
          )}`,
        );
      } catch {
        // ignore JSON serialization errors
      }
    }
    return merged;
  });

  // ────────────────────────────────────────────────────────────────────
  // CLI flag + commands
  // ────────────────────────────────────────────────────────────────────

  pi.registerFlag('persona', {
    description: 'Activate a named persona at startup (see /persona for the list)',
    type: 'string',
  });

  // Non-interactive query / validation flags. These short-circuit the
  // session at `session_start` (print to stdout/stderr + process.exit)
  // because slash commands are not dispatched in `pi -p` mode — see
  // followup #3 in plans/persona-extension-followups.md.
  pi.registerFlag('persona-info', {
    description: 'Print resolved persona <name> (frontmatter + writeRoots + lengths) and exit',
    type: 'string',
  });
  pi.registerFlag('list-personas', {
    description: 'List loaded personas (name + source + description) and exit',
    type: 'boolean',
    default: false,
  });
  pi.registerFlag('validate-personas', {
    description: 'Parse every persona file, report warnings, exit non-zero on warnings',
    type: 'boolean',
    default: false,
  });

  pi.registerCommand('persona', {
    description:
      'Switch persona: `/persona` lists, `/persona <name>` activates, `/persona off` clears, `/persona info <name>` debugs',
    getArgumentCompletions: (prefix: string) => {
      const items: { value: string; label: string; description: string }[] = nameOrder.map((n) => ({
        value: n,
        label: n,
        description: personas[n]?.description ?? '',
      }));
      items.push({ value: 'off', label: 'off', description: 'Clear persona, restore prior state' });
      items.push({ value: 'info', label: 'info', description: 'Print resolved persona (info <name>)' });
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = (args ?? '').trim();
      if (!arg) {
        if (nameOrder.length === 0) {
          ctx.ui.notify(
            'persona: no personas loaded (try shipping a catalog under config/pi/personas/ or ~/.pi/personas/)',
            'warning',
          );
          return;
        }
        const lines = formatPersonaListing({ nameOrder, modes: personas, activeName });
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }
      if (arg === 'off' || arg === '(none)') {
        await clearPersona(ctx);
        ctx.ui.notify('persona: cleared, prior state restored', 'info');
        return;
      }
      if (arg.startsWith('info')) {
        const name = arg.slice(4).trim();
        if (!name) {
          ctx.ui.notify('persona info: usage `/persona info <name>`', 'warning');
          return;
        }
        const resolved = resolveActive(name, ctx);
        if (!resolved) {
          ctx.ui.notify(`persona info: unknown "${name}"`, 'error');
          return;
        }
        const lines = formatPersonaInfoLines(toPersonaInfoInput(name, resolved));
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }
      const target = personas[arg];
      if (!target) {
        ctx.ui.notify(`persona: unknown "${arg}". Available: ${nameOrder.join(', ') || '(none)'}`, 'error');
        return;
      }
      await applyPersona(arg, ctx);
      if (activeName === arg) ctx.ui.notify(`persona: "${arg}" activated`, 'info');
    },
  });

  pi.registerShortcut(Key.ctrlShift('m'), {
    description: 'Cycle personas',
    handler: async (ctx) => {
      if (nameOrder.length === 0) {
        ctx.ui.notify('persona: no personas loaded', 'warning');
        return;
      }
      const cycle = [...nameOrder, '(none)'];
      const current = activeName ?? '(none)';
      const idx = cycle.indexOf(current);
      const next = cycle[(idx === -1 ? 0 : idx + 1) % cycle.length];
      if (next === '(none)') {
        await clearPersona(ctx);
        ctx.ui.notify('persona: cleared', 'info');
        return;
      }
      await applyPersona(next, ctx);
      if (activeName === next) ctx.ui.notify(`persona: "${next}" activated`, 'info');
    },
  });

  // ────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ────────────────────────────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    const warnings = loadAll(ctx);

    // ── Non-interactive query / validation flags ──────────────────
    // These short-circuit before any model interaction. Slash
    // commands aren't dispatched in `pi -p` mode, so we expose the
    // same surface via flags. Followup #3 in
    // plans/persona-extension-followups.md.
    const flagPersonaInfo = pi.getFlag('persona-info');
    const flagListPersonas = pi.getFlag('list-personas') === true;
    const flagValidatePersonas = pi.getFlag('validate-personas') === true;

    if (typeof flagPersonaInfo === 'string' && flagPersonaInfo.length > 0) {
      const target = flagPersonaInfo;
      const resolved = resolveActive(target, ctx);
      if (!resolved) {
        process.stderr.write(`persona-info: unknown "${target}" (available: ${nameOrder.join(', ') || '(none)'})\n`);
        process.exit(1);
      }
      const lines = formatPersonaInfoLines(toPersonaInfoInput(target, resolved));
      process.stdout.write(`${lines.join('\n')}\n`);
      process.exit(0);
    }

    if (flagListPersonas) {
      const items: PersonaListItem[] = nameOrder.map((n) => ({
        name: n,
        source: personas[n]?.sourceLayer ?? 'unknown',
        description: personas[n]?.description,
        active: n === activeName,
      }));
      const lines = formatPersonaListLines(items);
      process.stdout.write(`${lines.join('\n')}\n`);
      process.exit(0);
    }

    if (flagValidatePersonas) {
      const out = formatPersonaValidate({
        warnings: warnings.map((w) => ({ path: w.path, reason: w.reason })),
        totalLoaded: nameOrder.length,
      });
      process.stdout.write(`${out.lines.join('\n')}\n`);
      process.exit(out.exitCode);
    }

    // Restore from session entries (on /resume): last `persona-state`
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

    const flag = pi.getFlag('persona');
    const flagName = typeof flag === 'string' && flag ? flag : undefined;
    const envDefault =
      process.env.PI_PERSONA_DEFAULT && process.env.PI_PERSONA_DEFAULT.length > 0
        ? process.env.PI_PERSONA_DEFAULT
        : undefined;

    // Precedence: --persona flag > session-restored > env default.
    const targetName = flagName ?? (typeof restoredName === 'string' ? restoredName : undefined) ?? envDefault;

    if (!targetName) {
      updateStatus(ctx);
      return;
    }
    const target = personas[targetName];
    if (!target) {
      ctx.ui.notify(`persona: unknown "${targetName}" (available: ${nameOrder.join(', ') || '(none)'})`, 'warning');
      updateStatus(ctx);
      return;
    }
    await applyPersona(targetName, ctx);
  });

  pi.on('session_shutdown', () => {
    personas = {};
    nameOrder = [];
    settings = { writeRoots: {} };
    agentsByName = new Map();
    activeName = undefined;
    active = undefined;
    originalSnapshot = undefined;
    clearActivePersona();
    sessionAllow.clear();
    notifiedWarnings.clear();
  });
}
