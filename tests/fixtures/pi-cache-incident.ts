/** Sanitized token/cost-only approximation of 01a0fd44, not a copied private transcript. */
import type { PiEntry } from '../../lib/node/ai-tooling/adapters/pi-adapter.ts';

export function piCacheIncident(): PiEntry[] {
  return Array.from({ length: 54 }, (_, index) => {
    const cacheRead = index < 8 ? 16816 + index * 6000 : index < 28 ? 63958 : 16816;
    const cacheWrite = index < 8 ? 5000 : index < 28 ? 5600 + (index - 8) * 1800 : 86410 + (index - 28) * 2200;
    const output = 412;
    const cost = {
      input: 0.000008,
      output: output * 0.00002,
      cacheRead: cacheRead * 0.0000004,
      cacheWrite: cacheWrite * 0.000005,
      total: 0,
    };
    cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
    return {
      type: 'message',
      timestamp: new Date(Date.UTC(2026, 6, 1) + index * 30000).toISOString(),
      message: {
        role: 'assistant',
        model: 'gpt-5.6-sol',
        provider: 'azure-openai-responses',
        usage: { input: 2, output, cacheRead, cacheWrite, cost },
      },
    };
  });
}
