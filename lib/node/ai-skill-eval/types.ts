// Shared types for ai-skill-eval.
// SPDX-License-Identifier: MIT

export interface SkillEntry {
  name: string;
  skillMd: string;
  evalsJson: string | null;
}

export interface EvalSpec {
  id: string;
  should_trigger: boolean;
  prompt: string;
  expectations: string[];
}

export interface EvalsFile {
  skill_name?: string;
  evals: EvalSpec[];
}

export interface ParsedReply {
  trigger: string;
  reason: string;
  next_step: string;
}

export interface ExpectationResult {
  text: string;
  passed: boolean;
  note: string;
}

export interface GradeRecord {
  skill: string;
  eval_id: string;
  should_trigger: boolean;
  got_trigger: string;
  trigger_pass: boolean;
  reason: string;
  next_step: string;
  expectations: ExpectationResult[];
  expectation_pass: number;
  expectation_total: number;
  grader: 'deterministic' | 'critic';
  flaws?: string[];
}

export type DriverKind = 'pi' | 'claude' | 'codex';
