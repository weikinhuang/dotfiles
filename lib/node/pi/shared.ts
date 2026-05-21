/**
 * Barrel re-export for the low-level helpers that used to live in this
 * file. The actual implementations have moved into category modules
 * under `./shared/`:
 *
 *   - `./shared/strings.ts`  - `truncate`, `trimOrUndefined`
 *   - `./shared/bytes.ts`    - `BYTE_ENCODER`, `byteLen`
 *   - `./shared/hash.ts`     - `sha256Hex`, `sha256HexPrefix`
 *   - `./shared/guards.ts`   - `isRecord`, `isStringArray`,
 *                              `isNonEmptyString`, `isFiniteNumber`
 *
 * Existing imports (`import { truncate } from './shared.ts'`) keep
 * working unchanged. New callers can import from the more specific
 * module when they only need one category - smaller surface, easier to
 * read at the call site.
 */

export { BYTE_ENCODER, byteLen } from './shared/bytes.ts';
export { isFiniteNumber, isNonEmptyString, isRecord, isStringArray } from './shared/guards.ts';
export { sha256Hex, sha256HexPrefix } from './shared/hash.ts';
export { truncate, trimOrUndefined, type TruncateOptions } from './shared/strings.ts';
