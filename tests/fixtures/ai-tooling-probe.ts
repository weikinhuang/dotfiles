#!/usr/bin/env node
// Test harness that exposes ai-tooling/pricing.ts internals to bats tests.
// SPDX-License-Identifier: MIT

import {
  estimateAnthropicCost,
  estimateOpenAICost,
  loadPricing,
  lookupPricing,
  type ModelPricing,
  type PricingTable,
} from '../../lib/node/ai-tooling/pricing.ts';

const [cmd, ...rest] = process.argv.slice(2);

// Inline pricing fixture used by the "lookup-inline" command. Intentionally
// contains a provider-prefixed entry so we can verify the lookup's prefix
// fallback without any disk/network state.
function fixtureTable(): PricingTable {
  const models: Record<string, ModelPricing> = {
    'test-opus': {
      inputPerToken: 1e-5,
      outputPerToken: 5e-5,
      cacheReadPerToken: 1e-6,
      cacheWritePerToken: 1.25e-5,
    },
    'anthropic/test-sonnet': {
      inputPerToken: 3e-6,
      outputPerToken: 1.5e-5,
      cacheReadPerToken: 3e-7,
      cacheWritePerToken: 3.75e-6,
    },
    'openai/test-gpt': {
      inputPerToken: 2e-6,
      outputPerToken: 8e-6,
      cacheReadPerToken: 5e-7,
    },
  };
  return { models, fetchedAt: '', source: 'cache' };
}

async function main(): Promise<void> {
  if (cmd === 'lookup-inline') {
    const modelId = rest[0] ?? '';
    const match = lookupPricing(fixtureTable(), modelId);
    console.log(JSON.stringify(match ?? null));
    return;
  }
  if (cmd === 'load') {
    const refresh = rest[0] === '--refresh';
    const table = await loadPricing(refresh);
    console.log(
      JSON.stringify({
        source: table.source,
        models: Object.keys(table.models).length,
        fetchedAt: table.fetchedAt,
      }),
    );
    return;
  }
  if (cmd === 'cost-anthropic' || cmd === 'cost-openai') {
    const mp: ModelPricing = {
      inputPerToken: Number(rest[0] ?? '0'),
      outputPerToken: Number(rest[1] ?? '0'),
      cacheReadPerToken: Number(rest[2] ?? '0'),
      cacheWritePerToken: Number(rest[3] ?? '0'),
    };
    const tokens = {
      input: Number(rest[4] ?? '0'),
      output: Number(rest[5] ?? '0'),
      cacheRead: Number(rest[6] ?? '0'),
      cacheWrite: Number(rest[7] ?? '0'),
    };
    const cost = cmd === 'cost-anthropic' ? estimateAnthropicCost(tokens, mp) : estimateOpenAICost(tokens, mp);
    console.log(cost);
    return;
  }
  console.error(`unknown cmd: ${cmd}`);
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
