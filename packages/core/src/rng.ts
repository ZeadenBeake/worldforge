/**
 * Seeded, engine-independent PRNG (sfc32 seeded via cyrb128).
 *
 * `fork(label)` derives an independent stream from the *seed path*, not from
 * the parent's consumed state. Consequence: adding a slot or scalar to a
 * species does not perturb the random numbers used by every other slot.
 */
export interface Rng {
  readonly seed: string;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  chance(p: number): boolean;
  /** Weighted pick; undefined if there are no items or all weights are <= 0. */
  weighted<T>(items: readonly T[], weight: (t: T) => number): T | undefined;
  /** Fisher-Yates on a copy. */
  shuffle<T>(items: readonly T[]): T[];
  fork(label: string): Rng;
}

function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h2 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h3 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function createRng(seed: string | number): Rng {
  const s = String(seed);
  const gen = sfc32(...cyrb128(s));
  for (let i = 0; i < 15; i++) gen(); // warm-up

  const rng: Rng = {
    seed: s,
    next: gen,
    int: (n) => Math.floor(gen() * n),
    chance: (p) => (p <= 0 ? false : p >= 1 ? true : gen() < p),
    weighted<T>(items: readonly T[], weight: (t: T) => number): T | undefined {
      let total = 0;
      for (const it of items) total += Math.max(0, weight(it));
      if (!(total > 0)) return undefined;
      let r = gen() * total;
      for (const it of items) {
        const w = Math.max(0, weight(it));
        if (w <= 0) continue;
        if (r < w) return it;
        r -= w;
      }
      // Floating-point edge: return the last positive-weight item.
      for (let i = items.length - 1; i >= 0; i--) if (weight(items[i]!) > 0) return items[i];
      return undefined;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const a = items.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(gen() * (i + 1));
        [a[i], a[j]] = [a[j]!, a[i]!];
      }
      return a;
    },
    fork: (label) => createRng(`${s}/${label}`),
  };
  return rng;
}
