#!/usr/bin/env node
// ai-skill-eval -- harness-agnostic SKILL.md validation harness.
// SPDX-License-Identifier: MIT
//
// Discovers SKILL.md files under a project, finds sibling evals/evals.json
// files, drives a model (pi / claude / custom command) against each eval,
// grades the output, and emits a markdown report.
//
// See config/agents/skills/ai-skill-eval/SKILL.md for usage guidance.

import { main } from './cli.ts';

main(process.argv.slice(2));
