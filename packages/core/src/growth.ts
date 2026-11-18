import type { ScalarDef } from "./types";

/**
 * Fraction of the adult value at `age`, from the scalar's growth curve:
 * piecewise linear between `[age, factor]` points, flat before the first and
 * after the last. No curve (or an empty one) means 1. Points need not be
 * sorted; two points at the same age make a step, never a division by zero.
 */
export function growthFactor(def: Pick<ScalarDef, "growth">, age: number): number {
  const pts = def.growth;
  if (!pts || pts.length === 0) return 1;
  const sorted = [...pts].sort((a, b) => a[0] - b[0]);
  const first = sorted[0]!, last = sorted[sorted.length - 1]!;
  if (age <= first[0]) return first[1];
  if (age >= last[0]) return last[1];
  for (let i = 1; i < sorted.length; i++) {
    const [x0, y0] = sorted[i - 1]!;
    const [x1, y1] = sorted[i]!;
    // Reaching this segment means age > x0 (an earlier segment would have matched),
    // and age <= x1, so x1 > x0: a repeated age is a step and never divides by zero.
    if (age <= x1) return y0 + ((y1 - y0) * (age - x0)) / (x1 - x0);
  }
  return last[1];
}
