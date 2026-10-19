// M3: abstain reasons over shadow evaluation records (cognitive-debt-metrics/v0 design 2.3).
//
// Phase 1 implements only the `not_computed` output. The switch is the vendored
// shadow-evaluation/v0 schema (test/contract/vendor/release-evidence/): while its `properties`
// has no `input_digest`, no evaluation pair can be bound to its input (design section 1, r9/r10),
// so M3 reads no pair at all and every field except `status` / `reason` is null. When the pin
// does declare `input_digest`, the computed path is required and is not implemented yet -- the
// caller must stop (exit 3) rather than silently emit `not_computed`.

import { declaresInputDigest } from "./schema-check.js";

export const M3_NOT_COMPUTED = {
  status: "not_computed",
  reason: "awaiting_input_digest",
  population: null,
  missing: null,
  evaluation_status: null,
  by_code_evaluation: null,
  by_predicate: null,
  not_applicable: null,
  abstained: null,
  no_candidate_receipt: null,
  by_month: null,
} as const;

export type M3Mode = "not_computed" | "computed";

export function m3Mode(shadowEvaluationSchema: unknown): M3Mode {
  return declaresInputDigest(shadowEvaluationSchema) ? "computed" : "not_computed";
}
