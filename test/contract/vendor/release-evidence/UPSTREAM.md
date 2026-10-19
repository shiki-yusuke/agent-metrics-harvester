# Vendored from release-evidence

The two JSON Schema files in this directory are the shadow evaluator's in-memory schema
constants, written out as JSON. They are pinned here so `agent-metrics-cognitive-debt`
(`src/cognitive-debt/`) can decide the M3 status from a fixed upstream definition
(cognitive-debt-metrics/v0 design, section 1 "schema 検証" and r10: M3 stays `not_computed`
while `properties` of `shadow-evaluation-v0.schema.json` has no `input_digest`).

- Upstream repository: `release-evidence`
- Upstream commit: `616f6d9319498c17ac5cc9e2041f778102507092`
- Upstream path: `src/shadow/input.ts`
- Exports:
  - `SHADOW_EVALUATION_INPUT_SCHEMA_V0` -> `shadow-evaluation-input-v0.schema.json`
  - `SHADOW_EVALUATION_SCHEMA_V0` -> `shadow-evaluation-v0.schema.json`
- Method: not hand-copied. The upstream build output `dist/src/shadow/input.js` (built after the
  last commit touching `src/shadow/`, `253a06a`) was imported with `node --input-type=module -e`
  and each constant written as `JSON.stringify(value, null, 2) + "\n"`.

Do not hand-edit anything in this directory. When upstream adds `input_digest` to the
shadow-evaluation/v0 wrapper, re-export both files from the new upstream commit and update the
commit above; the M3 `computed` path (phase 2) is what reads them then.
