// Seeded stratified train/test split for the description optimizer.
//
// Port of `split_eval_set` from
// `~/.claude/skills/skill-creator/scripts/run_loop.py`:
//
//   - Split the eval set into `should_trigger=true` vs `should_trigger=false`
//     groups,
//   - shuffle each group with a deterministic PRNG,
//   - hold out `max(1, floor(len * holdout))` from each group for the test
//     set,
//   - return the remaining items as the train set.
//
// The `max(1, …)` guarantees a 1-item group still contributes to the test
// set when `holdout > 0`, matching the Python original's behaviour (the
// train set for that side ends up empty, which the caller tolerates).
//
// Deterministic seeding is load-bearing: the optimizer calls
// `stratifiedSplit` once per run, but reruns with the same seed must see
// the same split so iteration logs are reproducible.
//
// SPDX-License-Identifier: MIT

/** An item that can be stratified. Only `should_trigger` is inspected. */
export interface StratifiableItem {
  should_trigger: boolean;
}

export interface SplitResult<T> {
  train: T[];
  test: T[];
}

/**
 * Mulberry32 — a small, fast, 32-bit seeded PRNG. Returns `[0, 1)`. Adequate
 * for our reproducibility-of-splits use case; NOT cryptographically strong.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle using the supplied PRNG. Returns a new array. */
export function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Split `items` into train + test sets, stratified by `should_trigger` and
 * holding out `holdout` (0.0–1.0) of each side. `holdout=0` collapses to
 * `train=items, test=[]`. Default seed `42` matches the upstream Python.
 */
export function stratifiedSplit<T extends StratifiableItem>(
  items: readonly T[],
  holdout: number,
  seed = 42,
): SplitResult<T> {
  if (holdout <= 0) {
    return { train: items.slice(), test: [] };
  }
  const rng = mulberry32(seed);
  const trigger = shuffle(
    items.filter((e) => e.should_trigger === true),
    rng,
  );
  const noTrigger = shuffle(
    items.filter((e) => e.should_trigger === false),
    rng,
  );
  const nTriggerTest = Math.max(1, Math.floor(trigger.length * holdout));
  const nNoTriggerTest = Math.max(1, Math.floor(noTrigger.length * holdout));
  const test = [...trigger.slice(0, nTriggerTest), ...noTrigger.slice(0, nNoTriggerTest)];
  const train = [...trigger.slice(nTriggerTest), ...noTrigger.slice(nNoTriggerTest)];
  return { train, test };
}
