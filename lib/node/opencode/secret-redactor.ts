/**
 * Pure helpers for the opencode `secret-redactor` plugin
 * (`config/opencode/plugins/secret-redactor/`): config resolution, the
 * redaction engine (one secret store per plugin instance, reveals scoped
 * per root session), tool-input rehydration, and the permission plumbing
 * for the `secret_unredact` approval.
 *
 * Detection, placeholders, and handles are shared with the pi extension
 * via `lib/node/pi/secret-redactor/`; the request walk lives in
 * `secret-redactor-request.ts`. The plugin shell owns the side effects
 * (hooks, permission prompts, session lookups, trace files).
 *
 * Pure module - no opencode imports.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { type ConfigWarning } from '../pi/jsonc.ts';
import {
  applyRedactorConfigObject,
  createDefaultRedactorConfig,
  loadRedactorConfigFiles,
} from '../pi/secret-redactor/config.ts';
import { createLruMemo, type LruMemo } from '../pi/secret-redactor/memo.ts';
import { type RedactHit, type RedactorConfig, redactText, rehydrateText } from '../pi/secret-redactor/redact.ts';
import { type SecretEntry, SecretStore } from '../pi/secret-redactor/store.ts';
import { defaultAskRuleIndex, type PermissionRuleLike } from './permission-rules.ts';
import { createOptionReader, type EnvBag, type PluginOptionBag } from './plugin-options.ts';
import { collectStrings, mapStrings, type RedactableRequest, redactModelRequest } from './secret-redactor-request.ts';

/** Env override prefix: option `keywordMinLength` -> `OPENCODE_SECRET_REDACTOR_KEYWORD_MIN_LENGTH`. */
export const SECRET_REDACTOR_ENV_PREFIX = 'OPENCODE_SECRET_REDACTOR_';
/** Config file name looked up in the opencode config dir and each project `.opencode/` dir. */
export const SECRET_REDACTOR_CONFIG_FILE = 'secret-redactor.json';
/** Permission action asserted before a placeholder is rehydrated into a tool call. */
export const UNREDACT_ACTION = 'secret_unredact';
/** Session hook kinds that build a model request; each must be registered separately. */
export const REQUEST_HOOK_KINDS = ['context', 'compaction', 'generate', 'title'] as const;

/** Global memo size (raw text -> redacted text); history re-scans for free. */
const MEMO_CAP = 2000;
/** Per-scope memo size, only allocated once a scope reveals a secret. */
const SCOPE_MEMO_CAP = 500;

/** Resolved plugin configuration. */
export interface SecretRedactorPluginConfig {
  /** Master switch; `false` makes the plugin a no-op. */
  enabled: boolean;
  /** Gate placeholder rehydration into tool calls (`false` leaves placeholders literal). */
  rehydrate: boolean;
  /** Append one line per redaction / rehydration decision (never a value). */
  trace?: string;
  /** Debug: append each projected (redacted) request as one JSON line. */
  dump?: string;
  redactor: RedactorConfig;
  /** Config files consulted, in stacking order. */
  files: string[];
  warnings: ConfigWarning[];
}

/** `$OPENCODE_CONFIG_DIR`, else `${XDG_CONFIG_HOME:-~/.config}/opencode` (opencode's own rule). */
export function opencodeConfigDir(env: EnvBag, home: string = homedir()): string {
  const override = env.OPENCODE_CONFIG_DIR?.trim();
  if (override) return override;
  const xdg = env.XDG_CONFIG_HOME?.trim() ?? '';
  return join(xdg === '' ? join(home, '.config') : xdg, 'opencode');
}

/** Global file first, then `<dir>/.opencode/secret-redactor.json` per distinct project dir (later wins). */
export function secretRedactorConfigFiles(configDir: string, projectDirs: readonly string[]): string[] {
  return [
    join(configDir, SECRET_REDACTOR_CONFIG_FILE),
    ...[...new Set(projectDirs)].map((dir) => join(dir, '.opencode', SECRET_REDACTOR_CONFIG_FILE)),
  ];
}

function parsePositiveInt(raw: unknown): number | undefined {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

/**
 * Resolve the plugin config. Detection settings stack: defaults, then
 * plugin options (same shape as the JSON file), then each file in
 * `files`; `rules` / `allowlist` accumulate across layers. Scalar knobs
 * read `OPENCODE_SECRET_REDACTOR_*` env overrides, which win over all.
 */
export function resolveSecretRedactorConfig(
  options: PluginOptionBag | undefined,
  env: EnvBag,
  files: readonly string[],
): SecretRedactorPluginConfig {
  const read = createOptionReader(options, env, SECRET_REDACTOR_ENV_PREFIX);
  const warnings: ConfigWarning[] = [];
  const redactor = createDefaultRedactorConfig();
  if (options) applyRedactorConfigObject(redactor, options, 'plugin options', warnings);
  loadRedactorConfigFiles(files, redactor, warnings);
  const envMin = parsePositiveInt(env[read.envName('keywordMinLength')]);
  if (envMin !== undefined) redactor.keywordMinLength = envMin;
  return {
    enabled: read.bool('enabled', true),
    rehydrate: read.bool('rehydrate', true),
    trace: read.optionalString('trace'),
    dump: read.optionalString('dump'),
    redactor,
    files: [...files],
    warnings,
  };
}

/** `<label>#<handle>`: the permission resource and save pattern for one secret. */
export function secretRef(entry: Pick<SecretEntry, 'label' | 'handle'>): string {
  return `${entry.label}#${entry.handle}`;
}

/** Shown to the model when a rehydration is denied (permission `message`). */
export const UNREDACT_DENIED_MESSAGE =
  'The redacted secret was not approved for this tool call. Reference the value from the shell environment ' +
  '(e.g. $VAR or a sourced file) instead of pasting the placeholder, or ask the user to reveal it with ' +
  '/secret-redactor.';

/** Arguments for `ctx.permission.assert` (minus session / agent / source). */
export interface UnredactPermission {
  action: string;
  resources: string[];
  save: string[];
  metadata: { tool: string; secrets: string[] };
}

/** One batched approval for every pending secret of a tool call. */
export function buildUnredactPermission(entries: readonly SecretEntry[], tool: string): UnredactPermission {
  const resources = entries.map(secretRef);
  return { action: UNREDACT_ACTION, resources, save: [...resources], metadata: { tool, secrets: [...resources] } };
}

/**
 * Where to insert `{ action: secret_unredact, resource: *, effect: ask }` into an agent's rules, or `undefined` when
 * it is already there. See `defaultAskRuleIndex`.
 */
export function unredactAskRuleIndex(rules: readonly PermissionRuleLike[]): number | undefined {
  return defaultAskRuleIndex(rules, UNREDACT_ACTION);
}

/** Per-secret state shown by the status view. */
export type SecretState = 'redacted' | 'revealed';

export interface SecretStatus {
  handle: string;
  label: string;
  state: SecretState;
}

/** Result of one request projection. */
export interface RequestRedaction {
  /** System / message entries rewritten. */
  changed: number;
  /** Distinct secrets redacted in this request, in first-seen order. */
  hits: RedactHit[];
}

/** Secrets a tool input references, split by whether they need approval. */
export interface ReferencedSecrets {
  pending: SecretEntry[];
  revealed: SecretEntry[];
}

interface Redacted {
  text: string;
  hits: readonly RedactHit[];
}

interface Scope {
  /** Handles redacted (or revealed) in this scope; rehydration only resolves these. */
  seen: Set<string>;
  revealed: Set<string>;
  /** Allocated on the first reveal; scopes without reveals share the global memo. */
  memo?: LruMemo<Redacted>;
}

/**
 * Redaction state for one plugin instance. The store maps each secret
 * value to a deterministic handle (sha256 prefix) shared by every session,
 * so placeholders are stable across sessions and restarts. A scope (the
 * root session id of a session tree) tracks which handles it has seen and
 * which the user revealed to the model.
 */
export class SecretRedactorEngine {
  readonly store = new SecretStore();
  private readonly memo: LruMemo<Redacted>;
  private readonly scopes = new Map<string, Scope>();

  constructor(private readonly config: RedactorConfig) {
    this.memo = createLruMemo(MEMO_CAP, (text) => redactText(text, this.store, config, { isRevealed: () => false }));
  }

  private scope(scopeID: string): Scope {
    let scope = this.scopes.get(scopeID);
    if (!scope) {
      scope = { seen: new Set(), revealed: new Set() };
      this.scopes.set(scopeID, scope);
    }
    return scope;
  }

  /** Redact one string for `scopeID`, recording hits into `sink` when given. */
  redactString(scopeID: string, text: string, sink?: Map<string, RedactHit>): string {
    if (!text) return text;
    const scope = this.scope(scopeID);
    const result = (scope.memo ?? this.memo).get(text);
    for (const hit of result.hits) {
      scope.seen.add(hit.handle);
      if (sink && !sink.has(hit.handle)) sink.set(hit.handle, hit);
    }
    return result.text;
  }

  /** Redact a session-hook request in place (see `redactModelRequest`). */
  redactRequest(scopeID: string, request: RedactableRequest): RequestRedaction {
    const sink = new Map<string, RedactHit>();
    const changed = redactModelRequest(request, (text) => this.redactString(scopeID, text, sink));
    return { changed, hits: [...sink.values()] };
  }

  /** Known secrets of `scopeID` referenced (placeholder or bare `#handle`) anywhere in `input`. */
  referencedSecrets(scopeID: string, input: unknown): ReferencedSecrets {
    const scope = this.scopes.get(scopeID);
    const out: ReferencedSecrets = { pending: [], revealed: [] };
    if (!scope) return out;
    const handles = new Set<string>();
    for (const text of collectStrings(input)) for (const h of this.store.referencedHandles(text)) handles.add(h);
    for (const handle of handles) {
      const entry = this.store.lookup(handle);
      if (!entry || !(scope.seen.has(handle) || scope.revealed.has(handle))) continue;
      (scope.revealed.has(handle) ? out.revealed : out.pending).push(entry);
    }
    return out;
  }

  /** Swap approved handles in `input` for their real values. Returns a new value only when something changed. */
  rehydrate(input: unknown, approved: ReadonlySet<string>): { input: unknown; used: string[] } {
    const used = new Set<string>();
    const next = mapStrings(input, (text) => {
      const result = rehydrateText(text, (h) => (approved.has(h) ? this.store.lookup(h)?.value : undefined));
      for (const h of result.used) used.add(h);
      return result.used.length > 0 ? result.text : text;
    });
    return { input: next, used: [...used] };
  }

  /** Reveal a handle to the model for `scopeID` (future requests keep it as plaintext). */
  reveal(scopeID: string, handle: string): SecretEntry | undefined {
    const entry = this.store.lookup(handle.trim().replace(/^#/, ''));
    if (!entry) return undefined;
    const scope = this.scope(scopeID);
    if (!scope.revealed.has(entry.handle)) {
      scope.revealed.add(entry.handle);
      const { revealed } = scope;
      scope.memo = createLruMemo(SCOPE_MEMO_CAP, (text) =>
        redactText(text, this.store, this.config, { isRevealed: (h) => revealed.has(h) }),
      );
    }
    return entry;
  }

  /** Secrets this scope has seen, in first-seen order. */
  status(scopeID: string): SecretStatus[] {
    const scope = this.scopes.get(scopeID);
    if (!scope) return [];
    const handles = new Set([...scope.seen, ...scope.revealed]);
    return [...handles].flatMap((handle) => {
      const entry = this.store.lookup(handle);
      if (!entry) return [];
      return [{ handle, label: entry.label, state: scope.revealed.has(handle) ? 'revealed' : 'redacted' } as const];
    });
  }

  /** Drop a scope's reveals and seen set (the shared store keeps its handles). */
  forget(scopeID: string): void {
    this.scopes.delete(scopeID);
  }
}

/** Narrow an RPC input (`{ sessionID, handle? }`) from the untyped JSON Schema payload. */
export function parseSecretRedactorRpcInput(input: unknown): { sessionID: string; handle?: string } | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const { sessionID, handle } = input as Record<string, unknown>;
  if (typeof sessionID !== 'string' || !sessionID) return undefined;
  if (handle === undefined) return { sessionID };
  if (typeof handle !== 'string') return undefined;
  const trimmed = handle.trim().replace(/^#/, '');
  return trimmed ? { sessionID, handle: trimmed } : undefined;
}

/** One-line description of the active detection config for the status view. */
export function describeRedactorConfig(config: SecretRedactorPluginConfig): string {
  const { layers, customRules, allowlist, keywordMinLength } = config.redactor;
  return (
    `layers prefixed=${layers.prefixed} keyword=${layers.keyword}, ${customRules.length} custom rule(s), ` +
    `${allowlist.length} allowlist pattern(s), keywordMinLength=${keywordMinLength}, ` +
    `rehydrate=${config.rehydrate ? 'ask' : 'off'}`
  );
}

/** Narrow the `status` RPC output on the TUI side. */
export function parseSecretRedactorStatus(raw: unknown): { summary: string; secrets: SecretStatus[] } {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const secrets = Array.isArray(obj.secrets) ? (obj.secrets as unknown[]) : [];
  return {
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    secrets: secrets.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];
      const { handle, label, state } = item as Record<string, unknown>;
      if (typeof handle !== 'string' || typeof label !== 'string') return [];
      return [{ handle, label, state: state === 'revealed' ? 'revealed' : 'redacted' } as const];
    }),
  };
}
