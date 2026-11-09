# Vendored from release-evidence

The two JSON Schema files in this directory are the shadow evaluator's in-memory schema
constants, written out as JSON. They are pinned here so `agent-metrics-cognitive-debt`
(`src/cognitive-debt/`) can decide the M3 status from a fixed upstream definition
(cognitive-debt-metrics/v0 design, section 1 "schema 検証" and r10: M3 is `computed` when
`properties` of `shadow-evaluation-v0.schema.json` has `input_digest`, `not_computed` otherwise).

- Upstream repository: `release-evidence`
- Upstream commit: `93cf28387f2f81d3574bb6e99a6614c9c4545f24` (main, merge of release-evidence#8). The schemas and
  golden pairs were generated at its second parent `63ee7bdf4b577d0806440eb6829a63fd236cede7`; the two commits have
  the same tree (`git diff --quiet 63ee7bd 93cf283` exits 0), so the outputs are identical.
- Upstream path: `src/shadow/input.ts`
- Exports:
  - `SHADOW_EVALUATION_INPUT_SCHEMA_V0` -> `shadow-evaluation-input-v0.schema.json`
  - `SHADOW_EVALUATION_SCHEMA_V0` -> `shadow-evaluation-v0.schema.json`
- Method: not hand-copied. The upstream build output `dist/src/shadow/input.js` (built at the
  commit above) was imported with `node --input-type=module -e` and each constant written as
  `JSON.stringify(value, null, 2) + "\n"`. Against the previous pin (`616f6d9`) the only change
  is the wrapper's `input_digest` (`properties.input_digest` and `required`).

## golden/ (M3 digest parity)

`golden/<name>/input.json` + `golden/<name>/evaluation.json` are evaluation pairs the upstream
CLI wrote at the commit above. `evaluation.json` is the upstream bytes as written by
`--out`; test/contract/m3-golden.test.ts checks that the harvester's own recomputation of
`record_digest`, `input_digest` and `input_manifest.digest` equals them.

| name | input.json | evaluation_status |
|---|---|---|
| `lane-backed` | copy of upstream `test/fixtures/replay-packs/lane-backed/input.json` | evaluated (receipt `abstained`) |
| `lane-ref-omitted` | copy of upstream `test/fixtures/replay-packs/lane-ref-omitted/input.json` | evaluated (receipt `abstained`) |
| `lane-backed-records-reversed` | `lane-backed` with `records[]` reversed | evaluated |
| `unknown-selection-manifest-unresolved` | `lane-backed` without the `selection_manifest` record | unknown |
| `invalid-input-digest-mismatch` | `lane-backed` with `records[2].digest` = `sha256:` + 64 x `0` | invalid_input |

The three derived inputs were written on the harvester side (never in the upstream checkout) as
`JSON.stringify(value, null, 2) + "\n"` of the parsed `lane-backed` input with the one change
listed above. Each `evaluation.json` was then produced with (`$U` = the upstream checkout at the
commit above, built; `$G` = this `golden/` directory):

```bash
node "$U/dist/src/shadow-cli/main.js" replay --input "$G/<name>/input.json" --out "$G/<name>/evaluation.json"
```

(`invalid-input-digest-mismatch` exits 2 by design -- `evaluation_status: "invalid_input"` -- after
writing `--out`.)

Do not hand-edit anything in this directory. On a re-pin, re-export both schema files and
re-run the commands above from the new upstream commit, then update the commit above.
