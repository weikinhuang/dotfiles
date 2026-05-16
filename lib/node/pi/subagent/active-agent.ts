/**
 * Cross-extension singleton tracking the agent currently running as a
 * spawned subagent in this process. Sibling of
 * `lib/node/pi/persona/active.ts`.
 *
 * The `subagent` extension publishes here when a child run starts and
 * clears when it ends. Other extensions (notably `bash-permissions`,
 * `protected-paths`, and the `before_provider_request` handler in
 * `persona`) can read it to compose their own gates with the running
 * agent's declared `bashAllow` / `bashDeny` / `writeRoots` /
 * `requestOptions`.
 *
 * Anchored on `globalThis` behind a `Symbol.for()` key for the same
 * reason as `lib/node/pi/persona/active.ts` and `bash-gate.ts`: pi's
 * extension loader creates a fresh jiti instance per extension with
 * `moduleCache: false`, so a plain module-level variable would NOT
 * share state across extensions.
 *
 * NOTE: The principal enforcement path for an agent's
 * `bashAllow` / `writeRoots` / `requestOptions` is the inline
 * `agent-gate` extension factory installed inside the child session
 * itself (see `config/pi/extensions/subagent.ts`). The singleton here
 * is supplementary surface - useful for parent-side observers (e.g.
 * statusline integrations) and for symmetry with `persona/active.ts`.
 *
 * Concurrency: pi can fan out multiple subagents in parallel; the
 * single slot here represents whichever agent was most recently set,
 * not a stack. That is acceptable for the supplementary observer use
 * case but means consumers must NOT use this singleton for
 * enforcement - the inline factory's per-child closure is the
 * authoritative gate.
 */

import { type RequestOptionsConfig } from '../request-options.ts';

export interface ActiveAgentSnapshot {
  readonly name: string;
  readonly resolvedWriteRoots: readonly string[];
  readonly bashAllow: readonly string[];
  readonly bashDeny: readonly string[];
  readonly requestOptions?: RequestOptionsConfig;
}

interface ActiveAgentSlot {
  active?: ActiveAgentSnapshot;
}

const SLOT_KEY = Symbol.for('@dotfiles/pi/subagent/active-agent');

function getSlot(): ActiveAgentSlot {
  const g = globalThis as { [SLOT_KEY]?: ActiveAgentSlot };
  let slot = g[SLOT_KEY];
  if (!slot) {
    slot = {};
    g[SLOT_KEY] = slot;
  }
  return slot;
}

export interface ActiveAgentInput {
  name: string;
  resolvedWriteRoots: readonly string[];
  bashAllow?: readonly string[];
  bashDeny?: readonly string[];
  requestOptions?: RequestOptionsConfig;
}

export function setActiveAgent(snapshot: ActiveAgentInput | undefined): void {
  const slot = getSlot();
  if (!snapshot) {
    slot.active = undefined;
    return;
  }
  slot.active = {
    name: snapshot.name,
    resolvedWriteRoots: Object.freeze([...snapshot.resolvedWriteRoots]),
    bashAllow: Object.freeze([...(snapshot.bashAllow ?? [])]),
    bashDeny: Object.freeze([...(snapshot.bashDeny ?? [])]),
    requestOptions: snapshot.requestOptions,
  };
}

export function getActiveAgent(): ActiveAgentSnapshot | undefined {
  return getSlot().active;
}

export function clearActiveAgent(): void {
  getSlot().active = undefined;
}
