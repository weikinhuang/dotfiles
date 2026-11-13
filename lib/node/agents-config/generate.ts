/**
 * `sync.ts generate`: compute every file emitted from the canonical shell
 * allowlist. Pure apart from the injected reader, so specs can assert
 * the committed files equal the generator output.
 */

import { setJsonStringArrays, replaceMarkedRegion } from './file-regions.ts';
import {
  CANONICAL_LIST_PATH,
  claudeNoteLines,
  claudeRules,
  codexRulesFile,
  copilotRegionLines,
  opencodeRegionLines,
} from './shell-emitters.ts';
import { parseShellPermissions } from './shell-permissions.ts';

/** Region name used by the `BEGIN GENERATED <name>` / `END GENERATED <name>` markers. */
export const REGION_NAME = 'shell-permissions';

/** Repo-relative paths of every file the generator owns (in whole or in part). */
export const GENERATED_PATHS = {
  claudeSettings: 'config/claude/settings-baseline.json',
  claudeReadme: 'config/claude/README.md',
  opencode: 'config/opencode/opencode.jsonc',
  copilot: 'config/copilot/tool-permissions',
  codex: 'config/codex/dotfiles.rules',
} as const;

export interface GeneratedFile {
  /** Repo-relative path. */
  path: string;
  /** Full new content. */
  content: string;
  /** Current content, or `undefined` when the file does not exist yet. */
  previous: string | undefined;
}

/** Reads a repo-relative path; returns `undefined` when the file is missing. */
export type RepoReader = (path: string) => string | undefined;

function mustRead(read: RepoReader, path: string): string {
  const text = read(path);
  if (text === undefined) throw new Error(`${path}: file not found`);
  return text;
}

/** Compute the new content of every generated file. Throws on an invalid list or missing markers. */
export function generateShellPermissionFiles(read: RepoReader): GeneratedFile[] {
  const list = parseShellPermissions(mustRead(read, CANONICAL_LIST_PATH));
  const out: GeneratedFile[] = [];
  const region = (path: string, body: string[]): void => {
    const previous = mustRead(read, path);
    out.push({ path, previous, content: replaceMarkedRegion(previous, REGION_NAME, body, path) });
  };

  const claudePath = GENERATED_PATHS.claudeSettings;
  const claudePrevious = mustRead(read, claudePath);
  const { allow, ask } = claudeRules(list);
  out.push({
    path: claudePath,
    previous: claudePrevious,
    content: setJsonStringArrays(claudePrevious, ['permissions'], { allow, ask }, 'allow'),
  });
  region(GENERATED_PATHS.claudeReadme, ['', ...claudeNoteLines(list), '']);
  region(GENERATED_PATHS.opencode, opencodeRegionLines(list));
  region(GENERATED_PATHS.copilot, copilotRegionLines(list));
  out.push({ path: GENERATED_PATHS.codex, previous: read(GENERATED_PATHS.codex), content: codexRulesFile(list) });
  return out;
}

/** Generated files whose committed content differs from the generator output. */
export function staleFiles(files: GeneratedFile[]): GeneratedFile[] {
  return files.filter((f) => f.previous !== f.content);
}
