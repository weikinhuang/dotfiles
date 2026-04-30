import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { GIT_PROMPT_FILENAME, resolveGitPromptScript } from '../../../../lib/node/pi/git-prompt.ts';

let sandbox = '';
let savedDotfilesRoot: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-git-prompt-'));
  savedDotfilesRoot = process.env.DOTFILES_ROOT;
  delete process.env.DOTFILES_ROOT;
});

afterEach(() => {
  if (savedDotfilesRoot === undefined) delete process.env.DOTFILES_ROOT;
  else process.env.DOTFILES_ROOT = savedDotfilesRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// Walking from startDir upward
// ──────────────────────────────────────────────────────────────────────

test('resolveGitPromptScript: finds external/git-prompt.sh in a parent directory', () => {
  // Mimic the real repo layout:
  //   <root>/external/git-prompt.sh
  //   <root>/config/pi/extensions/statusline.ts
  const scriptPath = join(sandbox, GIT_PROMPT_FILENAME);
  const extDir = join(sandbox, 'config/pi/extensions');
  mkdirSync(join(sandbox, 'external'), { recursive: true });
  mkdirSync(extDir, { recursive: true });
  writeFileSync(scriptPath, '# stub\n');

  assert.equal(resolveGitPromptScript(extDir), scriptPath);
});

test('resolveGitPromptScript: returns null when no candidate is reachable', () => {
  const extDir = join(sandbox, 'config/pi/extensions');
  mkdirSync(extDir, { recursive: true });

  assert.equal(resolveGitPromptScript(extDir, 4), null);
});

test('resolveGitPromptScript: honors maxDepth when the script is too far up', () => {
  // Script sits at `<sandbox>/external/git-prompt.sh` but we ask from a deeply
  // nested child with a maxDepth that can't reach it.
  const scriptPath = join(sandbox, GIT_PROMPT_FILENAME);
  mkdirSync(join(sandbox, 'external'), { recursive: true });
  writeFileSync(scriptPath, '# stub\n');

  const deepDir = join(sandbox, 'a/b/c/d/e/f/g/h/i/j/k/l');
  mkdirSync(deepDir, { recursive: true });

  assert.equal(resolveGitPromptScript(deepDir, 2), null);
  assert.equal(resolveGitPromptScript(deepDir, 32), scriptPath);
});

test('resolveGitPromptScript: resolves symlinks so ~/.dotfiles -> real repo works', () => {
  // Arrange: real repo at <sandbox>/repo with external/git-prompt.sh and a
  // symlinked entry at <sandbox>/link/dotfiles -> <sandbox>/repo. Starting
  // from deep inside the symlinked view should still locate the script.
  const repo = join(sandbox, 'repo');
  const scriptPath = join(repo, GIT_PROMPT_FILENAME);
  mkdirSync(join(repo, 'external'), { recursive: true });
  mkdirSync(join(repo, 'config/pi/extensions'), { recursive: true });
  writeFileSync(scriptPath, '# stub\n');

  const linkRoot = join(sandbox, 'link');
  mkdirSync(linkRoot, { recursive: true });
  const linked = join(linkRoot, 'dotfiles');
  try {
    symlinkSync(repo, linked, 'dir');
  } catch (err) {
    // Some filesystems (notably Windows without symlink perms) can't create
    // symlinks. Skip the symlink assertion in that case.
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
    throw err;
  }

  const linkedExtDir = join(linked, 'config/pi/extensions');
  // Resolved via realpath, so result is the canonical path inside <repo>.
  assert.equal(resolveGitPromptScript(linkedExtDir), scriptPath);
});

// ──────────────────────────────────────────────────────────────────────
// DOTFILES_ROOT override
// ──────────────────────────────────────────────────────────────────────

test('resolveGitPromptScript: prefers $DOTFILES_ROOT when it contains the script', () => {
  // Two candidate roots: one reachable by walking, one via env. Env should win.
  const walkRoot = join(sandbox, 'walk');
  const walkScript = join(walkRoot, GIT_PROMPT_FILENAME);
  mkdirSync(join(walkRoot, 'external'), { recursive: true });
  writeFileSync(walkScript, '# walk\n');

  const envRoot = join(sandbox, 'env-root');
  const envScript = join(envRoot, GIT_PROMPT_FILENAME);
  mkdirSync(join(envRoot, 'external'), { recursive: true });
  writeFileSync(envScript, '# env\n');

  process.env.DOTFILES_ROOT = envRoot;
  const extDir = join(walkRoot, 'config/pi/extensions');
  mkdirSync(extDir, { recursive: true });

  assert.equal(resolveGitPromptScript(extDir), envScript);
});

test('resolveGitPromptScript: ignores $DOTFILES_ROOT that does not contain the script, then walks', () => {
  const walkRoot = sandbox;
  const walkScript = join(walkRoot, GIT_PROMPT_FILENAME);
  mkdirSync(join(walkRoot, 'external'), { recursive: true });
  writeFileSync(walkScript, '# walk\n');

  process.env.DOTFILES_ROOT = join(sandbox, 'does-not-exist');
  const extDir = join(walkRoot, 'config/pi/extensions');
  mkdirSync(extDir, { recursive: true });

  assert.equal(resolveGitPromptScript(extDir), walkScript);
});
