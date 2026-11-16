/**
 * Shell command gating with a System One decision model.
 *
 * The harness rules always run first (explicit allow / deny, pi's
 * hardcoded denylist and always-prompt list). This module only sees the
 * commands those rules would have prompted for, and can only turn a
 * prompt into an allow:
 *
 *   rules allow / deny  ->  decision model (allow or abstain)  ->  normal ask / default
 *
 * It abstains (and the caller prompts as if this did not exist) when the
 * config is missing or inactive, the command trips a deterministic guard
 * (hardcoded-deny or privilege-escalation patterns), the state is over
 * the size budget, the call fails or times out, the response is not
 * spec-valid, or any answer misses the configured thresholds.
 *
 * Commands are passed through the secret-redactor detectors before they
 * are sent or logged, so tokens on a command line stay local.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { checkAlwaysPrompt, checkHardcodedDeny } from '../pi/bash/match.ts';
import { redactText } from '../pi/secret-redactor/redact.ts';
import { SecretStore } from '../pi/secret-redactor/store.ts';
import {
  type DecisionModelStatus,
  describeDecisionModelStatus,
  loadDecisionModelConfig,
  type ShellEffect,
  type ShellPolicy,
} from './config.ts';
import { appendDecisionLog, type DecisionLogAnswerSummary, type DecisionRecord, type ResolutionRecord } from './log.ts';
import {
  callSystemOne,
  type ChoiceQuestion,
  type FetchLike,
  type NoulQuestion,
  type SystemOneAnswer,
  type SystemOneRequest,
} from './system-one.ts';

/** Bump when the questions or effect descriptions change. */
export const SHELL_QUESTIONS_VERSION = 'shell-v1';

const EFFECT_CRITERIA: Record<ShellEffect, string> = {
  read_only:
    'Only reads or inspects files, processes, git history, or system state, including read-only network queries. ' +
    'Nothing is created, modified, or deleted.',
  workspace_write:
    'Creates or modifies files only inside the working directory, such as builds, tests, formatters, installs into ' +
    'a local folder, or local git commits. Easy to undo or regenerate.',
  outside_write:
    'Writes outside the working directory: home directory dotfiles, system paths, global package installs, ' +
    'or system services and settings.',
  network_write:
    'Changes remote state or sends local data off the machine: git push, publishing, deploying, uploading, ' +
    'or API calls that create, update, or delete.',
  destructive:
    'Deletes or overwrites data, discards uncommitted work, rewrites git history, or kills processes in a way ' +
    'that is hard to undo.',
  opaque: 'Runs a script, binary, or downloaded code whose effect cannot be determined from the command text alone.',
};

const effectQuestion: ChoiceQuestion = {
  type: 'choice',
  instructions:
    'A coding agent wants to run `command` in a shell from `working_directory`. `unresolved_parts` are the ' +
    'sub-commands its permission rules did not cover. Considering the whole command, which option best ' +
    'describes the most impactful thing it does?',
  criteria: EFFECT_CRITERIA,
};

const secretsQuestion: NoulQuestion = {
  type: 'noul',
  instructions:
    'Does `command` read, print, copy, or transmit credentials such as API keys, tokens, passwords, private keys, ' +
    'or files like .env, ~/.ssh, ~/.aws, or other credential stores?',
};

const obfuscatedQuestion: NoulQuestion = {
  type: 'noul',
  instructions:
    'Does `command` hide what it really does, for example eval of constructed strings, base64 or hex decoded ' +
    'payloads, piping downloaded content into a shell or interpreter, or unusual quoting meant to evade review?',
};

export const SHELL_QUESTIONS = {
  effect: effectQuestion,
  secrets: secretsQuestion,
  obfuscated: obfuscatedQuestion,
} as const;

/** Risk flags (noul questions) that must each stay at or below `maxRisk`. */
const RISK_FLAGS = ['secrets', 'obfuscated'] as const;

/** Longest command kept in a log record. */
const LOG_COMMAND_CHARS = 2000;

/** Abstained decisions waiting for a resolution record. */
const MAX_PENDING = 500;

export interface ShellGateInput {
  /** The full command line as the agent submitted it. */
  command: string;
  /** Sub-commands the harness rules did not cover; defaults to `[command]`. */
  unresolved?: readonly string[];
  cwd: string;
  sessionId?: string;
}

export interface ShellGateResult {
  /** `off`: not configured, nothing logged. `abstain`: fall back to the normal prompt. */
  verdict: 'allow' | 'abstain' | 'off';
  /** Log id for {@link ShellDecider.settle}; set when a record was written. */
  id?: string;
  reason?: string;
}

/** `customType` of the session entry a harness writes when the model auto-allows. */
export const DECISION_MODEL_ENTRY_TYPE = 'decision-model';

/**
 * Session-log entry for an auto-allow, so the transcript shows why a command
 * ran without a prompt. `id` joins it to the full record in the decision log
 * (absent when logging is off). Carries no command text: the tool call in the
 * same session already has it.
 */
export interface DecisionModelSessionEntry {
  kind: 'shell';
  verdict: 'allow';
  reason: string;
  id?: string;
  /** Calling session when it differs from the one the entry is written to (a subagent child). */
  requesterSession?: string;
}

/** Entry for an `allow` result, else `undefined` (abstains already surface as the normal prompt). */
export function sessionEntryFor(
  result: ShellGateResult,
  requesterSession?: string,
): DecisionModelSessionEntry | undefined {
  if (result.verdict !== 'allow') return undefined;
  const entry: DecisionModelSessionEntry = { kind: 'shell', verdict: 'allow', reason: result.reason ?? '' };
  if (result.id) entry.id = result.id;
  if (requesterSession) entry.requesterSession = requesterSession;
  return entry;
}

/**
 * Apply `policy` to validated answers. Allows only when the allowed effect
 * classes together reach `threshold` and every risk flag stays at or below
 * `maxRisk`.
 */
export function decideShell(
  answers: Readonly<Record<string, SystemOneAnswer>>,
  policy: ShellPolicy,
): { verdict: 'allow' | 'abstain'; reason: string } {
  const effect = answers.effect;
  if (effect?.type !== 'choice') return { verdict: 'abstain', reason: 'no effect answer' };
  if (policy.allowEffects.length === 0) return { verdict: 'abstain', reason: 'no effects allowed by policy' };
  const mass = policy.allowEffects.reduce((sum, e) => sum + (effect.probabilities[e] ?? 0), 0);
  const summary = `effect ${effect.choice}, allowed p=${mass.toFixed(2)}`;
  if (mass < policy.threshold) return { verdict: 'abstain', reason: `${summary} < ${policy.threshold}` };
  for (const flag of RISK_FLAGS) {
    const answer = answers[flag];
    if (answer?.type !== 'noul') return { verdict: 'abstain', reason: `no ${flag} answer` };
    if (answer.noul > policy.maxRisk) {
      return { verdict: 'abstain', reason: `${flag} p=${answer.noul.toFixed(2)} > ${policy.maxRisk}` };
    }
  }
  return { verdict: 'allow', reason: summary };
}

/** Compact, log-friendly view of the answers. */
export function summarizeAnswers(
  answers: Readonly<Record<string, SystemOneAnswer>>,
): Record<string, DecisionLogAnswerSummary> {
  const out: Record<string, DecisionLogAnswerSummary> = {};
  for (const [id, a] of Object.entries(answers)) {
    if (a.type === 'noul') out[id] = { noul: a.noul };
    else if (a.type === 'choice') out[id] = { choice: a.choice, confidence: a.confidence, p: a.probabilities };
    else out[id] = { score: a.score, confidence: a.confidence, p: a.probabilities };
  }
  return out;
}

/** Deterministic guards that never auto-allow, whatever the model says. */
export function shellGuardReason(command: string): string | undefined {
  const deny = checkHardcodedDeny(command);
  if (deny) return `guard: ${deny}`;
  const prompt = checkAlwaysPrompt(command);
  if (prompt) return `guard: ${prompt}`;
  return undefined;
}

/** Build the request for one command. Callers pass already-redacted command strings. */
export function buildShellRequest(
  model: string,
  input: { command: string; unresolved: readonly string[]; cwd: string },
): SystemOneRequest {
  return {
    model,
    state: {
      command: input.command,
      unresolved_parts: [...input.unresolved],
      working_directory: input.cwd,
    },
    questions: { ...SHELL_QUESTIONS },
  };
}

type EnvBag = Readonly<Record<string, string | undefined>>;

export interface ShellDeciderOptions {
  /** `pi` / `opencode`; recorded in the log. */
  harness: string;
  configPath: string;
  defaultLogPath: string;
  env?: EnvBag;
  home?: string;
  fetch?: FetchLike;
  /** Monotonic ms clock for latency. */
  clock?: () => number;
  now?: () => Date;
  newId?: () => string;
  /** Called once per distinct config problem. */
  warn?: (message: string) => void;
}

export interface ShellDecider {
  evaluate(input: ShellGateInput): Promise<ShellGateResult>;
  /** Record what happened after an abstain. No-op for an unknown / undefined id. */
  settle(id: string | undefined, outcome: ResolutionRecord['outcome'], detail?: string): void;
  /** Current config state, for status commands. Re-reads the config. */
  status(): string;
}

export function createShellDecider(opts: ShellDeciderOptions): ShellDecider {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const now = opts.now ?? ((): Date => new Date());
  const newId = opts.newId ?? ((): string => randomUUID());
  const warned = new Set<string>();
  /** Abstained decision id -> log path, so the resolution lands in the same file. */
  const pending = new Map<string, string>();

  const warnOnce = (message: string): void => {
    if (warned.has(message)) return;
    warned.add(message);
    opts.warn?.(message);
  };

  const load = (): DecisionModelStatus => {
    const { status, warnings } = loadDecisionModelConfig({
      configPath: opts.configPath,
      defaultLogPath: opts.defaultLogPath,
      env,
      home,
    });
    for (const w of warnings) warnOnce(`${opts.configPath}: ${w}`);
    if (status.state === 'invalid') warnOnce(`${opts.configPath}: ${status.error} (decision model off)`);
    return status;
  };

  const redact = (text: string, store: SecretStore): string => redactText(text, store).text;

  return {
    async evaluate(input) {
      const status = load();
      if (status.state !== 'ready' || !status.config.shell.enabled) return { verdict: 'off' };
      const { config } = status;

      const store = new SecretStore();
      const command = redact(input.command, store);
      const unresolved = (input.unresolved ?? [input.command]).map((s) => redact(s, store));
      const id = newId();
      const base: Omit<DecisionRecord, 'verdict' | 'reason'> = {
        type: 'decision',
        ts: now().toISOString(),
        id,
        harness: opts.harness,
        kind: 'shell',
        questions: SHELL_QUESTIONS_VERSION,
        session: input.sessionId,
        cwd: input.cwd,
        command: command.slice(0, LOG_COMMAND_CHARS),
        unresolved,
        provider: config.providerLabel,
      };

      const finish = (
        verdict: 'allow' | 'abstain',
        reason: string,
        extra: Partial<DecisionRecord> = {},
      ): ShellGateResult => {
        if (config.logPath) {
          appendDecisionLog(config.logPath, { ...base, ...extra, verdict, reason });
          if (verdict === 'abstain') {
            pending.set(id, config.logPath);
            if (pending.size > MAX_PENDING) {
              const oldest = pending.keys().next().value;
              if (oldest !== undefined) pending.delete(oldest);
            }
          }
        }
        return { verdict, id: config.logPath ? id : undefined, reason };
      };

      // Guards run on the original text; redaction must not hide a pattern.
      const guard = shellGuardReason(input.command);
      if (guard) return finish('abstain', guard);

      const request = buildShellRequest(config.model, { command, unresolved, cwd: input.cwd });
      const stateChars = JSON.stringify(request.state).length;
      if (stateChars > config.maxStateChars) {
        return finish('abstain', `state ${stateChars} chars > maxStateChars ${config.maxStateChars}`);
      }

      const result = await callSystemOne(config.endpoint, request, opts.fetch, opts.clock);
      if (!result.ok) {
        return finish('abstain', `call failed: ${result.kind}`, {
          model: config.model,
          latencyMs: result.latencyMs,
          error: { kind: result.kind, status: result.status, message: result.error },
        });
      }
      const { response } = result;
      const decision = decideShell(response.answers, config.shell);
      return finish(decision.verdict, decision.reason, {
        model: response.model,
        latencyMs: result.latencyMs,
        answers: summarizeAnswers(response.answers),
        usage: response.usage,
      });
    },

    settle(id, outcome, detail) {
      if (id === undefined) return;
      const path = pending.get(id);
      if (!path) return;
      pending.delete(id);
      const record: ResolutionRecord = { type: 'resolution', ts: now().toISOString(), id, outcome };
      if (detail) record.detail = detail;
      appendDecisionLog(path, record);
    },

    status() {
      return describeDecisionModelStatus(load(), opts.configPath);
    },
  };
}
