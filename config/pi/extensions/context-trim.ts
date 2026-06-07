/**
 * Context-trim extension for pi - remove large/bulky content (images,
 * oversized tool results, long messages) from the model's context,
 * replaced by a short placeholder, to reclaim context window.
 *
 * This is one of three extensions built on the shared context-edit core
 * (`lib/node/pi/context-edit/`); the others are `message-edit` (edit a
 * message in place) and `tool-collapse` (collapse a tool call+result).
 * All three apply a NON-DESTRUCTIVE overlay in the `context` hook: the
 * original content stays recorded in the session `.jsonl`, the overlay is
 * reapplied every turn, and it is reconstructed from a persisted `custom`
 * session entry on `session_start` - so trims survive `/reload` AND exit
 * -> resume. Nothing is ever actually deleted; `restore` brings it back.
 *
 * Why not pi's append-only branching? Branching from an earlier entry
 * deletes every downstream turn. Trimming one image in the middle of a
 * long session must keep all later turns intact, so we overlay instead.
 *
 * Affordances:
 *
 *   1. `/context-trim` (no args) lists trimmable candidates, heaviest
 *      first: images, tool results over a size threshold, and long
 *      user/assistant messages. Each gets a short handle (img1, tool3,
 *      msg2) you pass to trim it.
 *
 *   2. `/context-trim <handle> [reason]` adds a trim directive. From the
 *      next turn the targeted content shows as `[IMAGE REMOVED]` /
 *      `[CONTENT TRIMMED - N lines, X KB]`.
 *
 *   3. `/context-trim list` shows active trims; `restore <#id>` / `clear`
 *      undo them.
 *
 * Pure logic (directive set, target resolution, the overlay pass,
 * candidate enumeration, config) lives under
 * `lib/node/pi/context-edit/` so it is unit-tested under vitest. This
 * file holds only the pi-coupled glue.
 *
 * Environment:
 *   PI_CONTEXT_TRIM_DISABLED=1        skip the extension entirely
 *   PI_CONTEXT_TRIM_MIN_BYTES=N       min text-part size to offer (default 2048)
 *   PI_CONTEXT_TRIM_SNIPPET_CHARS=N   snippet width in listings (default 80)
 *   PI_CONTEXT_TRIM_CAPTION_MODEL=p/id  vision model for auto-caption when the
 *                                     active model is text-only (also a
 *                                     `captionModel` key in context-trim.json)
 *
 * Image descriptions: when an image is trimmed the placeholder embeds a
 * short caption of what it depicted, computed ONCE at trim time (agent
 * summary > generation prompt for comfyui/generate_image > vision
 * auto-caption) and persisted in the directive so it is stamped each turn
 * without ever recomputing - recomputing in the `context` hook would fire
 * a vision call per turn and break prefix caching.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Model } from '@earendil-works/pi-ai';
import {
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type ModelRegistry,
  parseFrontmatter,
  type ResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { applyDirectives } from '../../../lib/node/pi/context-edit/apply.ts';
import { loadTrimConfig, type TrimConfig } from '../../../lib/node/pi/context-edit/config.ts';
import {
  addTrim,
  clearDirectives,
  type ContextEditState,
  cloneState,
  emptyState,
  reduceBranch,
  removeDirective,
} from '../../../lib/node/pi/context-edit/directive.ts';
import { completeCandidatesOrVerbs, type CompletionCandidate } from '../../../lib/node/pi/context-edit/complete.ts';
import { type Candidate, candidateLabel, enumerate } from '../../../lib/node/pi/context-edit/enumerate.ts';
import {
  buildCaptionTask,
  CAPTION_MAX_CHARS,
  extractGenerationPrompt,
  imageExtForMime,
  needsAutoCaption,
  selectImageDescription,
} from '../../../lib/node/pi/context-edit/image-description.ts';
import {
  type LooseMessage,
  type LoosePart,
  resolveTarget,
  type Target,
  toParts,
} from '../../../lib/node/pi/context-edit/target.ts';
import { CONTEXT_TRIM_USAGE } from '../../../lib/node/pi/context-edit/usage.ts';
import { isVisionCapable } from '../../../lib/node/pi/model-capability.ts';
import { createNotifyOnce } from '../../../lib/node/pi/notify-once.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import {
  type AgentDef,
  type AgentLoadResult,
  type AgentLoadWarning,
  defaultAgentLayers,
  loadAgents,
  makeNodeReadLayer,
} from '../../../lib/node/pi/subagent/loader.ts';
import { createPersistedSubagentSessionManager } from '../../../lib/node/pi/subagent/session-dir.ts';
import { adaptCreateAgentSession, resolveChildModel, runOneShotAgent } from '../../../lib/node/pi/subagent/spawn.ts';

/**
 * Pi's `createAgentSession` types `modelRegistry` as the concrete
 * `ModelRegistry` class, while `lib/node/pi/subagent/spawn.ts` uses a
 * pi-free structural `ModelRegistryLike`. Adapt once here (mirrors
 * `iteration-loop.ts`).
 */
const piCreateAgentSession = adaptCreateAgentSession<Model<any>, SessionManager, ModelRegistry, ResourceLoader>(
  createAgentSession,
);

/** Agent that turns a staged image file into one dense caption (source 3). */
const CAPTION_AGENT = 'image-captioner';

const CUSTOM_TYPE = 'context-trim-state';

export default function contextTrimExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_CONTEXT_TRIM_DISABLED)) return;

  // Per-session directive set, rebuilt from the branch on load.
  let state: ContextEditState = emptyState();
  // Snapshot of the resolved messages from the most recent `context`
  // hook - the exact list the model saw - so `/context-trim` enumerates
  // candidates that resolve back cleanly. Before the first LLM call we
  // fall back to building the context from session entries on demand.
  let lastContextMessages: LooseMessage[] | null = null;
  let config: TrimConfig = loadTrimConfig(process.cwd());
  // Candidate handles for the Tab-completion menu. `getArgumentCompletions`
  // receives no ctx, so we keep this snapshot fresh from the context hook
  // (and after each command) and let completion read it.
  let completionCandidates: CompletionCandidate[] = [];

  // Subagent definitions (for the image auto-caption fallback), rebuilt
  // from disk on load like iteration-loop's critic.
  const extDir = dirname(fileURLToPath(import.meta.url));
  const readLayer = makeNodeReadLayer();
  let agentLoad: AgentLoadResult = { agents: new Map(), nameOrder: [], warnings: [] };
  const agentWarnings = createNotifyOnce<AgentLoadWarning>({
    tag: 'context-trim',
    keyOf: (w) => `${w.path}:${w.reason}`,
    render: (w, tag) => `${tag}: ${w.path}: ${w.reason}`,
  });

  const reloadAgents = (cwd: string): void => {
    const knownToolNames = new Set(pi.getAllTools().map((t) => t.name));
    agentLoad = loadAgents({
      layers: defaultAgentLayers({ extensionDir: extDir, cwd }),
      knownToolNames,
      fs: readLayer,
      parseFrontmatter,
    });
  };

  const rebuildFromSession = (ctx: ExtensionContext): void => {
    state = reduceBranch(ctx.sessionManager.getBranch() as never, CUSTOM_TYPE);
    config = loadTrimConfig(ctx.sessionManager.getCwd());
    try {
      reloadAgents(ctx.sessionManager.getCwd());
      if (ctx.hasUI) agentWarnings.surface(ctx.ui.notify.bind(ctx.ui), agentLoad.warnings);
    } catch {
      // Caption is best-effort; a failed agent load just disables source 3.
    }
  };

  pi.on('session_start', (_event, ctx) => rebuildFromSession(ctx));
  pi.on('session_tree', (_event, ctx) => rebuildFromSession(ctx));

  // Only candidates worth trimming: images, large tool results, and long
  // messages (drop the tool-call kind - that's tool-collapse's job).
  const candidatesFrom = (messages: readonly LooseMessage[]): Candidate[] =>
    enumerate(messages, { minTextBytes: config.minTextBytes, snippetChars: config.snippetChars }).filter(
      (c) => c.kind !== 'tool-call',
    );

  // Keep the Tab-completion snapshot in sync with the latest candidates.
  const refreshCompletion = (cands: readonly Candidate[]): void => {
    completionCandidates = cands.map((c) => ({ id: c.id, description: candidateLabel(c) }));
  };

  // Apply the overlay every turn, snapshot what the model sees, and refresh
  // the completion candidates so the menu reflects the live context.
  pi.on('context', (event) => {
    const messages = (event as unknown as { messages?: LooseMessage[] }).messages;
    if (!Array.isArray(messages)) return undefined;
    lastContextMessages = messages;
    let out = messages;
    let applied = 0;
    if (state.directives.length > 0) {
      const result = applyDirectives(messages, state.directives);
      lastContextMessages = result.messages;
      out = result.messages;
      applied = result.applied;
    }
    refreshCompletion(candidatesFrom(out));
    return applied > 0 ? { messages: out as never } : undefined;
  });

  // Resolve the message list to enumerate against: prefer the live
  // snapshot, else build it from the current branch.
  const currentMessages = (ctx: ExtensionContext): LooseMessage[] => {
    if (lastContextMessages) return lastContextMessages;
    try {
      const built = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
      return (built.messages as unknown as LooseMessage[]) ?? [];
    } catch {
      return [];
    }
  };

  const trimCandidates = (ctx: ExtensionContext): Candidate[] => {
    const cands = candidatesFrom(currentMessages(ctx));
    refreshCompletion(cands);
    return cands;
  };

  const persist = (ctx: ExtensionContext): void => {
    try {
      pi.appendEntry(CUSTOM_TYPE, cloneState(state));
    } catch {
      // Never let bookkeeping break the command.
    }
    // Re-snapshot so a follow-up listing reflects the new overlay.
    lastContextMessages = null;
    void ctx;
  };

  // ── Image description (image-descriptions plan, source-priority) ──────
  // Locate the first image part backing an image candidate so we can both
  // stage it for the auto-caption agent and not need a session lookup.
  const findImagePart = (messages: readonly LooseMessage[], target: Target): LoosePart | undefined => {
    const hit = resolveTarget(messages, target);
    if (!hit) return undefined;
    const parts = toParts(messages[hit.messageIndex].content);
    if (hit.partIndex !== undefined) {
      const p = parts[hit.partIndex];
      return p?.type === 'image' ? p : undefined;
    }
    return parts.find((p) => p.type === 'image');
  };

  // Source 3: one vision pass via the `image-captioner` subagent. Returns
  // undefined (size-only) whenever a caption isn't reachable - no vision
  // model, no image bytes, agent missing, or the child failed / said
  // `null`. Never throws into the command path.
  const autoCaptionImage = async (ctx: ExtensionContext, imagePart: LoosePart): Promise<string | undefined> => {
    const override = config.captionModel;
    // No override + a text-only active model => skip (the chosen gap).
    if (!override && !isVisionCapable((ctx.model ?? {}) as { input?: string[] })) return undefined;

    const agent: AgentDef | undefined = agentLoad.agents.get(CAPTION_AGENT);
    if (!agent) return undefined;

    const data = (imagePart as { data?: unknown }).data;
    if (typeof data !== 'string' || data.length === 0) return undefined;
    const mimeType =
      typeof (imagePart as { mimeType?: unknown }).mimeType === 'string'
        ? (imagePart as { mimeType: string }).mimeType
        : undefined;

    const modelResolution = resolveChildModel({
      override,
      agent,
      parent: ctx.model,
      modelRegistry: ctx.modelRegistry,
    });
    if (!modelResolution.ok) return undefined;

    let tmpDir: string | undefined;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), 'pi-context-trim-caption-'));
      const imagePath = join(tmpDir, `image.${imageExtForMime(mimeType)}`);
      writeFileSync(imagePath, Buffer.from(data, 'base64'));

      const result = await runOneShotAgent({
        deps: { createAgentSession: piCreateAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
        cwd: ctx.cwd,
        agent,
        model: modelResolution.model,
        task: buildCaptionTask(imagePath, CAPTION_MAX_CHARS),
        modelRegistry: ctx.modelRegistry,
        agentDir: getAgentDir(),
        // Persist the caption transcript under
        // `<parentSessionDir>/<parentSid>/subagents/` (never in-memory) so
        // cost attribution + forensic debugging survive - see
        // `config/pi/extensions/AGENTS.md`.
        sessionManager: createPersistedSubagentSessionManager({
          cwd: ctx.cwd,
          parentSessionManager: ctx.sessionManager,
          extensionLabel: 'context-trim',
          SessionManager,
        }),
      });
      if (result.stopReason !== 'completed') return undefined;
      const caption = result.finalText.trim();
      if (!caption || caption.toLowerCase() === 'null') return undefined;
      return caption;
    } catch {
      return undefined;
    } finally {
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  };

  // Compute the description ONCE at trim time, in priority order. Sources
  // 1 (agent summary) and 2 (generation prompt) are free; source 3
  // (auto-caption) only runs when the first two are empty.
  const computeImageDescription = async (
    ctx: ExtensionContext,
    cand: Candidate,
    messages: readonly LooseMessage[],
  ): Promise<string | undefined> => {
    // Feature-1 seam: a `drop_image({ summary })` arg will populate this.
    // Absent until feature 1 lands, so it stays undefined for now.
    const agentSummary: string | undefined = undefined;
    const generationPrompt = cand.toolCallId ? extractGenerationPrompt(messages, cand.toolCallId) : undefined;

    let autoCaption: string | undefined;
    if (needsAutoCaption({ agentSummary, generationPrompt }) && cand.target) {
      const imagePart = findImagePart(messages, cand.target);
      if (imagePart) autoCaption = await autoCaptionImage(ctx, imagePart);
    }
    return selectImageDescription({ agentSummary, generationPrompt, autoCaption });
  };

  const listCandidates = (ctx: ExtensionContext): string => {
    const cands = trimCandidates(ctx);
    if (cands.length === 0) return 'Nothing large enough to trim in the current context.';
    const lines = cands.map((c) => `  ${c.id}  ${candidateLabel(c)}`);
    return ['Trimmable content (heaviest first):', ...lines, '', 'Trim with: /context-trim <id> [reason]'].join('\n');
  };

  const listActive = (): string => {
    const trims = state.directives.filter((d) => d.kind === 'trim');
    if (trims.length === 0) return 'No active trims.';
    return ['Active trims:', ...trims.map((d) => `  #${d.id}  ${d.reason ?? '(no reason)'}`)].join('\n');
  };

  pi.registerCommand('context-trim', {
    description: 'Trim large content (images, big tool results, long messages) out of the context',
    getArgumentCompletions: (prefix) =>
      completeCandidatesOrVerbs(prefix, completionCandidates, {
        list: { description: 'Show active trims' },
        restore: {
          description: 'Undo a trim by #id',
          args: () => state.directives.filter((d) => d.kind === 'trim').map((d) => ({ label: String(d.id) })),
        },
        clear: { description: 'Undo all trims' },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(CONTEXT_TRIM_USAGE, 'info');
        return;
      }
      const raw = (args ?? '').trim();
      if (raw === '') {
        ctx.ui.notify(listCandidates(ctx), 'info');
        return;
      }

      const [verb, ...rest] = raw.split(/\s+/);
      const tail = rest.join(' ');

      if (verb === 'list') {
        ctx.ui.notify(listActive(), 'info');
        return;
      }
      if (verb === 'clear') {
        const r = clearDirectives(state, 'trim');
        if (r.ok) {
          state = r.state;
          persist(ctx);
        }
        ctx.ui.notify(r.ok ? r.summary : r.error, r.ok ? 'info' : 'warning');
        return;
      }
      if (verb === 'restore') {
        const id = Number.parseInt(tail, 10);
        if (!Number.isFinite(id)) {
          ctx.ui.notify('restore needs a numeric #id (see /context-trim list)', 'warning');
          return;
        }
        const r = removeDirective(state, id);
        if (r.ok) {
          state = r.state;
          persist(ctx);
        }
        ctx.ui.notify(r.ok ? r.summary : r.error, r.ok ? 'info' : 'warning');
        return;
      }

      // Otherwise treat the first token as a candidate handle.
      const cand = trimCandidates(ctx).find((c) => c.id === verb);
      if (!cand?.target) {
        ctx.ui.notify(`Unknown candidate "${verb}". Run /context-trim to list handles.`, 'warning');
        return;
      }
      const reason = tail || undefined;
      // For images, compute the placeholder caption ONCE here and persist
      // it in the directive (sources: agent summary > generation prompt >
      // vision auto-caption). Non-image trims carry no description.
      let description: string | undefined;
      if (cand.kind === 'image') {
        try {
          description = await computeImageDescription(ctx, cand, currentMessages(ctx));
        } catch {
          // Captioning is best-effort; fall back to a size-only placeholder.
        }
      }
      const r = addTrim(state, cand.target, reason, Date.now(), description);
      if (r.ok) {
        state = r.state;
        persist(ctx);
        ctx.ui.notify(`${r.summary}: ${candidateLabel(cand)}`, 'info');
      } else {
        ctx.ui.notify(r.error, 'warning');
      }
    },
  });
}
