/**
 * Shared `createAgentSession` adapter for extensions that spawn one-shot
 * child agents through `runOneShotAgent`.
 *
 * `lib/node/pi/subagent/spawn.ts` stays pi-free by typing its session
 * factory structurally (`ModelRegistryLike`, etc.), so every extension that
 * feeds it pi's concrete `createAgentSession` wrapped that call in the exact
 * same `adaptCreateAgentSession<Model<any>, SessionManager, ModelRegistry,
 * ResourceLoader>(createAgentSession)` one-liner. This centralises that
 * adapter so the five call sites (deep-research, roleplay, iteration-loop,
 * waveform-indicator, context-trim) import `piCreateAgentSession` instead of
 * re-declaring it.
 *
 * Lives under `ext/` because it imports the pi runtime.
 */

import { type Model } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  type ModelRegistry,
  type ResourceLoader,
  type SessionManager,
} from '@earendil-works/pi-coding-agent';

import { adaptCreateAgentSession } from '../subagent/spawn.ts';

/**
 * Pi's concrete `createAgentSession` adapted to the structural session
 * factory `runOneShotAgent` expects. Pass as
 * `deps.createAgentSession`.
 */
export const piCreateAgentSession = adaptCreateAgentSession<Model<any>, SessionManager, ModelRegistry, ResourceLoader>(
  createAgentSession,
);
