/**
 * Inheritance merger for mode files that reference a `config/pi/agents/`
 * agent. Per `plans/pi-mode-extension.md` decision D5/D9: a mode with an
 * `agent:` reference inherits the agent's `tools` / `model` /
 * `thinkingLevel` / body when the mode itself doesn't override them.
 *
 * Pure module — no pi imports. The agent record is passed in by the
 * caller (which resolves the layered agent registry separately) so this
 * module stays trivially testable.
 */

import { type ModeThinkingLevel, type ParsedMode } from './parse.ts';

/**
 * Strict subset of the agent record `subagent-loader.ts` produces. Mode
 * inheritance only cares about these four fields.
 */
export interface AgentRecord {
  name: string;
  tools: string[];
  model?: string;
  thinkingLevel?: ModeThinkingLevel;
  body: string;
}

/**
 * Return a new `ParsedMode` with agent fields layered in where the mode
 * itself didn't specify them. `writeRoots`, `bashAllow`, `bashDeny`,
 * and `appendSystemPrompt` are passed through unchanged — they live
 * only on modes (no agent counterpart).
 *
 * Returns the input mode unchanged when there's no `agent:` ref or no
 * agent record was provided. The result is always a fresh object so
 * callers can mutate it without aliasing the caller's input.
 */
export function mergeAgentInheritance(mode: ParsedMode, agent: AgentRecord | undefined): ParsedMode {
  if (mode.agent === undefined || agent === undefined) {
    return mode;
  }

  const tools = mode.tools ?? [...agent.tools];
  const model = mode.model ?? agent.model;
  const thinkingLevel = mode.thinkingLevel ?? agent.thinkingLevel;

  // Body precedence: mode wins if non-empty, else inherit. Standalone
  // modes never reach this branch (no `agent:` ref).
  const modeBodyTrimmed = mode.body.trim();
  const body = modeBodyTrimmed.length > 0 ? mode.body : agent.body;

  return {
    ...mode,
    tools,
    model,
    thinkingLevel,
    body,
  };
}
