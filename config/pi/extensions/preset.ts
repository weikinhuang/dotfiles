/**
 * Preset bundles for pi.
 *
 * Named bundles that swap the model, thinking level, active tool set,
 * and an optional system-prompt addendum in one command. Addresses
 * the "switching between models / workflows is high-friction"
 * problem when routinely toggling between remote heavy-reasoning
 * models (bedrock opus) and small self-hosted ones (llama.cpp qwen3).
 *
 * Surfaces:
 *
 *   - `--preset <name>` CLI flag. Set during `session_start`.
 *   - `/preset` lists presets and shows the active one.
 *   - `/preset <name>` activates a preset immediately.
 *   - `/preset off` / `/preset (none)` clears the preset and restores
 *     the state that was active before any preset was applied.
 *   - `Ctrl+Shift+U` cycles through presets (alphabetical order, then
 *     back to "no preset").
 *
 * Presets are loaded from three layered JSONC files (lowest priority
 * first; later layers override earlier by preset name):
 *
 *   1. `config/pi/presets.json` shipped with the dotfiles repo.
 *   2. `~/.pi/agent/presets.json` — user-global overrides.
 *   3. `<cwd>/.pi/presets.json` — project-local overrides.
 *
 * Example:
 *
 *   {
 *     "qwen3-local": {
 *       "model": "llama-cpp/qwen3-6-35b-a3b",
 *       "thinkingLevel": "high",
 *       "tools": ["bash", "read", "write", "edit", "grep", "find", "ls"],
 *       "appendSystemPrompt": "You are running on a ~3B-active local model..."
 *     }
 *   }
 *
 * Fields are all optional; a preset can tweak a single knob (e.g.
 * just `thinkingLevel: "off"` for a cheap-one-shot preset).
 *
 * Environment:
 *   PI_PRESET_DISABLED=1      skip the extension entirely
 *   PI_PRESET_DEBUG=1         ctx.ui.notify on each decision
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ExtensionAPI, type ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Key } from '@mariozechner/pi-tui';
import { parseModelSpec } from '../../../lib/node/pi/btw.ts';
import {
  describePreset,
  loadPresetFiles,
  type Preset,
  type PresetsConfig,
  readFileOrUndefined,
  type ThinkingLevel,
} from '../../../lib/node/pi/preset.ts';

const STATUS_KEY = 'preset';

interface OriginalState {
  modelId: string | undefined;
  modelProvider: string | undefined;
  thinkingLevel: ThinkingLevel;
  tools: string[];
}

export default function presetExtension(pi: ExtensionAPI): void {
  if (process.env.PI_PRESET_DISABLED === '1') return;

  const debug = process.env.PI_PRESET_DEBUG === '1';

  // Presets shipped in this dotfiles repo: sibling file `presets.json`
  // one directory up from this extension (i.e. `config/pi/presets.json`).
  const extDir = dirname(fileURLToPath(import.meta.url));
  const shippedPresetsPath = join(extDir, '..', 'presets.json');

  let presets: PresetsConfig = {};
  let nameOrder: string[] = [];
  let activePresetName: string | undefined;
  let activePreset: Preset | undefined;
  let originalState: OriginalState | undefined;
  let pendingWarnings: ReturnType<typeof loadPresetFiles>['warnings'] = [];
  const notifiedWarnings = new Set<string>();

  const loadAll = (cwd: string): void => {
    const result = loadPresetFiles(
      [shippedPresetsPath, join(homedir(), '.pi', 'agent', 'presets.json'), join(cwd, '.pi', 'presets.json')],
      readFileOrUndefined,
    );
    presets = result.presets;
    nameOrder = result.nameOrder;
    // Stash warnings; the caller holding `ctx` surfaces them.
    pendingWarnings = result.warnings;
  };

  const surfaceWarnings = (ctx: ExtensionContext): void => {
    for (const w of pendingWarnings) {
      const key = `${w.path}:${w.error}`;
      if (notifiedWarnings.has(key)) continue;
      notifiedWarnings.add(key);
      ctx.ui.notify(`preset: ${w.path}: ${w.error}`, 'warning');
    }
    pendingWarnings = [];
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    if (activePresetName) {
      ctx.ui.setStatus(STATUS_KEY, `preset:${activePresetName}`);
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined as unknown as string);
    }
  };

  const snapshotOriginal = (ctx: ExtensionContext): void => {
    if (originalState) return;
    const model = ctx.model as { provider?: string; id?: string } | undefined;
    originalState = {
      modelId: model?.id,
      modelProvider: model?.provider,
      thinkingLevel: pi.getThinkingLevel(),
      tools: pi.getActiveTools(),
    };
    if (debug) ctx.ui.notify(`preset: snapshot original state`, 'info');
  };

  const applyPreset = async (name: string, preset: Preset, ctx: ExtensionContext): Promise<void> => {
    snapshotOriginal(ctx);

    // Model
    if (preset.model) {
      const spec = parseModelSpec(preset.model);
      if (!spec) {
        ctx.ui.notify(`preset "${name}": invalid model "${preset.model}" (expected provider/id)`, 'warning');
      } else {
        const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
        if (!model) {
          ctx.ui.notify(`preset "${name}": model ${spec.provider}/${spec.modelId} not found`, 'warning');
        } else {
          const ok = await pi.setModel(model);
          if (!ok) {
            ctx.ui.notify(`preset "${name}": no auth for ${spec.provider}/${spec.modelId}`, 'warning');
          }
        }
      }
    }

    // Thinking level
    if (preset.thinkingLevel) {
      pi.setThinkingLevel(preset.thinkingLevel);
    }

    // Tools (validate against the live tool registry)
    if (preset.tools && preset.tools.length > 0) {
      const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
      const valid = preset.tools.filter((t) => allToolNames.has(t));
      const invalid = preset.tools.filter((t) => !allToolNames.has(t));
      if (invalid.length > 0) {
        ctx.ui.notify(`preset "${name}": unknown tools ignored: ${invalid.join(', ')}`, 'warning');
      }
      if (valid.length > 0) pi.setActiveTools(valid);
    }

    activePresetName = name;
    activePreset = preset;
    updateStatus(ctx);
    pi.appendEntry('preset-state', { name });
    if (debug) ctx.ui.notify(`preset: activated "${name}"`, 'info');
  };

  const clearPreset = async (ctx: ExtensionContext): Promise<void> => {
    if (!activePresetName) return;
    if (originalState) {
      if (originalState.modelProvider && originalState.modelId) {
        const model = ctx.modelRegistry.find(originalState.modelProvider, originalState.modelId);
        if (model) await pi.setModel(model);
      }
      pi.setThinkingLevel(originalState.thinkingLevel);
      if (originalState.tools.length > 0) pi.setActiveTools(originalState.tools);
    }
    activePresetName = undefined;
    activePreset = undefined;
    originalState = undefined;
    pi.appendEntry('preset-state', { name: null });
    updateStatus(ctx);
  };

  // ───────── CLI flag ─────────
  pi.registerFlag('preset', {
    description: 'Activate a named preset at startup (see /preset for the list)',
    type: 'string',
  });

  // ───────── /preset command ─────────
  pi.registerCommand('preset', {
    description: 'Switch preset: `/preset` lists, `/preset <name>` activates, `/preset off` clears',
    getArgumentCompletions: (prefix: string) => {
      const items = nameOrder.map((n) => ({ value: n, label: n, description: describePreset(presets[n]!) }));
      items.push({ value: 'off', label: 'off', description: 'Clear preset, restore prior state' });
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = (args ?? '').trim();
      if (!arg) {
        // List
        if (nameOrder.length === 0) {
          ctx.ui.notify('preset: no presets defined', 'warning');
          return;
        }
        const lines = nameOrder.map((n) => {
          const prefix = n === activePresetName ? '* ' : '  ';
          return `${prefix}${n} — ${describePreset(presets[n]!)}`;
        });
        const activeLine = activePresetName ? `(active: ${activePresetName})` : '(no preset active)';
        ctx.ui.notify([activeLine, ...lines].join('\n'), 'info');
        return;
      }
      if (arg === 'off' || arg === '(none)') {
        await clearPreset(ctx);
        ctx.ui.notify('preset: cleared, prior state restored', 'info');
        return;
      }
      const preset = presets[arg];
      if (!preset) {
        ctx.ui.notify(`preset: unknown "${arg}". Available: ${nameOrder.join(', ') || '(none)'}`, 'error');
        return;
      }
      await applyPreset(arg, preset, ctx);
      ctx.ui.notify(`preset: "${arg}" activated`, 'info');
    },
  });

  // ───────── Ctrl+Shift+U — cycle ─────────
  pi.registerShortcut(Key.ctrlShift('u'), {
    description: 'Cycle presets',
    handler: async (ctx) => {
      if (nameOrder.length === 0) {
        ctx.ui.notify('preset: no presets defined', 'warning');
        return;
      }
      const cycle = [...nameOrder, '(none)'];
      const current = activePresetName ?? '(none)';
      const idx = cycle.indexOf(current);
      const next = cycle[(idx === -1 ? 0 : idx + 1) % cycle.length];
      if (next === '(none)') {
        await clearPreset(ctx);
        ctx.ui.notify('preset: cleared', 'info');
        return;
      }
      const preset = presets[next];
      if (!preset) return;
      await applyPreset(next, preset, ctx);
      ctx.ui.notify(`preset: "${next}" activated`, 'info');
    },
  });

  // ───────── System-prompt injection ─────────
  pi.on('before_agent_start', (event) => {
    if (!activePreset?.appendSystemPrompt) return undefined;
    const base = (event as { systemPrompt?: string }).systemPrompt ?? '';
    return { systemPrompt: `${base.replace(/\s+$/, '')}\n\n${activePreset.appendSystemPrompt.trim()}` };
  });

  // ───────── Lifecycle ─────────
  pi.on('session_start', async (_event, ctx) => {
    loadAll(ctx.cwd);
    surfaceWarnings(ctx);

    // Restore from session entries (on /resume)
    const entries = ctx.sessionManager.getEntries();
    const restored = [...entries]
      .reverse()
      .find(
        (e) =>
          (e as { type?: string; customType?: string }).type === 'custom' &&
          (e as { customType?: string }).customType === 'preset-state',
      ) as { data?: { name?: string | null } } | undefined;
    const restoredName = restored?.data?.name ?? null;

    const flag = pi.getFlag('preset');
    const targetName =
      typeof flag === 'string' && flag ? flag : typeof restoredName === 'string' ? restoredName : undefined;

    if (!targetName) {
      updateStatus(ctx);
      return;
    }
    const preset = presets[targetName];
    if (!preset) {
      ctx.ui.notify(`preset: unknown "${targetName}" (available: ${nameOrder.join(', ') || '(none)'})`, 'warning');
      updateStatus(ctx);
      return;
    }
    await applyPreset(targetName, preset, ctx);
  });

  pi.on('session_shutdown', () => {
    presets = {};
    nameOrder = [];
    activePresetName = undefined;
    activePreset = undefined;
    originalState = undefined;
    notifiedWarnings.clear();
  });
}
