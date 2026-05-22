/**
 * Type-narrowing helpers for the apply-patch specs. The pure helpers
 * under test return discriminated unions (`{ patch } | { error }`,
 * `{ plan } | { errors }`), and `vitest/no-conditional-expect` rejects
 * the `expect(...); if (...) { expect(...) }` pattern. These
 * assertions throw early so the tests can keep the happy-path
 * `expect`s outside any conditional.
 */

export function assertHas<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): asserts value is Extract<T, Record<K, unknown>> {
  if (!(key in value)) {
    throw new Error(`expected result to have key "${String(key)}", got keys: ${Object.keys(value).join(', ')}`);
  }
}
