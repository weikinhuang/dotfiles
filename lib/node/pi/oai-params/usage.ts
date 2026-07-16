/**
 * USAGE text and the pure status renderer for the `/oai-params` command.
 * Kept in a pure module so the extension shell, the `--help` path, and the
 * command-surface spec share one source of truth (no pi imports).
 */

import type { ParsedVariant } from './types.ts';

export const OAI_PARAMS_USAGE = [
  'Usage: /oai-params',
  '',
  'List the derived model variants defined in oai-params.json: each',
  "variant's parent model and the sampling params layered on top.",
].join('\n');

/**
 * Render the `/oai-params` status block. `errors` are config/resolution
 * problems; `activeProvider` (the current model's provider name) marks the
 * live variant with an arrow.
 */
export function renderStatus(args: {
  variants: ParsedVariant[];
  registeredProviders: ReadonlySet<string>;
  errors: string[];
  activeProvider: string | undefined;
}): string {
  const { variants, registeredProviders, errors, activeProvider } = args;
  const lines: string[] = [];

  if (variants.length === 0) {
    lines.push('oai-params: no variants defined (add entries to oai-params.json).');
  } else {
    lines.push(`oai-params: ${variants.length} variant${variants.length === 1 ? '' : 's'}`);
    for (const v of variants) {
      const live = v.id === activeProvider ? '→ ' : '  ';
      const ok = registeredProviders.has(v.id) ? '' : ' [not registered]';
      const params = Object.entries(v.samplingParams)
        .map(([k, val]) => `${k}=${JSON.stringify(val)}`)
        .join(', ');
      lines.push(`${live}${v.id}  (extends ${v.parentProvider}/${v.parentId})${ok}`);
      lines.push(`    ${params || '(no sampling params)'}`);
    }
  }

  if (errors.length) {
    lines.push('');
    lines.push('errors:');
    for (const e of errors) lines.push(`  - ${e}`);
  }

  return lines.join('\n');
}
