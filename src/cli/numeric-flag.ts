// Shared numeric-flag parser for any CLI flag that feeds a bounded-run safety valve
// (--max-api-requests / --rate-limit-floor / --max-runtime-seconds / --overlap-seconds /
// --max-pages-per-fetch / --lookback-days / --min-sample-size, across both the harvest and
// report binaries). `Number.parseInt` alone silently turns "abc" or "" into `NaN` and accepts
// negative numbers and decimals (truncating "1.5" to 1); none of the flags above have a
// sensible negative, decimal, or non-numeric value, and a silently-NaN safety valve fails
// *open* -- `NaN >= NaN` and every other comparison against it is `false`, so a typo'd flag
// value disables the safety valve instead of rejecting the run. Originally added for the
// report CLI (`agent-metrics-report cost-per-pr`, see report-args.ts) and extracted here so the
// harvest CLI's own numeric flags (args.ts) get the same fail-closed behavior.

/** Parses `value` as a non-negative integer, or throws `new ErrorCtor(message)` if it is not
 * one -- e.g. "abc", "", "-1", "1.5". Each call site supplies its own error type (`CliArgError`
 * for the harvest CLI, `ReportArgError` for the report CLI) so callers keep a single error type
 * per binary; this function only shares the validation logic itself. */
export function parseNonNegativeIntFlag<E extends Error>(
  value: string,
  flag: string,
  ErrorCtor: new (message: string) => E,
): number {
  if (!/^\d+$/.test(value)) {
    throw new ErrorCtor(`${flag} must be a non-negative integer, got "${value}"`);
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new ErrorCtor(`${flag} must be a non-negative integer, got "${value}"`);
  }
  return n;
}
