/**
 * `comfyui` - a local/remote ComfyUI image-generation tool for pi.
 *
 * Registers a single `generate_image` tool the model can call. The tool
 * loads a named API-format workflow, injects the prompt / seed /
 * dimensions into the nodes named by the workflow's input map, submits
 * it to a ComfyUI server, streams generation progress, fetches the
 * rendered PNG(s), saves them to disk, and returns them inline as
 * multimodal tool results so both the terminal and vision-capable models
 * see the image.
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
 * <piAgentDir>/comfyui.json -> <cwd>/.pi/comfyui.json.
 *
 * The extension auto-disables when neither config file contributes a `workflows`
 * entry. The shipped txt2img.api.json is an example, not a real default, so
 * without user workflows we deregister rather than leak a broken option into the
 * tool list.
 *
 * Environment:
 *   PI_COMFYUI_DISABLED=1   skip the extension entirely
 *   PI_COMFYUI_URL=...      override the configured baseUrl
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
import { executeGenerate } from '../../../lib/node/pi/ext/comfyui/generate.ts';
import { actCancel, actCollect, actListJobs } from '../../../lib/node/pi/ext/comfyui/jobs.ts';
import type { LooseMessage } from '../../../lib/node/pi/context-edit/target.ts';

const extDir = dirname(fileURLToPath(import.meta.url));

// Only the on-disk path of the shipped example workflow is shell-specific;
// its input map is pure data (SHIPPED_WORKFLOW_INPUTS in lib).
function shippedWorkflow(): WorkflowConfig {
  return { file: join(extDir, '..', 'comfyui', 'txt2img.api.json'), inputs: SHIPPED_WORKFLOW_INPUTS };
}

function loadConfig(cwd: string): ComfyuiConfig {
  return loadComfyuiConfig(cwd, shippedWorkflow());
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

  // Auto-disable when no user-supplied workflows exist. The shipped txt2img
  // graph (config/pi/comfyui/txt2img.api.json) is an example - it expects a
  // v1-5-pruned-emaonly checkpoint that most servers won't have - so registering
  // the tool with only that available would leak a broken option into the model's
  // tool list. The user has to point at their own workflow in
  // ~/.pi/agent/comfyui.json or <cwd>/.pi/comfyui.json to opt in.
  //
  // This gate is necessarily registration-time: pi has no unregisterTool API,
  // so we cannot register first and back out on `session_start`. It is keyed
  // off the user-global config (cwd-independent) and the project config under
  // the registration-time cwd. A project whose only workflows live under a
  // later `ctx.cwd` that differs from the launch dir would miss this gate, but
  // its handlers still work once that project's config loads at call time.
  if (loadUserWorkflowNames(cwd).length === 0) return;

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
  pi.on('before_agent_start', (_event, ctx) => {
    rt.beforeAgentStart(ctx);
    return undefined;
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
    label: 'Generate image',
    description:
      `Generate an image from a prompt via a ComfyUI server and return it inline. ` +
      `Use when the user asks to create, draw, render, or generate a picture. ` +
      `Each workflow bakes in its own checkpoint/sampler/scheduler; pick one by capability and prompt in its protocol. ` +
      `Available workflows (default ${defaultWorkflow}):\n${workflowMatrix}\n` +
      `Saved to disk and returned so you can see it.`,
    promptSnippet: `To create or render an image, call \`generate_image\` (workflows: ${workflowList}) instead of describing it in text.`,
    promptGuidelines: [
      "Never call ComfyUI's HTTP API (`/object_info`, `/prompt`, `/view`, …) via bash/curl/anything - `generate_image` is the only entry point; it encapsulates model and sampler choice.",
      ...(caps.positionalImages ? ['Only pass `inputImages` for img2img / edit workflows.'] : []),
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
        'list (all background jobs), collect (poll a job; returns images once ready, "still running" otherwise - safe to repeat), cancel (drop a still-queued job).',
    }),
    id: Type.Optional(Type.String({ description: 'Job id (required for collect / cancel).' })),
  });

  pi.registerTool({
    name: 'image_jobs',
    label: 'Image jobs',
    description:
      'Manage background image generations (those started by generate_image with background=true). ' +
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
          `auth: ${config.authHeader ? `on (${config.authHeader.name})` : 'off'}`,
          `default workflow: ${config.defaultWorkflow}`,
          `workflows: ${names}`,
          `saveDir: ${config.saveDir}`,
        ].join('\n'),
        reachable ? 'info' : 'warning',
      );
    },
  });
}
