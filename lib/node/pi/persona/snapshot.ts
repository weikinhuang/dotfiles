/**
 * Session snapshot/restore for mode activation.
 *
 * Activating a mode mutates the live pi session (model, thinking
 * level, active tool list, system-prompt addendum). When the user
 * exits the mode we restore the session to where it was before. This
 * module captures and replays that state through a structural API so
 * it can be tested without pulling in `@earendil-works/*`.
 *
 * Pure module - no pi imports.
 */

import { type PersonaThinkingLevel } from './parse.ts';

export { type PersonaThinkingLevel } from './parse.ts';

export interface SnapshotState {
  model?: string;
  thinkingLevel?: PersonaThinkingLevel;
  activeTools: string[];
  systemPromptAddendum?: string;
}

export interface SnapshotApi {
  getModel(): string | undefined;
  setModel(spec: string | undefined): void;
  getThinkingLevel(): PersonaThinkingLevel | undefined;
  setThinkingLevel(level: PersonaThinkingLevel | undefined): void;
  getActiveTools(): string[];
  setActiveTools(tools: string[]): void;
}

/**
 * Read the current session state through `api` and return a frozen
 * `SnapshotState`. The `activeTools` array is copied and frozen so the
 * caller can't accidentally mutate the snapshot through aliasing.
 */
export function snapshotSession(api: SnapshotApi, currentAddendum?: string): SnapshotState {
  const tools = Object.freeze([...api.getActiveTools()]) as string[];
  const state: SnapshotState = {
    model: api.getModel(),
    thinkingLevel: api.getThinkingLevel(),
    activeTools: tools,
    systemPromptAddendum: currentAddendum,
  };
  return Object.freeze(state);
}

/**
 * Push the snapshot back through `api`. Order matters: model first,
 * thinking level next, tools last - if any setter throws, the
 * already-applied scalars stay correct and the caller still sees a
 * consistent partial restore.
 */
export function restoreSession(api: SnapshotApi, snap: SnapshotState): void {
  api.setModel(snap.model);
  api.setThinkingLevel(snap.thinkingLevel);
  api.setActiveTools([...snap.activeTools]);
}
