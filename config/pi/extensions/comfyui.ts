/**
 * `comfyui` - a local/remote ComfyUI media-generation tool for pi.
 *
 * Registers a single `generate_image` tool the model can call for image or
 * video workflows. The tool
 * loads a named API-format workflow, injects the prompt / seed /
 * dimensions into the nodes named by the workflow's input map, submits
 * it to a ComfyUI server, streams generation progress, fetches the
 * rendered media, saves it to disk, and returns still-image previews inline
 * so both the terminal and vision-capable models can inspect the result.
 *
 * This is NOT a replacement for pi's built-in (provider-routed) image
 * generation - it is a custom tool, the same shape pi's own
 * `antigravity-image-gen.ts` example uses, because there is no
 * extension-pluggable image-provider hook.
 *
 * All pure logic (config layering + `${ENV}` interpolation, workflow
 * param injection, URL building, history / websocket parsing) lives under
 * `lib/node/pi/comfyui/` and is unit-tested. The session-scoped state and
 * the two tool bodies live in `lib/node/pi/ext/comfyui/` (runtime.ts,
 * generate.ts, jobs.ts, params.ts, render.ts, details.ts, images.ts,
 * enhancer.ts); this shell is the thin factory wiring them to pi's tool /
 * command / hook surface.
 *
 * Config layers (lowest -> highest): shipped txt2img default ->
 * <piAgentDir>/comfyui.json -> <cwd>/.pi/comfyui.json. An environment-only
 * setup with PI_COMFYUI_URL uses the shipped Qwen Image 2.1 and MiniMax H3
 * workflows instead.
 *
 * The extension auto-disables when neither config file contributes a `workflows`
 * entry and PI_COMFYUI_URL is unset. The shipped txt2img.api.json is example
 * scaffolding, while Qwen Image 2.1 remains the environment-only default.
 *
 * Environment:
 *   PI_COMFYUI_DISABLED=1   skip the extension entirely
 *   PI_COMFYUI_URL=...      override the configured baseUrl and enable env-only mode
 *   PI_COMFYUI_AUTH=...     Authorization header value in env-only mode
 *   PI_COMFYUI_TOKEN=...    referenced by a config authHeader as ${PI_COMFYUI_TOKEN}
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { COMFYUI_USAGE } from '../../../lib/node/pi/comfyui/usage.ts';
import { describeWorkflows, workflowCapabilities } from '../../../lib/node/pi/comfyui/describe.ts';
import { extractModelCatalog, formatModelCatalog } from '../../../lib/node/pi/comfyui/models.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import {
  loadComfyuiConfig,
  loadUserWorkflowNames,
  resolveAuthHeaders,
  resolveBaseUrl,
  SHIPPED_WORKFLOW_INPUTS,
} from '../../../lib/node/pi/comfyui/config.ts';
import { type Conn, fetchObjectInfo, pingServer } from '../../../lib/node/pi/comfyui/client.ts';
import { formatWorkflowValidation } from '../../../lib/node/pi/comfyui/workflow.ts';
import { formatJobHint, formatRegistry } from '../../../lib/node/pi/comfyui/jobs.ts';
import {
  findGeneration,
  formatGallery,
  formatGenerationDetail,
  formatGenerationHint,
} from '../../../lib/node/pi/comfyui/generations.ts';
import type { ComfyuiConfig, WorkflowConfig } from '../../../lib/node/pi/comfyui/types.ts';
import {
  renderGenerateCall,
  renderGenerateResult,
  renderJobsCall,
  renderJobsResult,
} from '../../../lib/node/pi/ext/comfyui/render.ts';
import { createEnhancerAccess } from '../../../lib/node/pi/ext/comfyui/enhancer.ts';
import { createRefinerAccess } from '../../../lib/node/pi/ext/comfyui/refiner.ts';
import { runRefineCommand } from '../../../lib/node/pi/ext/comfyui/refine-command.ts';
import { ComfyuiRuntime } from '../../../lib/node/pi/ext/comfyui/runtime.ts';
import { buildGenerateParams } from '../../../lib/node/pi/ext/comfyui/params.ts';
import { resolveUsageGuidance } from '../../../lib/node/pi/ext/comfyui/usage-guidance.ts';
import { executeGenerate } from '../../../lib/node/pi/ext/comfyui/generate.ts';
import { actCancel, actCollect, actListJobs } from '../../../lib/node/pi/ext/comfyui/jobs.ts';
import type { LooseMessage } from '../../../lib/node/pi/context-edit/target.ts';

const extDir = dirname(fileURLToPath(import.meta.url));

const QWEN_IMAGE_EDIT_21 = 'qwen-image-edit-2.1';
const MINIMAX_H3_REF2VA = 'minimax-h3-ref2va-spectrum';

// Only on-disk paths are shell-specific; input maps and metadata otherwise
// follow the same declarative WorkflowConfig shape as user workflows.
function shippedWorkflow(): WorkflowConfig {
  return { file: join(extDir, '..', 'comfyui', 'txt2img.api.json'), inputs: SHIPPED_WORKFLOW_INPUTS };
}

function shippedQwenImageEdit21Workflow(): WorkflowConfig {
  return {
    file: join(extDir, '..', 'comfyui', 'qwen-image-edit-2.1.api.json'),
    description: 'Qwen Image 2.1 unified text-to-image and instruction editing with 0-16 references',
    tags: ['photoreal', 'illustration', 'text', 'edit', 'multi-reference'],
    promptProtocol:
      'Natural language. With references, call them <image1> through <image16>; <image1> is the edit target and later images are supporting references.',
    inputs: {
      prompt: { node: '8', key: 'prompt' },
      negative: { node: '8', key: 'negative_prompt' },
      seed: { node: '9', key: 'seed' },
      steps: { node: '9', key: 'steps' },
      cfg: { node: '9', key: 'cfg' },
    },
    images: {
      mode: 'autogrow',
      loader: { node: '7', key: 'image', output: 0 },
      target: { node: '8', keyPrefix: 'images.image_' },
      min: 0,
      max: 16,
    },
  };
}

function shippedMiniMaxH3Ref2vaWorkflow(): WorkflowConfig {
  return {
    file: join(extDir, '..', 'comfyui', 'minimax-h3-ref2va-spectrum.api.json'),
    description: 'MiniMax H3 Ref2VA video with native audio, dual-GPU placement, SageAttention, and Spectrum',
    tags: ['video', 'audio', 'reference', 'minimax-h3', 'sage', 'spectrum'],
    promptProtocol:
      'Natural language. Address references as <Picture 1> through <Picture 9>, <Video 1> through <Video 3>, and <Audio 1> through <Audio 3>.',
    inputs: {
      prompt: { node: '14', key: 'prompt' },
      seed: { node: '15', key: 'noise_seed' },
      steps: { node: '17', key: 'steps' },
      width: { node: '14', key: 'width' },
      height: { node: '14', key: 'height' },
      duration: { node: '14', key: 'length', transform: 'secondsToFrames24H3' },
      refImageSize: { node: '14', key: 'ref_image_size' },
    },
    images: {
      mode: 'autogrow',
      loader: { node: '10', key: 'image', output: 0 },
      target: { node: '14', keyPrefix: 'ref_images.ref_image_', indexBase: 0 },
      min: 0,
      max: 9,
    },
    videos: {
      mode: 'autogrow',
      templates: ['11', '12'],
      loader: { node: '11', key: 'file' },
      outputs: [
        {
          source: { node: '12', output: 0 },
          target: { node: '14', keyPrefix: 'ref_videos.ref_video_', indexBase: 0 },
        },
        {
          source: { node: '12', output: 1 },
          target: { node: '14', keyPrefix: 'ref_video_audios.ref_video_audio_', indexBase: 0 },
        },
      ],
      min: 0,
      max: 3,
    },
    audios: {
      mode: 'autogrow',
      templates: ['13'],
      loader: { node: '13', key: 'audio' },
      outputs: [
        {
          source: { node: '13', output: 0 },
          target: { node: '14', keyPrefix: 'ref_audios.ref_audio_', indexBase: 0 },
        },
      ],
      min: 0,
      max: 3,
    },
    referenceConstraints: { maxTotal: 12, audioRequiresVisual: true },
    outputType: 'video',
  };
}

function envConfigured(): boolean {
  return (process.env.PI_COMFYUI_URL?.trim().length ?? 0) > 0;
}

function loadConfig(cwd: string): ComfyuiConfig {
  const config = loadComfyuiConfig(cwd, shippedWorkflow());
  if (loadUserWorkflowNames(cwd).length > 0 || !envConfigured()) return config;
  return {
    ...config,
    defaultWorkflow: QWEN_IMAGE_EDIT_21,
    workflows: {
      [QWEN_IMAGE_EDIT_21]: shippedQwenImageEdit21Workflow(),
      [MINIMAX_H3_REF2VA]: shippedMiniMaxH3Ref2vaWorkflow(),
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function comfyuiExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_COMFYUI_DISABLED)) return;

  // Registration-time cwd seed. Registration runs before any session
  // exists, so there is no `ctx` to read `ctx.cwd` from yet; the real
  // session cwd arrives on `session_start` (where the runtime re-points
  // its own `cwd`). It is used here only for what can be decided at
  // registration: the auto-disable gate and the workflow list baked into
  // the (immutable) tool description.
  const cwd = process.cwd();

  // Auto-disable when neither a config file nor PI_COMFYUI_URL opts in. A
  // config-backed setup gets its configured workflows plus the classic shipped
  // txt2img example. An environment-only setup gets the known-good shipped Qwen
  // Image 2.1 workflow instead of exposing that server-specific SD1.5 example.
  //
  // This gate is necessarily registration-time: pi has no unregisterTool API,
  // so we cannot register first and back out on `session_start`. It is keyed
  // off the user-global config (cwd-independent) and the project config under
  // the registration-time cwd. A project whose only workflows live under a
  // later `ctx.cwd` that differs from the launch dir would miss this gate, but
  // its handlers still work once that project's config loads at call time.
  if (loadUserWorkflowNames(cwd).length === 0 && !envConfigured()) return;

  const registrationConfig = loadConfig(cwd);
  const defaultWorkflow = registrationConfig.defaultWorkflow;
  const workflowList = Object.keys(registrationConfig.workflows).join(', ') || '(none)';

  // Agent-driven, opt-in prompt enhancer; all wiring lives in
  // ext/comfyui/enhancer.ts (subagent spawn, session manager, caching).
  const enhancerAccess = createEnhancerAccess({ pi, extDir, loadConfig });

  // Agent-driven, opt-in auto-refine vision critic; mirror of the enhancer
  // on the OUTPUT side. Wiring (subagent spawn, session manager, caching)
  // lives in ext/comfyui/refiner.ts.
  const refinerAccess = createRefinerAccess({ pi, extDir, loadConfig });

  // Session-scoped mutable state + lifecycle / context-hook logic. One
  // runtime per extension load; the hooks + tool bodies below delegate to
  // it (see ext/comfyui/runtime.ts).
  const rt = new ComfyuiRuntime({ pi, loadConfig });

  // Multi-line capability matrix (description / tags / mapped params /
  // image slots / prompt protocol per workflow) baked into the immutable
  // tool description so the model picks the right workflow and stops
  // passing args a workflow does not map. The "recommends enhance" hint is
  // surfaced only when the enhancer agent is actually installed and the
  // env kill-switch is not set, so the model never sees a hint it cannot
  // act on.
  const enhanceAvailableAtReg =
    !envTruthy(process.env.PI_COMFYUI_DISABLE_ENHANCE) && enhancerAccess.isAgentInstalled(cwd);
  // The autoRefine + refineCriteria params + the critic's available-action
  // hint surface only when the comfyui-critic agent is installed and not
  // env-disabled (mirrors the enhance gating); the loop still no-ops
  // gracefully at runtime when no vision-capable model resolves.
  const refineAvailableAtReg = !envTruthy(process.env.PI_COMFYUI_DISABLE_REFINE) && refinerAccess.isAgentInstalled(cwd);
  const workflowMatrix = describeWorkflows(registrationConfig.workflows, defaultWorkflow, {
    enhanceHint: enhanceAvailableAtReg,
  });
  // Aggregate image-input / param capabilities across the configured
  // workflows so the `generate_image` schema only advertises params some
  // workflow can actually consume. A pure text-to-image setup never carries
  // `inputImages` / `images` / mask params (keeps the tool definition small).
  const caps = workflowCapabilities(registrationConfig.workflows);

  pi.on('session_start', (_event, ctx) => rt.onSessionStart(ctx));
  // A branch switch (edit/rewind) replays a different history, so re-derive
  // the persisted overlays from the new branch.
  pi.on('session_tree', (_event, ctx) => rt.onSessionTree(ctx));
  pi.on('session_shutdown', (_event, ctx) => rt.onShutdown(ctx));
  pi.on('before_agent_start', (event, ctx) => {
    rt.beforeAgentStart(ctx);
    // Inject the main-agent usage-guidance block (empty unless the user set
    // usageGuidanceFile / usageGuidanceEnhancedFile). Recompute enhancer
    // availability against the live session cwd so the "enhanced" variant is
    // picked only when enhancement will actually run (an on-by-default enhance
    // with no agent installed silently no-ops, so the model still needs the
    // base protocol). The block is session-stable, so it stays on the
    // cacheable prompt prefix. See ext/comfyui/usage-guidance.ts.
    const enhanceAvailable =
      !envTruthy(process.env.PI_COMFYUI_DISABLE_ENHANCE) && enhancerAccess.isAgentInstalled(ctx.cwd);
    const block = resolveUsageGuidance({ config: loadConfig(ctx.cwd), enhanceAvailable, fromCwd: ctx.cwd });
    return block.length > 0 ? { systemPrompt: [event.systemPrompt, block].join('\n\n') } : undefined;
  });
  // Remind the model about pending image jobs each turn, collapse ephemeral
  // renders out of the outgoing payload, and snapshot enhancer scene context
  // (all via the `context` hook so the system prompt stays byte-stable).
  pi.on('context', (event) => {
    const result = rt.applyContextHook(event.messages as unknown as LooseMessage[]);
    return result ? { messages: result.messages as unknown as typeof event.messages } : undefined;
  });

  // Build the parameter schema from the configured workflows' capabilities
  // (drops params no workflow can consume). The executor reads
  // `params.X ?? config.X`, so a dropped param is purely a schema change.
  const GenerateParams = buildGenerateParams(registrationConfig, caps, enhanceAvailableAtReg, refineAvailableAtReg);

  pi.registerTool({
    name: 'generate_image',
    label: 'Generate media',
    description:
      `Generate an image or video from a prompt via a ComfyUI server. ` +
      `Use when the user asks to create, draw, render, or generate visual media. ` +
      `Each workflow bakes in its own checkpoint/sampler/scheduler; pick one by capability and prompt in its protocol. ` +
      `Available workflows (default ${defaultWorkflow}):\n${workflowMatrix}\n` +
      `Saved to disk; still images and video preview frames are returned so you can inspect them.`,
    promptSnippet: `To create or render an image or video, call \`generate_image\` (workflows: ${workflowList}) instead of describing it in text.`,
    promptGuidelines: [
      "Never call ComfyUI's HTTP API (`/object_info`, `/prompt`, `/view`, …) via bash/curl/anything - `generate_image` is the only entry point; it encapsulates model and sampler choice.",
      ...(caps.positionalImages
        ? ['Only pass `inputImages` when the selected workflow supports image references.']
        : []),
      ...(caps.videoInput ? ['Only pass `inputVideos` when the selected workflow supports video references.'] : []),
      ...(caps.audioInput ? ['Only pass `inputAudios` when the selected workflow supports audio references.'] : []),
    ],
    parameters: GenerateParams,

    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      executeGenerate(rt, enhancerAccess, refinerAccess, toolCallId, params, signal, onUpdate, ctx),

    renderCall: (args, theme) => renderGenerateCall(args, theme),
    renderResult: (result, options, theme, context) => renderGenerateResult(result, options, theme, context),
  });

  // ── image_jobs: manage background generations ──────────────────────

  const ImageJobsParams = Type.Object({
    action: StringEnum(['list', 'collect', 'cancel'] as const, {
      description:
        'list (all background jobs), collect (poll a job; returns saved media and image previews when ready), cancel (drop a still-queued job).',
    }),
    id: Type.Optional(Type.String({ description: 'Job id (required for collect / cancel).' })),
  });

  pi.registerTool({
    name: 'image_jobs',
    label: 'Media jobs',
    description:
      'Manage background media generations (those started by generate_image with background=true). ' +
      'Actions: list, collect (poll, returning the image(s) once ready), cancel.',
    promptSnippet:
      'After a background generate_image (background=true), use image_jobs collect with the returned id to retrieve the image once ready.',
    parameters: ImageJobsParams,

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams;
      switch (params.action) {
        case 'list':
          return actListJobs(rt);
        case 'collect':
          return await actCollect(rt, params.id, ctx, signal);
        case 'cancel':
          return await actCancel(rt, params.id, ctx, signal);
      }
    },

    renderCall: (args, theme) => renderJobsCall(args, theme),
    renderResult: (result, _options, theme) => renderJobsResult(result, theme),
  });

  pi.registerCommand('comfyui', {
    description: 'Inspect ComfyUI status, workflows, and background jobs',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(prefix, {
        workflows: {
          description: 'Validate configured workflows',
          // Re-read config so a `/reload`-free config edit still completes.
          args: () => Object.keys(loadConfig(rt.cwd).workflows).map((label) => ({ label })),
        },
        jobs: {
          description: 'List background generations',
          args: () => rt.registry.jobs.map((j) => ({ label: j.id, description: formatJobHint(j) })),
        },
        gallery: {
          description: 'List recorded generations (reuse with variationOf / refine)',
          args: () => rt.generations.generations.map((g) => ({ label: g.id, description: formatGenerationHint(g) })),
        },
        refine: {
          description: 'Auto-refine a recorded generation through the vision critic loop',
          args: () => rt.generations.generations.map((g) => ({ label: g.id, description: formatGenerationHint(g) })),
        },
        models: {
          description: 'List installed models from the server (/object_info)',
        },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(COMFYUI_USAGE, 'info');
        return;
      }
      const config = loadConfig(ctx.cwd);
      const base = resolveBaseUrl(config);
      const headers = resolveAuthHeaders(config);
      const conn: Conn = { base, headers, timeoutMs: config.timeoutMs };
      const sub = args.trim().toLowerCase();

      if (sub === 'jobs') {
        ctx.ui.notify(formatRegistry(rt.registry, Date.now()), 'info');
        return;
      }

      if (sub === 'gallery' || sub.startsWith('gallery ')) {
        const id = sub.slice('gallery'.length).trim();
        if (id.length === 0) {
          ctx.ui.notify(formatGallery(rt.generations), 'info');
          return;
        }
        const rec = findGeneration(rt.generations, id);
        ctx.ui.notify(
          rec ? formatGenerationDetail(rec) : `unknown generation "${id}" (see /comfyui gallery)`,
          rec ? 'info' : 'warning',
        );
        return;
      }

      // Standalone auto-refine of a recorded generation (gallery id only):
      // runs the same critic loop, writes a NEW gallery entry with lineage,
      // saves to disk, and notifies the user (nothing reaches model context).
      if (sub === 'refine' || sub.startsWith('refine ')) {
        const id = args.trim().slice('refine'.length).trim();
        if (id.length === 0) {
          ctx.ui.notify('Usage: /comfyui refine <gX>  (refine a recorded generation; see /comfyui gallery)', 'info');
          return;
        }
        await runRefineCommand(rt, refinerAccess, id, ctx);
        return;
      }

      // Read-only operator aid: dump the installed model files the server
      // advertises so a human can fill `ckpt_name` / `lora_name` values
      // when configuring a workflow. Never surfaced to the model.
      if (sub === 'models') {
        try {
          const objectInfo = await fetchObjectInfo(conn, AbortSignal.timeout(conn.timeoutMs));
          ctx.ui.notify(formatModelCatalog(extractModelCatalog(objectInfo)), 'info');
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`could not fetch models from ${base}: ${reason}`, 'error');
        }
        return;
      }

      if (sub === 'workflows') {
        ctx.ui.notify(formatWorkflowValidation(config.workflows, ctx.cwd, homedir()), 'info');
        return;
      }

      const reachable = await pingServer(conn);
      const names = Object.keys(config.workflows).join(', ') || '(none)';
      ctx.ui.notify(
        [
          `comfyui: ${base} ${reachable ? '(reachable)' : '(unreachable)'}`,
          `auth: ${Object.keys(headers).length > 0 ? `on (${Object.keys(headers).join(', ')})` : 'off'}`,
          `default workflow: ${config.defaultWorkflow}`,
          `workflows: ${names}`,
          `saveDir: ${config.saveDir}`,
        ].join('\n'),
        reachable ? 'info' : 'warning',
      );
    },
  });
}
