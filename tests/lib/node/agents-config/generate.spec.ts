import { describe, expect, test } from 'vitest';

import {
  GENERATED_PATHS,
  generateShellPermissionFiles,
  staleFiles,
} from '../../../../lib/node/agents-config/generate.ts';

const LIST = `{
  "entries": [
    { "pattern": "cp *", "tier": "extras" },
    { "pattern": "jq *", "tier": "shared", "note": "Reads JSON." },
    { "pattern": "yq *", "tier": "shared", "except": ["yq -i *"] },
  ],
}`;

const CLAUDE = `{
  "permissions": {
    "allow": ["Bash(old *)"],
    "deny": ["Read(./.env)"]
  },
  "theme": "auto"
}
`;

const README =
  '# Claude\n\n<!-- BEGIN GENERATED shell-permissions -->\nold\n<!-- END GENERATED shell-permissions -->\n';

const OPENCODE = `{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    // BEGIN GENERATED shell-permissions
    // END GENERATED shell-permissions
    { "action": "read", "resource": "*.env", "effect": "deny" },
  ],
}
`;

const COPILOT =
  '# header\n# BEGIN GENERATED shell-permissions\nallow shell(old:*)\n# END GENERATED shell-permissions\ndeny read(.env)\n';

function fixture(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    'config/agents/shell-permissions.jsonc': LIST,
    [GENERATED_PATHS.claudeSettings]: CLAUDE,
    [GENERATED_PATHS.claudeReadme]: README,
    [GENERATED_PATHS.opencode]: OPENCODE,
    [GENERATED_PATHS.copilot]: COPILOT,
    ...overrides,
  };
}

function contentOf(files: ReturnType<typeof generateShellPermissionFiles>, path: string): string {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`no generated file ${path}`);
  return file.content;
}

describe('generateShellPermissionFiles', () => {
  const repo = fixture();
  const files = generateShellPermissionFiles((p) => repo[p]);

  test('emits every owned file', () => {
    expect(files.map((f) => f.path)).toEqual([
      GENERATED_PATHS.claudeSettings,
      GENERATED_PATHS.claudeReadme,
      GENERATED_PATHS.opencode,
      GENERATED_PATHS.copilot,
      GENERATED_PATHS.codex,
    ]);
  });

  test('Claude: allow / ask rewritten, other keys kept', () => {
    expect(JSON.parse(contentOf(files, GENERATED_PATHS.claudeSettings))).toEqual({
      permissions: {
        allow: ['Bash(cp *)', 'Bash(jq *)', 'Bash(yq *)'],
        ask: ['Bash(yq -i *)'],
        deny: ['Read(./.env)'],
      },
      theme: 'auto',
    });
  });

  test('Claude README: notes region', () => {
    expect(contentOf(files, GENERATED_PATHS.claudeReadme)).toBe(
      '# Claude\n\n<!-- BEGIN GENERATED shell-permissions -->\n\n- `jq *`: Reads JSON.\n\n<!-- END GENERATED shell-permissions -->\n',
    );
  });

  test('opencode: shared tier only, asks before the hand-written denies', () => {
    const out = contentOf(files, GENERATED_PATHS.opencode);
    expect(out).not.toContain('"cp *"');
    const order = ['"*", "effect": "ask"', '"jq *"', '"yq *"', '"yq -i *", "effect": "ask"', '"*.env"'].map((s) =>
      out.indexOf(s),
    );
    expect(order.every((pos, i) => pos >= 0 && (i === 0 || pos > order[i - 1]))).toBe(true);
  });

  test('Copilot: shared entries without except', () => {
    expect(contentOf(files, GENERATED_PATHS.copilot)).toBe(
      '# header\n# BEGIN GENERATED shell-permissions\n# Reads JSON.\nallow shell(jq:*)\n# END GENERATED shell-permissions\ndeny read(.env)\n',
    );
  });

  test('Codex: new file, both tiers, no except entries', () => {
    const codex = files.find((f) => f.path === GENERATED_PATHS.codex);
    expect(codex?.previous).toBeUndefined();
    expect(codex?.content).toContain('prefix_rule(pattern=["cp"], decision="allow")');
    expect(codex?.content).not.toContain('"yq"');
  });

  test('staleFiles: regenerating the output is a no-op', () => {
    expect(staleFiles(files)).toHaveLength(files.length);
    const regenerated = fixture(Object.fromEntries(files.map((f) => [f.path, f.content])));
    expect(staleFiles(generateShellPermissionFiles((p) => regenerated[p]))).toEqual([]);
  });
});

describe('generateShellPermissionFiles errors', () => {
  test('missing input file', () => {
    const repo = fixture({ [GENERATED_PATHS.copilot]: undefined });
    expect(() => generateShellPermissionFiles((p) => repo[p])).toThrow(
      'config/copilot/tool-permissions: file not found',
    );
  });

  test('missing markers', () => {
    const repo = fixture({ [GENERATED_PATHS.opencode]: '{}\n' });
    expect(() => generateShellPermissionFiles((p) => repo[p])).toThrow(
      'config/opencode/opencode.jsonc: expected exactly one "BEGIN GENERATED shell-permissions" line, found 0',
    );
  });

  test('invalid list', () => {
    const repo = fixture({ 'config/agents/shell-permissions.jsonc': '{ "entries": [{ "pattern": "ls *" }] }' });
    expect(() => generateShellPermissionFiles((p) => repo[p])).toThrow('"tier" must be one of shared, extras');
  });
});
