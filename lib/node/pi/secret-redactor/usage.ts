/**
 * USAGE text for the `secret-redactor` extension's commands. Pure string
 * module so each handler, its `--help` path, and any empty-arg path share
 * one source of truth.
 */

/**
 * `/unredact <handle>`. Kept byte-identical to the string the handler
 * previously inlined on the empty-arg path, so both the `--help` and the
 * missing-handle branch surface the exact same text.
 */
export const UNREDACT_USAGE = 'Usage: /unredact <handle>  (see /secret-redactor for the list)';

/** `/secret-redactor` - list secrets redacted this session. */
export const SECRET_REDACTOR_USAGE = [
  'Usage: /secret-redactor',
  '',
  'List the secrets redacted from the model-bound copy this session and',
  'their state (redacted / rehydrate-ok / revealed). Reveal one to the',
  'model with /unredact <handle>.',
].join('\n');
