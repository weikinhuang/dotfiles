// Harness auto-detection from a session-log path + its first JSONL lines.
// Pure: the CLI reads the file head and the file extension and hands them
// here. opencode uses SQLite; pi / claude / codex / copilot are JSONL and
// are told apart by their record signatures (copilot also by its
// session-state/<uuid>/events.jsonl path).
// SPDX-License-Identifier: MIT

import { type Harness } from './turn-model.ts';

// Copilot CLI event log: `{ type: 'session.start', data: { copilotVersion, producer, ... } }`.
function isCopilotEvent(obj: Record<string, unknown>): boolean {
  if (typeof obj.type !== 'string' || !obj.type.startsWith('session.')) return false;
  const data = obj.data as Record<string, unknown> | undefined;
  return !!data && typeof data === 'object' && (data.copilotVersion !== undefined || data.producer !== undefined);
}

function classifyLine(obj: Record<string, unknown>): Harness | undefined {
  if (isCopilotEvent(obj)) return 'copilot';

  // codex wraps everything in a `payload` and uses these top-level types.
  if (obj.payload && typeof obj.payload === 'object') return 'codex';
  if (obj.type === 'session_meta' || obj.type === 'turn_context' || obj.type === 'event_msg') return 'codex';

  // pi: session header carries cwd+id; model_change carries provider+modelId;
  // assistant usage uses camelCase cacheRead/cacheWrite.
  if (obj.type === 'session' && typeof obj.cwd === 'string') return 'pi';
  if (obj.type === 'model_change' && (obj.provider !== undefined || obj.modelId !== undefined)) return 'pi';
  const msg = obj.message as Record<string, unknown> | undefined;
  if (msg && typeof msg === 'object') {
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage && (usage.cacheRead !== undefined || usage.cacheWrite !== undefined || usage.totalTokens !== undefined)) {
      return 'pi';
    }
    if (usage && (usage.input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined)) {
      return 'claude';
    }
  }

  // claude entries carry these top-level Claude Code fields.
  if (obj.sessionId !== undefined || obj.requestId !== undefined || obj.gitBranch !== undefined) return 'claude';
  if (obj.type === 'summary' && obj.leafUuid !== undefined) return 'claude';

  return undefined;
}

// Detects the harness from the file extension and the first few JSONL lines.
// `lines` should be the leading non-empty lines of the file (the caller need
// only pass ~10). Returns undefined when nothing matches confidently.
export function detectHarness(filePath: string, lines: string[]): Harness | undefined {
  const lower = filePath.toLowerCase().replaceAll('\\', '/');
  if (/\/session-state\/[^/]+\/events\.jsonl$/.test(lower)) return 'copilot';
  if (lower.endsWith('.db') || lower.endsWith('.sqlite') || lower.endsWith('opencode.db')) return 'opencode';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj !== 'object' || obj === null) continue;
    const harness = classifyLine(obj);
    if (harness) return harness;
  }

  return undefined;
}
