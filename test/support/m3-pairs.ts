// Synthetic shadow evaluation pairs for the M3 computed path (spec B7). Every pair starts from a
// golden pair that upstream `release-evidence-shadow replay` actually wrote
// (test/contract/vendor/release-evidence/golden/), is re-pointed at a fixture release, and then
// gets its digests recomputed with the harvester's own JCS (design section 4: "record_digest /
// input_manifest.digest は実装の JCS で再計算して埋める"). Hooks let a test break one link at a
// precise stage of that recomputation.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jcsDigest } from "../../src/cognitive-debt/jcs.js";
import { inputManifestDigest, recordDigest } from "../../src/cognitive-debt/m3.js";
import { type CommitSpec, type FileContent, baseSpec, bundle } from "./cognitive-debt-fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.join(HERE, "..", "contract", "vendor", "release-evidence", "golden");

/** Golden pair per evaluation_status. */
export const TEMPLATES = {
  evaluated: "lane-backed",
  unknown: "unknown-selection-manifest-unresolved",
  invalid_input: "invalid-input-digest-mismatch",
} as const;
export type Template = keyof typeof TEMPLATES;

// biome-ignore lint/suspicious/noExplicitAny: JSON documents under construction
export type Json = any;

export function loadGolden(name: string): { inputBytes: Buffer; input: Json; evaluation: Json } {
  const inputBytes = readFileSync(path.join(GOLDEN_DIR, name, "input.json"));
  const evaluation = JSON.parse(
    readFileSync(path.join(GOLDEN_DIR, name, "evaluation.json"), "utf-8"),
  );
  return { inputBytes, input: JSON.parse(inputBytes.toString("utf-8")), evaluation };
}

/** Bundle digests of the baseSpec releases that resolve (R3 has no release event). */
export const R1_DIGEST = jcsDigest(bundle("R1", "L-1"));
export const R2_DIGEST = jcsDigest(bundle("R2", null));
export const OTHER_DIGEST = `sha256:${"e".repeat(64)}`;
export const WRONG_DIGEST = `sha256:${"f".repeat(64)}`;

export interface PairOptions {
  /** input.subject.bundle_digest (and the receipt subject's, when there is a receipt). */
  readonly bundleDigest: string;
  /** evaluation_cut written to both input and wrapper. */
  readonly cut?: string;
  /** candidate_receipt.verdict override (evaluated template only). */
  readonly verdict?: string;
  /** Before any digest is computed. */
  readonly mutateInput?: (input: Json) => void;
  readonly mutateEvaluation?: (evaluation: Json) => void;
  /** After input_manifest.digest and input_digest, before record_digest. */
  readonly afterInputDigest?: (evaluation: Json) => void;
  /** After record_digest (leaves it stale). */
  readonly afterRecordDigest?: (evaluation: Json) => void;
}

export interface Pair {
  readonly input: Json;
  readonly evaluation: Json;
}

export function makePair(template: Template, opts: PairOptions): Pair {
  const { input, evaluation } = loadGolden(TEMPLATES[template]);
  input.subject.bundle_digest = opts.bundleDigest;
  if (evaluation.candidate_receipt !== null) {
    evaluation.candidate_receipt.subject.bundle_digest = opts.bundleDigest;
    if (opts.verdict !== undefined) evaluation.candidate_receipt.verdict = opts.verdict;
  }
  if (opts.cut !== undefined) {
    input.evaluation_cut = opts.cut;
    evaluation.evaluation_cut = opts.cut;
  }
  opts.mutateInput?.(input);
  opts.mutateEvaluation?.(evaluation);
  evaluation.input_manifest.digest = inputManifestDigest(evaluation.input_manifest.records);
  evaluation.input_digest = jcsDigest(input);
  opts.afterInputDigest?.(evaluation);
  evaluation.record_digest = recordDigest(evaluation);
  opts.afterRecordDigest?.(evaluation);
  return { input, evaluation };
}

/** The two files of `shadow-evaluations/<name>/` (either may be left out or overridden). */
export function pairFiles(
  name: string,
  pair: Pair,
  which: { input?: FileContent | false; evaluation?: FileContent | false } = {},
): Record<string, FileContent> {
  const dir = `shadow-evaluations/${name}`;
  const files: Record<string, FileContent> = {};
  if (which.input !== false) files[`${dir}/input.json`] = which.input ?? pair.input;
  if (which.evaluation !== false) {
    files[`${dir}/evaluation.json`] = which.evaluation ?? pair.evaluation;
  }
  return files;
}

/** A valid evaluated pair for R2 -- the baseline most negative fixtures sit next to, so that
 * `no_evaluation` stays 0 whenever R1 has an attributed (even if invalid) pair. */
export function r2Valid(): Pair {
  return makePair("evaluated", { bundleDigest: R2_DIGEST, cut: "2026-01-20T00:00:00Z" });
}

export const EVAL_DATE = "2026-01-05T00:00:00Z";

/** baseSpec (as_of 2026-02-01; resolved releases R1 and R2) with the given evaluations history. */
export function m3Spec(evaluations: CommitSpec[]) {
  const spec = baseSpec();
  spec.evaluations = evaluations;
  return spec;
}

/** The 13 per-pair codes plus no_evaluation, every count 0 except those listed. */
export function expectedMissing(counts: Record<string, number> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    no_evaluation: { count: counts.no_evaluation ?? 0, unit: "release" },
  };
  for (const code of [
    "no_evaluation_output",
    "evaluation_input_invalid_shape",
    "evaluation_invalid_shape",
    "evaluation_record_digest_mismatch",
    "evaluation_input_digest_absent",
    "evaluation_input_digest_mismatch",
    "evaluation_pair_unbound",
    "evaluation_cut_mismatch",
    "contract_pin_mismatch",
    "input_manifest_digest_mismatch",
    "evaluation_manifest_not_subset",
    "evaluation_subject_mismatch",
    "evaluation_cut_invalid",
  ]) {
    out[code] = { count: counts[code] ?? 0, unit: "evaluation_pair" };
  }
  return out;
}

/** Spec B7 evaluation_cut boundaries (all match the schema regex). */
export const VALID_CUTS = [
  "2028-02-29T00:00:00Z",
  "2000-02-29T00:00:00Z",
  "2026-12-31T23:59:59Z",
  "2026-01-01T00:00:00Z",
  "2026-01-01T00:00:00.1Z",
  "2026-01-01T00:00:00.12Z",
  "2026-01-01T00:00:00.123Z",
  "2026-01-01T00:00:00.1234Z",
  "2026-01-01T00:00:00.123456789Z",
];
export const INVALID_CUTS = [
  "2026-02-30T00:00:00Z",
  "2027-02-29T00:00:00Z",
  "2100-02-29T00:00:00Z",
  "2026-00-10T00:00:00Z",
  "2026-01-00T00:00:00Z",
  "2026-13-10T00:00:00Z",
  "2026-01-10T24:00:00Z",
  "2026-01-10T00:60:00Z",
  "2026-01-10T00:00:60Z",
];
