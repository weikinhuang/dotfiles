/**
 * Pure formatters for the persona CLI flags `--persona-info`,
 * `--list-personas`, and `--validate-personas` (followup #3 in
 * `plans/persona-extension-followups.md`).
 *
 * The shipped persona shell in `config/pi/extensions/persona.ts` already
 * has an inline `/persona info <name>` formatter at command-handler
 * time. This module hoists the same shape so it can also be reached
 * from a non-interactive `pi -p` invocation, and so the format is
 * unit-tested directly under vitest instead of being verified through
 * the runtime ctx.ui.notify pipe.
 *
 * Three exports, three concerns:
 *
 *  - `formatPersonaInfoLines(input)` — multi-line dump of one resolved
 *    persona (source, inheritedFrom, tools, writeRoots, bashAllow,
 *    bashDeny, model, thinkingLevel, requestOptions, body / prompt
 *    lengths). Mirrors what `/persona info <name>` already prints.
 *
 *  - `formatPersonaListLines(items)` — one line per persona with the
 *    layered source tag (`[shipped]` / `[user]` / `[project]`) and a
 *    `*` prefix on the active one. Tighter than the interactive
 *    `/persona` listing because the `-p` audience is reading stdout,
 *    not a notify popup.
 *
 *  - `formatPersonaValidate(input)` — walks the warnings the parsing
 *    pipeline accumulated and returns `{ exitCode, lines }`. Exit code
 *    is non-zero iff at least one warning fired, so CI scripts can
 *    `pi --validate-personas && …` confidently.
 *
 * Inputs are deliberately structural (plain shapes — no pi imports)
 * so the persona extension shell can construct them from its parsed
 * persona records without re-resolving anything, and the spec can
 * exercise edge cases (missing optional fields, no warnings, mixed
 * sources) without the runtime in scope.
 */

// -- Persona-info formatter -----------------------------------------------------------------------

/** Structural shape consumed by `formatPersonaInfoLines`. */
export interface PersonaInfoInput {
  readonly name: string;
  readonly source: string;
  /** `null` means "standalone" (no `agent: <name>` inheritance). */
  readonly inheritedFrom: string | null;
  /** `undefined` means the persona didn't override tools (inherit / no opinion). */
  readonly tools: readonly string[] | undefined;
  /** Already substituted + resolved against cwd / homedir. */
  readonly resolvedWriteRoots: readonly string[];
  readonly bashAllow: readonly string[];
  readonly bashDeny: readonly string[];
  /** Model spec string (`provider/id`) or `null` to mean inherit. */
  readonly model: string | null | undefined;
  readonly thinkingLevel: string | null | undefined;
  /** Free-form deep-merge payload; rendered as JSON for visibility. */
  readonly requestOptions?: Readonly<Record<string, unknown>>;
  readonly bodyLength: number;
  readonly promptLength: number;
}

/**
 * Render a multi-line dump of one resolved persona. Output matches the
 * existing `/persona info <name>` format so the two paths look the
 * same from the user's POV.
 */
export function formatPersonaInfoLines(input: PersonaInfoInput): string[] {
  const toolsStr = input.tools && input.tools.length > 0 ? input.tools.join(', ') : '(inherit / none)';
  const writeRootsStr =
    input.resolvedWriteRoots.length > 0 ? input.resolvedWriteRoots.join(', ') : '(none — writes disallowed)';
  const requestOptionsStr =
    input.requestOptions && Object.keys(input.requestOptions).length > 0
      ? ` ${JSON.stringify(input.requestOptions)}`
      : ' (none)';

  return [
    `persona "${input.name}"`,
    `  source:        ${input.source}`,
    `  inheritedFrom: ${input.inheritedFrom ?? '(standalone)'}`,
    `  tools:         ${toolsStr}`,
    `  writeRoots:    ${writeRootsStr}`,
    `  bashAllow:     ${input.bashAllow.join(', ') || '(empty)'}`,
    `  bashDeny:      ${input.bashDeny.join(', ') || '(empty)'}`,
    `  model:         ${input.model ?? '(inherit)'}`,
    `  thinkingLevel: ${input.thinkingLevel ?? '(inherit)'}`,
    `  requestOptions:${requestOptionsStr}`,
    `  body length:   ${input.bodyLength} chars`,
    `  prompt length: ${input.promptLength} chars`,
  ];
}

// -- Persona-list formatter ---------------------------------------------------------------------

export interface PersonaListItem {
  readonly name: string;
  readonly source: string;
  readonly description?: string;
  readonly active?: boolean;
}

/**
 * Tighter, one-line-per-persona format suited to `pi -p` stdout.
 * Includes the layered source tag so users can disambiguate
 * `~/.pi/personas/chat.md` from the shipped `chat`.
 *
 * Format:
 *
 *   * chat            [shipped] Long-form Q&A with web access; no writes.
 *     plan            [shipped] Drop a plan doc; never edits source.
 *     exusiai-buddy   [user]    …
 */
export function formatPersonaListLines(items: readonly PersonaListItem[]): string[] {
  if (items.length === 0) return ['(no personas loaded)'];

  // Pad name column so source tags line up.
  const nameWidth = items.reduce((acc, p) => Math.max(acc, p.name.length), 0);
  return items.map((p) => {
    const star = p.active ? '* ' : '  ';
    const paddedName = p.name.padEnd(nameWidth);
    const desc = p.description && p.description.length > 0 ? ` ${p.description}` : '';
    return `${star}${paddedName}  [${p.source}]${desc}`;
  });
}

// -- Persona-validate formatter -----------------------------------------------------------------

export interface PersonaValidateWarning {
  readonly path: string;
  readonly reason: string;
}

export interface PersonaValidateInput {
  readonly warnings: readonly PersonaValidateWarning[];
  /** Total persona files that loaded successfully (for the OK summary). */
  readonly totalLoaded: number;
}

export interface PersonaValidateOutput {
  /** 0 when no warnings, 1 otherwise. */
  readonly exitCode: 0 | 1;
  readonly lines: string[];
}

/**
 * Render the validate-personas report. Returns a non-zero exit code
 * iff there is at least one warning so CI can gate on it.
 *
 * Output shape:
 *
 *   <path>: <reason>
 *   <path>: <reason>
 *   3 warning(s); <N> persona(s) loaded                ← exitCode 1
 *
 * or, when there are no warnings:
 *
 *   OK: <N> persona(s) validated                       ← exitCode 0
 */
export function formatPersonaValidate(input: PersonaValidateInput): PersonaValidateOutput {
  if (input.warnings.length === 0) {
    return {
      exitCode: 0,
      lines: [`OK: ${input.totalLoaded} persona(s) validated`],
    };
  }

  const lines = input.warnings.map((w) => `${w.path}: ${w.reason}`);
  lines.push(`${input.warnings.length} warning(s); ${input.totalLoaded} persona(s) loaded`);
  return { exitCode: 1, lines };
}
