// min_cell suppression of breakdown rows (cognitive-debt-metrics/v0 design section 0). The
// overall row is always written; a breakdown row whose unit count is below MIN_CELL is dropped
// and replaced by one `suppressed_rows["<metric>.<breakdown>.<key>"]` entry that never carries
// the count itself. Breakdown rows are objects keyed by risk_class / release_id / YYYY-MM.

export const MIN_CELL = 5;

export interface SuppressedRow {
  readonly reason: "min_cell";
  readonly unit: string;
  readonly n_lt: number;
}

/** An empty null-prototype `suppressed_rows` map for applyMinCell (decisions #39). */
export function emptySuppressed(): Record<string, SuppressedRow> {
  return Object.create(null);
}

export function applyMinCell(
  metric: string,
  breakdown: string,
  unit: string,
  rows: ReadonlyMap<string, { units: number; row: Record<string, unknown> }>,
  suppressed: Record<string, SuppressedRow>,
): Record<string, Record<string, unknown>> {
  // Null prototype: a key such as `__proto__` (a release_id) becomes an own property instead of
  // replacing the prototype and vanishing from the output (docs/cognitive-debt-decisions.md #39).
  const kept: Record<string, Record<string, unknown>> = Object.create(null);
  for (const [key, { units, row }] of rows) {
    if (units >= MIN_CELL) kept[key] = row;
    else suppressed[`${metric}.${breakdown}.${key}`] = { reason: "min_cell", unit, n_lt: MIN_CELL };
  }
  return kept;
}
