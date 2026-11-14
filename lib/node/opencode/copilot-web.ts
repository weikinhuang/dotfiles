/**
 * opencode side of `copilot-web`: option resolution, credential-to-endpoint
 * mapping, and the `copilot_web_fetch` tool contract. Request building and
 * parsing are shared with pi in `lib/node/pi/copilot-web.ts`.
 *
 * Pure module - no opencode imports.
 */

import {
  COPILOT_PROVIDER_ID,
  type CopilotEndpoint,
  copilotBaseUrlFromMetadata,
  copilotBaseUrlFromToken,
  DEFAULT_COPILOT_WEB_MODEL,
  DEFAULT_TIMEOUT_MS,
} from '../pi/copilot-web.ts';
import { isRecord } from '../pi/shared.ts';
import { createOptionReader, type EnvBag, type PluginOptionBag } from './plugin-options.ts';

export const OPENCODE_COPILOT_WEB_ENV_PREFIX = 'OPENCODE_COPILOT_WEB_';

/** Id of the websearch backend this plugin registers. */
export const COPILOT_WEBSEARCH_PROVIDER_ID = 'copilot';

export interface OpencodeCopilotWebConfig {
  enabled: boolean;
  /** Register the native `websearch` backend. */
  websearch: boolean;
  /** Make it the default backend when none is selected. */
  setDefault: boolean;
  /** Register the `copilot_web_fetch` tool. */
  fetchTool: boolean;
  model: string;
  timeoutMs: number;
  integrationID: string;
  /** Keep the tools on for every provider instead of only `providerID` models. */
  always: boolean;
  /** Provider whose models get the Copilot web tools. */
  providerID: string;
}

export function resolveCopilotWebConfig(options: PluginOptionBag | undefined, env: EnvBag): OpencodeCopilotWebConfig {
  const read = createOptionReader(options, env, OPENCODE_COPILOT_WEB_ENV_PREFIX);
  const timeout = read.number('timeoutMs', DEFAULT_TIMEOUT_MS);
  return {
    enabled: read.bool('enabled', true),
    websearch: read.bool('websearch', true),
    setDefault: read.bool('setDefault', true),
    fetchTool: read.bool('fetchTool', true),
    model: read.string('model', DEFAULT_COPILOT_WEB_MODEL),
    timeoutMs: timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    integrationID: read.string('integrationID', COPILOT_PROVIDER_ID),
    always: read.bool('always', false),
    providerID: read.string('providerID', COPILOT_PROVIDER_ID),
  };
}

function str(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * Map a resolved opencode credential (`Credential.Value`) to a Copilot
 * endpoint. opencode's Copilot OAuth stores the GitHub OAuth token (`gho_`) in
 * `refresh` (and `access`) and the API host in `metadata.apiEndpoint`; the
 * token is used as the bearer directly. A Copilot session token
 * (`...;proxy-ep=...`) names its own host instead.
 */
export function endpointFromCredential(credential: unknown): CopilotEndpoint | { error: string } {
  if (!isRecord(credential)) return { error: 'GitHub Copilot is not connected. Run `opencode auth login`.' };
  if (credential.type === 'key') {
    const token = str(credential.key);
    if (!token) return { error: 'The GitHub Copilot key credential is empty.' };
    return { token, baseUrl: copilotBaseUrlFromToken(token) ?? copilotBaseUrlFromMetadata(undefined) };
  }
  if (credential.type !== 'oauth') {
    return { error: `Unsupported GitHub Copilot credential type: ${String(credential.type)}` };
  }
  const token = str(credential.refresh) ?? str(credential.access);
  if (!token) return { error: 'The GitHub Copilot OAuth credential has no token. Sign in again.' };
  const metadata = isRecord(credential.metadata) ? credential.metadata : undefined;
  return { token, baseUrl: copilotBaseUrlFromToken(token) ?? copilotBaseUrlFromMetadata(metadata) };
}

export const FETCH_TOOL_NAME = 'copilot_web_fetch';

export const FETCH_TOOL_DESCRIPTION =
  "Have GitHub Copilot open one URL server-side and answer `prompt` from that page only. Returns the model's answer (not raw HTML), with a note when Copilot could not open the exact URL. Prefer the built-in `webfetch` when you need the page's exact text; use this when `webfetch` is blocked or fails, the page needs JavaScript, or you only need an answer from a large page without loading all of it. Not for localhost, private, or authenticated URLs. Each call uses one Copilot request.";

export const FETCH_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Absolute http(s) URL to open.' },
    prompt: {
      type: 'string',
      description:
        'What to extract or answer from the page. Be specific; omit to get the main content back as faithfully as possible.',
    },
  },
  required: ['url'],
  additionalProperties: false,
} as const;

export const WEBSEARCH_TOOL_NAME = 'websearch';

export interface GateInput {
  /** Provider of the model serving this request. */
  readonly providerID: string;
  /** The `copilot` backend is the selected websearch backend. */
  readonly ownsWebsearch: boolean;
}

/**
 * Tool names to drop from a request's tool map: on a non-Copilot model, the
 * fetch tool and (when the Copilot backend serves it) the native `websearch`
 * tool, so other providers fall back to their own web tools.
 */
export function toolsToHide(
  config: Pick<OpencodeCopilotWebConfig, 'always' | 'providerID'>,
  input: GateInput,
): string[] {
  if (config.always || input.providerID === config.providerID) return [];
  return input.ownsWebsearch ? [FETCH_TOOL_NAME, WEBSEARCH_TOOL_NAME] : [FETCH_TOOL_NAME];
}
