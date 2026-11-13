// TOML codec for the Codex `config.toml` merge in config/agents/sync.ts. Lives outside lib/ because it imports
// smol-toml (lib/ modules stay free of third-party runtime deps).
// SPDX-License-Identifier: MIT

import { parse, stringify } from 'smol-toml';

import { isPlainObject, type SettingsCodec, type SettingsObject } from '../../lib/node/agents-config/settings-merge.ts';

/**
 * Integers parse as `bigint` and plain numbers print as floats, so a round trip keeps `60` an integer and `1.0` a
 * float. Comments and inline-table layout are not preserved (Codex rewrites the file the same way).
 */
export const TOML_CODEC: SettingsCodec = {
  parse(text: string): SettingsObject {
    const value: unknown = parse(text, { integersAsBigInt: true });
    if (!isPlainObject(value)) throw new Error('expected a top-level table');
    return value;
  },
  stringify(value: SettingsObject): string {
    return stringify(value, { numbersAsFloat: true });
  },
};
