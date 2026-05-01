/**
 * Type-narrowing assertion helpers for `ActionResult`-shaped unions used
 * across the scratchpad / todo reducer specs.
 *
 * Lets tests replace the common
 *
 *     expect(r.ok).toBe(true);
 *     if (r.ok) { expect(r.state.foo).toBe(…) }
 *
 * pattern with
 *
 *     assertOk(r);
 *     expect(r.state.foo).toBe(…)
 *
 * which satisfies `vitest/no-conditional-in-test` +
 * `vitest/no-conditional-expect` while giving TypeScript the same
 * narrowing the old `if (r.ok)` block provided.
 */

interface OkLike {
  ok: boolean;
}

export function assertOk<T extends OkLike>(r: T): asserts r is Extract<T, { ok: true }> {
  if (!r.ok) {
    const err = (r as unknown as { error?: unknown }).error;
    throw new Error(`expected ok result, got error: ${typeof err === 'string' ? err : '(no error field)'}`);
  }
}

export function assertErr<T extends OkLike>(r: T): asserts r is Extract<T, { ok: false }> {
  if (r.ok) throw new Error('expected error result, got ok');
}

/**
 * Narrow a discriminated union to the member with `kind === expected`.
 * Lets tests replace the common
 *
 *     if (out.kind !== 'same-slice') throw new Error();
 *
 * pattern with
 *
 *     assertKind(out, 'same-slice');
 *
 * which satisfies `vitest/no-conditional-in-test` and gives TypeScript
 * the same narrowing the `if`/throw would have provided.
 */
interface Kinded {
  kind: string;
}

export function assertKind<T extends Kinded, K extends T['kind']>(
  value: T,
  expected: K,
): asserts value is Extract<T, { kind: K }> {
  if (value.kind !== expected) {
    throw new Error(`expected kind=${expected}, got kind=${value.kind}`);
  }
}
