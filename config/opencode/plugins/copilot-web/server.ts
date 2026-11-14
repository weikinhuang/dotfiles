/**
 * Web search and web fetch through GitHub Copilot's model-native `web_search`
 * tool for opencode, the Copilot slice of the pi `native-web` extension
 * (config/pi/extensions/native-web.ts). See ./README.md.
 *
 * - Native `websearch` backend (`copilot`): opencode's built-in `websearch`
 *   tool runs a Copilot Responses call and gets `{url, title, content}`
 *   results back. Made the default when no backend is selected.
 * - `copilot_web_fetch` tool (direct, not codemode): Copilot opens one URL
 *   server-side and answers a prompt from it.
 * - Provider gating (`context` hook): requests on a non-Copilot model drop
 *   `copilot_web_fetch`, and `websearch` while the Copilot backend serves it.
 *
 * Credentials come from opencode's GitHub Copilot integration. Logic lives in
 * lib/node/opencode/copilot-web.ts and lib/node/pi/copilot-web.ts.
 */

import { Plugin } from '@opencode/plugin';

import {
  COPILOT_WEBSEARCH_PROVIDER_ID,
  endpointFromCredential,
  FETCH_TOOL_DESCRIPTION,
  FETCH_TOOL_INPUT_SCHEMA,
  FETCH_TOOL_NAME,
  resolveCopilotWebConfig,
  toolsToHide,
} from '../../../../lib/node/opencode/copilot-web.ts';
import {
  buildFetchRequest,
  buildSearchRequest,
  type CopilotEndpoint,
  formatFetch,
  parseResponsesBody,
  postCopilotResponses,
  toSearchResults,
  validateFetchInput,
  validateSearchInput,
} from '../../../../lib/node/pi/copilot-web.ts';

export default Plugin.define({
  id: 'dotfiles.copilot-web',
  async setup(ctx) {
    const config = resolveCopilotWebConfig(ctx.options, process.env);
    if (!config.enabled) return;

    const endpoint = async (): Promise<CopilotEndpoint> => {
      const connection = await ctx.integration.connection.active(config.integrationID);
      const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
      const resolved = endpointFromCredential(credential);
      if ('error' in resolved) throw new Error(resolved.error);
      return resolved;
    };

    let ownsWebsearch = false;
    if (config.websearch) {
      await ctx.websearch.transform((editor) => {
        editor.add({
          id: COPILOT_WEBSEARCH_PROVIDER_ID,
          name: 'GitHub Copilot',
          execute: async (input, { signal }) => {
            const search = validateSearchInput(input);
            if (!search.ok) throw new Error(search.error);
            const body = buildSearchRequest(config.model, search.value, 'results');
            const response = await postCopilotResponses(await endpoint(), body, {
              signal,
              timeoutMs: config.timeoutMs,
            });
            return toSearchResults(parseResponsesBody(response));
          },
        });
        if (config.setDefault && editor.default.get() === undefined) {
          editor.default.set(COPILOT_WEBSEARCH_PROVIDER_ID);
        }
        ownsWebsearch = editor.default.get() === COPILOT_WEBSEARCH_PROVIDER_ID;
      });
    }

    await ctx.session.hook('context', (event) => {
      for (const name of toolsToHide(config, { providerID: event.model.providerID, ownsWebsearch })) {
        delete event.tools[name];
      }
    });

    if (config.fetchTool) {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: FETCH_TOOL_NAME,
          description: FETCH_TOOL_DESCRIPTION,
          input: FETCH_TOOL_INPUT_SCHEMA,
          options: { codemode: false },
          execute: async (input, context) => {
            const fetchInput = validateFetchInput(input);
            if (!fetchInput.ok) throw new Error(fetchInput.error);
            const response = await postCopilotResponses(
              await endpoint(),
              buildFetchRequest(config.model, fetchInput.value),
              { signal: context.signal, timeoutMs: config.timeoutMs },
            );
            return { content: formatFetch(parseResponsesBody(response), fetchInput.value.url) };
          },
        });
      });
    }
  },
});
