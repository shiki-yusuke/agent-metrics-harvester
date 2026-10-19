// Small numeric helpers shared by the cognitive-debt metrics.

export interface Quantiles {
  readonly p50: number;
  readonly p90: number;
  readonly max: number;
}

/** Nearest-rank p50 / p90 / max (design section 2.1); null for an empty sample. */
export function nearestRank(values: readonly number[]): Quantiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1] as number;
  return { p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] as number };
}

/** numerator / denominator truncated to 2 decimals, computed on integers so a float product
 * can never drop a hundredth; null when the denominator is 0 (design: "分母 0 は null"). */
export function ratio2(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.floor((numerator * 100) / denominator) / 100;
}

/** Elapsed days between two instants given in whole epoch seconds: seconds / 86400, truncated to
 * 2 decimals (design section 2.1). Fractions of a second are not counted
 * (docs/cognitive-debt-decisions.md #35). Callers handle end < start themselves. */
export function elapsedDays(startSec: number, endSec: number): number {
  return Math.floor(((endSec - startSec) * 100) / 86400) / 100;
}

/** `{count, unit}` -- the shape of every `missing.*` entry (the unit is always written out). */
export function missingEntry(count: number, unit: string): { count: number; unit: string } {
  return { count, unit };
}
