/**
 * Define derived model *variants* for OpenAI-compatible endpoints.
 *
 * A variant is a new pi model id that `extends` an existing
 * openai-completions model (the "parent", e.g. a llama.cpp or litellm
 * model in `models.json`) and layers a block of OpenAI-completions
 * sampling params (temperature, top_p, top_k, min_p, repetition_penalty,
 * or any other body field the server accepts) on top of every request.
 *
 * Opt in via `oai-params.json` (agent dir and/or project `.pi/`), keyed by
 * the new model id:
 *
 *   {
 *     "qwen3-27b-creative": {
 *       "extends": "llama-cpp/qwen3-6-27b",
 *       "name": "Qwen 3.6 27B (creative)",
 *       "samplingParams": { "temperature": 1.0, "min_p": 0.05, "top_k": 40 }
 *     }
 *   }
 *
 * Each variant is registered as its own single-model provider (name ==
 * the variant id) cloned from the parent's `models.json` block, so it
 * shows up in `/model` and is selectable via `--model <id>`. Because pi
 * sends `model: <model.id>` on the wire, the `before_provider_request`
 * hook rewrites `payload.model` back to the parent's real server id and
 * fills in the sampling params (fill-only: it never overwrites a key pi
 * already set, so `max_tokens`, `tools`, etc. are untouched).
 *
 * Env:
 *   PI_OAI_PARAMS_DISABLED=1   skip the extension entirely.
 *
 * The pure logic lives under `lib/node/pi/oai-params/`; this shell only
 * reads env / cwd, loads config, registers providers, and wires the hook.
 */

import { type ExtensionAPI, type ProviderConfig, type ProviderModelConfig } from '@earendil-works/pi-coding-agent';

import { loadVariantRegistrations } from '../../../lib/node/pi/oai-params/load-config.ts';
import { computeInjection } from '../../../lib/node/pi/oai-params/inject.ts';
import type { ProviderRegistrationSpec, VariantInjection } from '../../../lib/node/pi/oai-params/types.ts';
import { OAI_PARAMS_USAGE, renderStatus } from '../../../lib/node/pi/oai-params/usage.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

function toProviderConfig(spec: ProviderRegistrationSpec): ProviderConfig {
  return {
    baseUrl: spec.baseUrl,
    apiKey: spec.apiKey,
    api: spec.api,
    headers: spec.headers,
    authHeader: spec.authHeader,
    models: spec.models as unknown as ProviderModelConfig[],
  };
}

export default function oaiParamsExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_OAI_PARAMS_DISABLED)) return;

  const loaded = loadVariantRegistrations(process.cwd());
  const injections: Map<string, VariantInjection> = loaded.injections;

  // Register each variant as its own single-model provider. Queued during
  // initial load and applied once the runner binds context, so the models
  // exist for `--model` resolution.
  const registeredProviders = new Set<string>();
  for (const spec of loaded.registrations) {
    try {
      pi.registerProvider(spec.providerName, toProviderConfig(spec));
      registeredProviders.add(spec.providerName);
    } catch {
      // A bad clone shouldn't wedge the session; it just won't appear.
    }
  }

  // Nothing opted in (and no errors worth surfacing): stay fully inert
  // except for the command, which reports the empty/error state.
  const active = registeredProviders.size > 0;

  if (active) {
    pi.on('before_provider_request', (event, ctx) => {
      const provider = (ctx.model as { provider?: string } | undefined)?.provider;
      const decision = computeInjection({ payload: event.payload, provider, injections });
      if (decision.action === 'inject') return decision.payload;
      return;
    });
  }

  pi.registerCommand('oai-params', {
    description: 'List derived model variants (oai-params.json) and their sampling params',
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        if (ctx.hasUI) ctx.ui.notify(OAI_PARAMS_USAGE, 'info');
        return;
      }
      const activeProvider = (ctx.model as { provider?: string } | undefined)?.provider;
      const status = renderStatus({
        variants: loaded.variants,
        registeredProviders,
        errors: loaded.errors,
        activeProvider,
      });
      if (ctx.hasUI) ctx.ui.notify(status, 'info');
    },
  });

  pi.on('session_shutdown', () => {
    for (const name of registeredProviders) {
      try {
        pi.unregisterProvider(name);
      } catch {
        // Idempotent teardown - never throw from shutdown.
      }
    }
    registeredProviders.clear();
    injections.clear();
  });
}
