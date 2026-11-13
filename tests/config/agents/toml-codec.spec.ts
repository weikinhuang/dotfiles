import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'smol-toml';
import { describe, expect, test } from 'vitest';

import { TOML_CODEC } from '../../../config/agents/toml-codec.ts';
import { mergeSettings, valuesEqual } from '../../../lib/node/agents-config/settings-merge.ts';

const BASELINE = readFileSync(resolve(import.meta.dirname, '../../../config/codex/config.toml'), 'utf8');

// Shaped like a live ~/.codex/config.toml: app-managed tables, quoted keys with spaces / dots / slashes, env
// sub-tables, an array of tables, inline tables, floats, dates, and comments.
const LIVE = `# managed by Codex
model = "gpt-5.5"
model_reasoning_effort = "medium"
notify = ["bash", "-lc", "afplay /System/Library/Sounds/Glass.aiff"]
"key with spaces" = "kept"
"dotted.key" = 1.0

[features]
memories = false
js_repl = true

[tui]
status_line = ["model-with-reasoning", "git-branch"]
theme = "light"
screen_reader_detection_done = true

[tui.model_availability_nux]
"gpt-5.5" = 3

[notice]
fast_default_opt_out = true

[notice.model_migrations]
"gpt-5.1" = "gpt-5.5"

[projects."/Users/me/source/dotfiles"]
trust_level = "trusted"

[projects."/Users/me/source/with space.and.dots"]
trust_level = "untrusted"

[mcp_servers.node_repl]
command = "node"
args = ["repl.js", "--flag"]
startup_timeout_sec = 60
tool_timeout_sec = 12.5

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/me/.codex"
"WITH-DASH" = "x"

[shell_environment_policy]
inherit = "core"

[shell_environment_policy.set]
PATH = "/usr/bin"

[desktop]
conversationDetailMode = "steps"
lastOpened = 2026-11-01T10:00:00Z
window = { width = 1200, height = 800 }

[marketplaces.openai-bundled]
source_type = "builtin"
source = "bundled"

[plugins."figma@openai-bundled"]
enabled = true

[[profiles_list]]
name = "a"

[[profiles_list]]
name = "b"
`;

const APP_MANAGED = [
  'model',
  'notify',
  'key with spaces',
  'dotted.key',
  'notice',
  'projects',
  'mcp_servers',
  'shell_environment_policy',
  'desktop',
  'marketplaces',
  'plugins',
  'profiles_list',
];

describe('TOML_CODEC', () => {
  test('a parse / stringify round trip keeps every value and type', () => {
    const original = TOML_CODEC.parse(LIVE);
    const again = TOML_CODEC.parse(TOML_CODEC.stringify(original));
    expect(valuesEqual(again, original)).toBe(true);
    // Integers stay integers and floats stay floats.
    expect(TOML_CODEC.stringify(original)).toMatch(/^"dotted\.key" = 1\.0$/m);
    expect(TOML_CODEC.stringify(original)).toMatch(/^startup_timeout_sec = 60$/m);
    expect(TOML_CODEC.stringify(original).endsWith('\n')).toBe(true);
  });

  test('merging the repo baseline keeps every app-managed table equivalent in meaning', () => {
    const live = TOML_CODEC.parse(LIVE);
    const { merged, changes } = mergeSettings(TOML_CODEC.parse(BASELINE), live);
    const written = TOML_CODEC.parse(TOML_CODEC.stringify(merged));
    for (const key of APP_MANAGED) expect([key, valuesEqual(written[key], live[key])]).toEqual([key, true]);
    // Live-only keys inside repo-owned tables survive; repo-owned keys win.
    const features = written.features as Record<string, unknown>;
    expect(features.js_repl).toBe(true);
    expect(features.memories).toBe(true);
    const tui = written.tui as Record<string, unknown>;
    expect(tui.screen_reader_detection_done).toBe(true);
    expect(tui.theme).toBe('solarized-dark');
    expect(written.model_reasoning_effort).toBe('high');
    expect(changes.length).toBeGreaterThan(0);
    // The merged text is still valid TOML for an independent parse.
    expect(() => parse(TOML_CODEC.stringify(merged))).not.toThrow();
  });

  test('a live file that already matches the baseline has no changes', () => {
    const baseline = TOML_CODEC.parse(BASELINE);
    expect(mergeSettings(baseline, TOML_CODEC.parse(TOML_CODEC.stringify(baseline))).changes).toEqual([]);
  });
});
