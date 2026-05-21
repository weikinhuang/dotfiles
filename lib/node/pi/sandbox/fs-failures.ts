/**
 * Parse sandbox-induced filesystem failures out of a bash tool_result's
 * stderr.
 *
 * Why parse stderr instead of ASRT's `SandboxViolationStore`?
 *
 *   1. The store is populated only by `startMacOSSandboxLogMonitor`,
 *      which we don't enable (`enableLogMonitor: false` in
 *      `config/pi/extensions/sandbox.ts`'s `manager.initialize` call).
 *   2. There is no Linux equivalent of that monitor in ASRT - bwrap
 *      doesn't surface kernel deny events to userspace at all.
 *
 * So in practice the store is empty on both platforms, and the only
 * signal we have that a sandboxed bash failed because of a policy
 * deny is the EPERM/EACCES that bubbled up to the process's stderr.
 *
 * This module exposes {@link parseFsFailures}, which scans a stderr
 * blob for lines that look like a permission denial naming an
 * absolute path, and classifies each path as a write or read attempt.
 * The output drives the reactive "add write.allow rule and retry?"
 * dialog in `sandbox.ts`'s `tool_result` hook.
 *
 * Intentionally conservative: when the line shape is unfamiliar or no
 * absolute path can be extracted, the parser returns empty arrays and
 * the caller falls back to the existing "surface annotated stderr to
 * the model" behaviour. Better to miss a prompt than to fabricate a
 * path.
 */

/**
 * Marker phrases that strongly suggest the line describes a kernel /
 * runtime permission denial. We look for ANY of these; the path
 * extraction step is what determines whether we actually surface a
 * prompt.
 */
const DENIAL_MARKERS = [
  'permission denied',
  'operation not permitted',
  'read-only file system',
  'eacces',
  'eperm',
  'erofs',
];

/**
 * Verbs that imply a write attempt. When a denial line mentions any
 * of these and not a clearly-read-only verb, we classify the path as
 * a write. We default to write on ambiguity because pi's policy
 * denies reads only for a small, sensitive set (secrets, ssh keys);
 * everything else that hits a sandbox deny is overwhelmingly a write.
 */
const WRITE_VERBS = [
  'write',
  'create',
  'mkdir',
  'unlink',
  'rmdir',
  'remove',
  'rename',
  'mv',
  'cp',
  'touch',
  'install',
  'chmod',
  'chown',
  'symlink',
  'link',
  'open',
  'truncate',
];

/**
 * Verbs that imply a read attempt. Only used to flip the default
 * write classification when the line very clearly speaks of a read.
 */
const READ_VERBS = ['read', 'cat', 'stat', 'lstat', 'access', 'getattr'];

export interface ParsedFsFailures {
  /** Absolute paths the kernel refused to write. Deduplicated, order
   *  preserved (first occurrence wins). */
  writePaths: string[];
  /** Absolute paths the kernel refused to read. Deduplicated. */
  readPaths: string[];
}

/**
 * Extract absolute paths from a single line of stderr text.
 *
 * Patterns we cover:
 *
 *   * `'/abs/path'`              quoted (single or double)
 *   * `"/abs/path"`
 *   * `…: /abs/path: <error>`    classic bash / coreutils shape
 *   * `path: '/abs/path'`        Node `EACCES`/`EPERM` error shape
 *   * `… '/abs/path' …`          embedded quoted absolute path
 *
 * We deliberately ignore relative paths - the prompt needs to write
 * a stable entry into `filesystem.json`'s `write.allow.paths`, and a
 * bare relative segment is too dangerous to add without a cwd anchor.
 */
function extractAbsPathsFromLine(line: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (path: string): void => {
    if (!path.startsWith('/')) return;
    if (seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };

  // 1. Quoted absolute paths (single or double quotes). Capture
  //    greedy-but-stop-at-quote so embedded spaces are kept.
  const quoted = line.matchAll(/['"](\/[^'"\n]+)['"]/g);
  for (const m of quoted) push(m[1]);

  // 2. Unquoted absolute paths bounded by whitespace or a colon. We
  //    skip these if any quoted match overlapped, to avoid pulling
  //    the same path twice with different boundary characters.
  const unquoted = line.matchAll(/(?:^|[\s,(])(\/[^\s'",:)]+)/g);
  for (const m of unquoted) push(m[1]);

  return out;
}

function classifyLine(line: string): 'write' | 'read' {
  const lower = line.toLowerCase();
  const hasWriteVerb = WRITE_VERBS.some((v) => lower.includes(v));
  const hasReadVerb = READ_VERBS.some((v) => lower.includes(v));
  // Only classify as read when the line clearly speaks of a read AND
  // says nothing about writing. Otherwise default to write - the
  // sandbox's read-deny list is much narrower than its write policy,
  // so write is the much more common true positive.
  if (hasReadVerb && !hasWriteVerb) return 'read';
  return 'write';
}

/**
 * Parse a bash tool_result's stderr (or combined stdout+stderr) for
 * sandbox-induced filesystem denials.
 *
 * The input may be the raw `result.stderr`, the first text content
 * item from pi's bash tool result, or any concatenation of the two -
 * we scan line-by-line and only consider lines that contain a
 * permission-denial marker.
 *
 * Returns deduplicated absolute paths. The caller decides whether to
 * fire a prompt; an empty result means "nothing actionable here, keep
 * the existing splice".
 */
export function parseFsFailures(stderr: string): ParsedFsFailures {
  if (!stderr) return { writePaths: [], readPaths: [] };

  const writePaths: string[] = [];
  const readPaths: string[] = [];
  const writeSeen = new Set<string>();
  const readSeen = new Set<string>();
  const pushPath = (kind: 'write' | 'read', path: string): void => {
    const bucket = kind === 'write' ? writePaths : readPaths;
    const seen = kind === 'write' ? writeSeen : readSeen;
    if (seen.has(path)) return;
    seen.add(path);
    bucket.push(path);
  };

  const lines = stderr.split(/\r?\n/).map((l) => l.trim());

  // Pass 1: lines that contain a denial marker AND an absolute path.
  for (const line of lines) {
    if (!line) continue;
    const lower = line.toLowerCase();
    if (!DENIAL_MARKERS.some((marker) => lower.includes(marker))) continue;
    const paths = extractAbsPathsFromLine(line);
    if (paths.length === 0) continue;
    const kind = classifyLine(line);
    for (const path of paths) pushPath(kind, path);
  }

  // Pass 2: npm / yarn / pnpm split their EACCES output across
  // multiple lines, with the marker on one line and the path on a
  // separate `path:` line. When we've already seen at least one
  // denial marker anywhere in stderr, also extract paths from those
  // shape-specific block lines. We gate on a marker existing so a
  // benign `npm error path: ./foo` from an unrelated failure can't
  // fabricate a write-allow offer.
  const sawAnyMarker = lines.some((l) => {
    if (!l) return false;
    const lower = l.toLowerCase();
    return DENIAL_MARKERS.some((m) => lower.includes(m));
  });
  if (sawAnyMarker) {
    const blockPathRe =
      /^(?:npm (?:error|ERR!)|yarn (?:error|ERR!)|pnpm (?:error|ERR!))\s+path:?\s+['"]?(\/[^'"\s]+)['"]?/;
    for (const line of lines) {
      if (!line) continue;
      const m = blockPathRe.exec(line);
      if (!m) continue;
      pushPath('write', m[1]);
    }
  }

  return { writePaths, readPaths };
}

/**
 * Greatest common path prefix of a non-empty list of absolute paths.
 *
 * Used by the fs-ask dialog to collapse "denied write to
 * `<cwd>/node_modules/foo/...`" plus "denied write to
 * `<cwd>/node_modules/bar/...`" into a single offer for
 * `<cwd>/node_modules`. Segment-wise, so two paths that merely share
 * a prefix character (e.g. `/usr/local/foo` vs `/usr/locale/bar`)
 * collapse to `/usr` rather than the wrong substring.
 *
 * Returns the first input verbatim when only one path is given.
 * Returns `/` only when the inputs disagree on their first segment;
 * the caller should treat that as "no useful common parent" and
 * decline to offer an `Always allow` choice.
 */
export function greatestCommonParent(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) return paths[0];

  const split = (p: string): string[] => p.split('/').filter((seg) => seg.length > 0);
  const first = split(paths[0]);
  let commonLen = first.length;
  for (let i = 1; i < paths.length; i++) {
    const parts = split(paths[i]);
    const cap = Math.min(commonLen, parts.length);
    let j = 0;
    while (j < cap && parts[j] === first[j]) j++;
    commonLen = j;
    if (commonLen === 0) return '/';
  }

  if (commonLen === 0) return '/';
  return '/' + first.slice(0, commonLen).join('/');
}
