import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ReminderMessage } from '../context-reminder.ts';
import { reminderMessageAnchor } from '../reminder-identity.ts';
import { loadRoleplayConfigWithSources } from '../roleplay/config.ts';
import { latestSceneBoundary } from '../roleplay/scene-state.ts';
import {
  associateRoleplayRequestUsage,
  captureRoleplayRequest,
  formatRoleplayRequest,
  readRoleplayRequestMetadata,
  roleplayGenerationOptions,
  roleplayModelIdentity,
  type FormatRoleplayRequestOptions,
  type RoleplayRequestContent,
  type RoleplayRequestMetadata,
} from '../roleplay/request-report.ts';
import { extractionJobMetadata, scanExtractionJobs } from '../roleplay/extraction-jobs.ts';
import { readRoleplayPolicyOverrides, type EffectiveRoleplayPolicy } from '../roleplay/retention-policy.ts';
import type { ContextWindowReadoutSnapshot } from '../roleplay/context-readout.ts';
import { isRecord } from '../shared/guards.ts';

export const ROLEPLAY_REQUEST_ENTRY = 'roleplay-request';
const CAPTURE_ENTRY = 'roleplay-request-capture';

interface DiagnosticSource {
  cast: () => string | null;
  scene: (ctx: ExtensionContext) => readonly ReminderMessage[];
  recap: () => string;
  timeline: () => string;
  coverage: () => number;
  policy: (ctx: ExtensionContext) => EffectiveRoleplayPolicy;
  window: () => ContextWindowReadoutSnapshot | null;
  recapModel: (ctx: ExtensionContext) => { provider?: string; id?: string } | undefined;
  recapAsync: (ctx: ExtensionContext) => boolean;
  config?: () => ReturnType<typeof loadRoleplayConfigWithSources>;
}

function branch(ctx: ExtensionContext): Record<string, unknown>[] {
  const entries = ctx.sessionManager.getBranch() as unknown as Record<string, unknown>[];
  const boundary = latestSceneBoundary(entries);
  return boundary ? entries.slice(entries.indexOf(boundary) + 1) : entries;
}

function reportEntries(ctx: ExtensionContext, cast: string): RoleplayRequestMetadata[] {
  return branch(ctx).flatMap((entry) => {
    if (
      entry.type !== 'custom' ||
      entry.customType !== ROLEPLAY_REQUEST_ENTRY ||
      !isRecord(entry.data) ||
      entry.data.cast !== cast
    )
      return [];
    const metadata = readRoleplayRequestMetadata(entry.data.metadata);
    return metadata ? [metadata] : [];
  });
}

/** Pi-coupled observation only. Never returns a changed payload or injects reports into context. */
export function createRoleplayDiagnostics(
  pi: ExtensionAPI,
  source: DiagnosticSource,
): {
  capture: (messages: readonly ReminderMessage[], ctx: ExtensionContext) => void;
  handle: (verb: string, args: readonly string[], ctx: ExtensionContext) => boolean;
  reset: () => void;
} {
  let latest: { cast: string; metadata: RoleplayRequestMetadata; content: RoleplayRequestContent } | null = null;
  let awaitingUsage = false;
  let ambiguousUsage = false;
  const reset = (): void => {
    latest = null;
    awaitingUsage = false;
    ambiguousUsage = false;
  };
  const contentEnabled = (ctx: ExtensionContext, cast: string): boolean => {
    const entry = branch(ctx).findLast(
      (item) => item.customType === CAPTURE_ENTRY && isRecord(item.data) && item.data.cast === cast,
    );
    return isRecord(entry?.data) && entry.data.enabled === true;
  };
  const persist = (ctx: ExtensionContext, includeContent = false): void => {
    if (!latest || source.cast() !== latest.cast) return;
    try {
      pi.appendEntry(ROLEPLAY_REQUEST_ENTRY, {
        cast: latest.cast,
        metadata: latest.metadata,
        ...(includeContent && contentEnabled(ctx, latest.cast) ? { content: latest.content } : {}),
      });
    } catch {
      /* Diagnostics cannot make provider calls fail. */
    }
  };
  const capture = (messages: readonly ReminderMessage[], ctx: ExtensionContext): void => {
    const cast = source.cast();
    if (!cast) return;
    const scene = source.scene(ctx);
    const users = scene.filter((message) => message.role === 'user' && message.cacheReminderSnapshot !== true);
    const turnOrdinal = users.length;
    const previous = reportEntries(ctx, cast).at(-1);
    const requestOrdinal = previous?.turnOrdinal === turnOrdinal ? previous.requestOrdinal + 1 : 1;
    const resolved = source.config?.() ?? loadRoleplayConfigWithSources(ctx.cwd);
    const cfg = resolved.config;
    const policy = source.policy(ctx);
    const overrides = readRoleplayPolicyOverrides(branch(ctx), cast);
    const captured = captureRoleplayRequest({
      messages,
      scene,
      turnOrdinal,
      requestOrdinal,
      outcome: 'projected',
      requestKind: requestOrdinal === 1 ? 'narrative' : 'continuation',
      createdAt: Date.now(),
      estimatedInputTokens: Math.round(source.window()?.estSentPromptTokens ?? 0),
      origin: users.at(-1) ? reminderMessageAnchor(users.at(-1)!) : undefined,
      recap: { text: source.recap(), coveredFrom: 0, coveredTo: source.coverage() },
      timeline: { text: source.timeline() },
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      configSources: {
        ...resolved.sources,
        windowTokens: 'model',
        ...(overrides.target !== undefined ? { promptTokenTarget: 'branch' as const } : {}),
        ...(overrides.pin !== undefined ? { pinSceneOpener: 'branch' as const } : {}),
        ...(overrides.includeReply !== undefined ? { pinSceneOpenerReply: 'branch' as const } : {}),
      },
      config: {
        windowTokens: ctx.model?.contextWindow ?? 0,
        charBudget: cfg.charBudget,
        loreCharBudget: cfg.loreCharBudget,
        recapStride: cfg.recapStride,
        recapMaxAdvance: cfg.recapMaxAdvance,
        depthLoreInlineTail: cfg.depthLoreInlineTail,
        recapAsync: cfg.recapAsync,
        promptTokenTarget: policy.target,
        pinSceneOpener: policy.pin,
        pinSceneOpenerReply: policy.includeReply,
        keepTurns: cfg.keepTurns,
        recapChunk: cfg.recapChunk,
        capture: cfg.capture,
        timeline: cfg.timeline,
      },
    });
    if (awaitingUsage) ambiguousUsage = true;
    latest = { cast, ...captured };
    awaitingUsage = true;
    persist(ctx, true);
  };
  pi.on('before_provider_request', (event, ctx) => {
    if (!latest || !awaitingUsage || ambiguousUsage || latest.cast !== source.cast()) return;
    latest.metadata = {
      ...latest.metadata,
      outcome: 'attempted',
      generation: roleplayGenerationOptions(event.payload),
    };
    persist(ctx);
  });
  pi.on('message_end', (event, ctx) => {
    if (
      !latest ||
      !awaitingUsage ||
      ambiguousUsage ||
      latest.cast !== source.cast() ||
      event.message.role !== 'assistant'
    )
      return;
    const message = event.message;
    latest.metadata = {
      ...associateRoleplayRequestUsage(latest.metadata, {
        turnOrdinal: latest.metadata.turnOrdinal,
        requestOrdinal: latest.metadata.requestOrdinal,
        usage: message.usage,
      }),
      outcome: message.stopReason === 'error' ? 'failed' : message.stopReason === 'aborted' ? 'aborted' : 'completed',
    };
    awaitingUsage = false;
    persist(ctx);
  });
  pi.on('session_start', reset);
  pi.on('session_tree', reset);
  pi.on('session_shutdown', reset);
  pi.on('agent_settled', () => {
    awaitingUsage = false;
    ambiguousUsage = false;
  });

  const handle = (verb: string, args: readonly string[], ctx: ExtensionContext): boolean => {
    if (verb !== 'request' && verb !== 'debug') return false;
    const cast = source.cast();
    if (!cast) {
      ctx.ui.notify('Roleplay diagnostics are dormant: select a roleplay persona first.', 'info');
      return true;
    }
    if (verb === 'request' && args[0] === 'capture') {
      if (args.length !== 2 || !['on', 'off'].includes(args[1])) {
        ctx.ui.notify('Usage: /roleplay request capture on|off (on persists sensitive request text)', 'warning');
      } else {
        pi.appendEntry(CAPTURE_ENTRY, { cast, enabled: args[1] === 'on' });
        ctx.ui.notify(
          args[1] === 'on'
            ? 'Sensitive request-content capture enabled for this scene/branch. Future bounded snapshots persist in the session; turning off does not delete earlier captures.'
            : 'Request-content persistence disabled. Metadata remains available; text for the latest live request is transient.',
          'info',
        );
      }
      return true;
    }
    const options: FormatRoleplayRequestOptions = {};
    let selectedTurn: number | undefined;
    let selectedRequest: number | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--json') options.json = true;
      else if (arg === '--snippets') options.snippets = true;
      else if (arg === '--content') options.content = true;
      else if (arg === '--section') {
        const section = args[++i];
        if (
          ![
            'system',
            'tools',
            'conversation',
            'recap',
            'timeline',
            'lore',
            'depth',
            'scene-fold',
            'memory',
            'other-reminder',
            'head',
            'tail',
          ].includes(section ?? '')
        ) {
          ctx.ui.notify('Unknown request section.', 'warning');
          return true;
        }
        options.section = section as FormatRoleplayRequestOptions['section'];
      } else if (arg === '--turn' || arg === '--request') {
        const value = Number(args[++i]);
        if (!Number.isSafeInteger(value) || value < 1) {
          ctx.ui.notify('Turn/request must be a positive integer.', 'warning');
          return true;
        }
        if (arg === '--turn') selectedTurn = value;
        else selectedRequest = value;
      } else {
        ctx.ui.notify(
          'Usage: /roleplay request|debug [--json|--snippets|--section <name> --content] [--turn N] [--request N]',
          'warning',
        );
        return true;
      }
    }
    if (options.content && !options.section) {
      ctx.ui.notify('--content requires --section. Use --snippets for bounded previews.', 'warning');
      return true;
    }
    const records = reportEntries(ctx, cast);
    const metadata = [...records]
      .reverse()
      .find(
        (item) =>
          (selectedTurn === undefined || item.turnOrdinal === selectedTurn) &&
          (selectedRequest === undefined || item.requestOrdinal === selectedRequest),
      );
    if (!metadata) {
      ctx.ui.notify(
        'No captured request on this scene branch. Send a normal turn first; earlier requests cannot be reconstructed exactly.',
        'info',
      );
      return true;
    }
    const same =
      latest?.cast === cast &&
      latest.metadata.turnOrdinal === metadata.turnOrdinal &&
      latest.metadata.requestOrdinal === metadata.requestOrdinal;
    const persisted = branch(ctx).findLast(
      (entry) =>
        entry.customType === ROLEPLAY_REQUEST_ENTRY &&
        isRecord(entry.data) &&
        entry.data.cast === cast &&
        isRecord(entry.data.content) &&
        isRecord(entry.data.metadata) &&
        entry.data.metadata.turnOrdinal === metadata.turnOrdinal &&
        entry.data.metadata.requestOrdinal === metadata.requestOrdinal,
    );
    // Persisted content is created only by explicit capture. Formatting bounds and escapes every section again.
    const content = same
      ? latest?.content
      : isRecord(persisted?.data) && isRecord(persisted.data.content)
        ? (persisted.data.content as unknown as RoleplayRequestContent)
        : undefined;
    if (verb === 'request') {
      ctx.ui.notify(formatRoleplayRequest(metadata, content, options), 'info');
      return true;
    }
    const resolved = source.config?.() ?? loadRoleplayConfigWithSources(ctx.cwd);
    const safeConfig = Object.fromEntries(
      Object.entries(resolved.config).filter(
        ([, value]) => typeof value === 'number' || typeof value === 'boolean' || value === null,
      ),
    );
    const sources = Object.fromEntries(
      Object.keys(safeConfig).map((key) => [key, resolved.sources[key as keyof typeof resolved.sources]]),
    );
    const snapshots = records
      .filter(
        (item, index) =>
          !records
            .slice(index + 1)
            .some((other) => other.turnOrdinal === item.turnOrdinal && other.requestOrdinal === item.requestOrdinal),
      )
      .slice(-10);
    const info = {
      version: 1,
      captureStage: 'sanitized-pi-projection',
      request: readRoleplayRequestMetadata(metadata),
      config: safeConfig,
      sources,
      policy: source.policy(ctx),
      recapAsync: source.recapAsync(ctx),
      recapModelResolved: !!source.recapModel(ctx),
      recapModel: roleplayModelIdentity(source.recapModel(ctx)),
      recapSchedulingReason:
        resolved.config.recapAsync !== null
          ? 'configured'
          : source.recapAsync(ctx)
            ? 'auto-distinct-provider'
            : 'auto-shared-provider',
      usageAssociation: ambiguousUsage
        ? 'unavailable-overlapping-captures'
        : metadata.reportedInputTokens !== undefined
          ? 'associated'
          : 'not-reported',
      window: source.window(),
      jobs: extractionJobMetadata(scanExtractionJobs(branch(ctx), cast, { restore: !awaitingUsage })),
      recentRequests: snapshots.map((item) => ({
        turn: item.turnOrdinal,
        request: item.requestOrdinal,
        chars: item.totals.requestChars,
        reportedInputTokens: item.reportedInputTokens ?? null,
      })),
      findings: [
        ...(source.policy(ctx).target > 0 &&
        metadata.totals.requestChars / (source.window()?.charsPerToken ?? 4) > source.policy(ctx).target
          ? ['soft-target-exceeded']
          : []),
        ...(metadata.totals.reminderChars > metadata.totals.conversationChars
          ? ['reminders-dominate-conversation']
          : []),
        ...(source.window()?.natural === source.window()?.recapCutoff ? ['no-uncovered-aged-history'] : []),
      ],
    };
    ctx.ui.notify(
      options.json
        ? JSON.stringify(info, null, 2)
        : [
            'Roleplay debug (metadata-only unless text explicitly requested)',
            JSON.stringify(info, null, 2),
            ...(options.snippets || options.content ? [formatRoleplayRequest(metadata, content, options)] : []),
          ].join('\n'),
      'info',
    );
    return true;
  };
  return { capture, handle, reset };
}
