// M3: abstain reasons over shadow evaluation records (cognitive-debt-metrics/v0 design 2.3).
//
// The switch is the vendored shadow-evaluation/v0 schema (test/contract/vendor/release-evidence/):
// while its `properties` has no `input_digest`, no evaluation pair can be bound to its input
// (design section 1, r9/r10), so M3 reads no pair at all and every field except `status` /
// `reason` is null (`M3_NOT_COMPUTED`). When the pin declares `input_digest`, `computeM3` reads
// the evaluation pairs `shadow-evaluations/<name>/{input,evaluation}.json` from the selected
// evaluations commit, attributes each dir to a resolved release through
// `input.json.subject.bundle_digest`, applies the fixed check order of design section 1 (first
// failing code only), and aggregates the valid pairs (design 2.3).

import { type CommitDate, logFirstParentForPath, lsTree, showFile } from "./git.js";
import { isRecord, parseJson } from "./inputs.js";
import { byteCompare, canonicalize, sha256Hex } from "./jcs.js";
import { checkSchema, declaresInputDigest } from "./schema-check.js";
import { missingEntry } from "./stats.js";
import { parseUtcTimestamp } from "./time.js";

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

/** release-evidence `UNKNOWN_REASON_CODES` (src/shadow/reasons.ts), transcribed. Fixed here on
 * purpose (spec B6): an upstream re-pin that adds a code does not change the output shape; the new
 * code is counted under `other:<code>`. test/contract checks this set is contained in the vendored
 * schema enums. */
export const UNKNOWN_REASON_CODES = [
  "unknown_structural",
  "not_yet_recorded",
  "lane_ref_omitted",
  "referent_unresolved",
  "not_applicable_by_policy",
] as const;

/** release-evidence `INPUT_ERROR_CODES` (src/shadow/reasons.ts), transcribed (see above). */
export const INPUT_ERROR_CODES = [
  "record_invalid",
  "digest_mismatch",
  "unsupported_record_version",
] as const;

export const EVALUATION_STATUSES = ["evaluated", "unknown", "invalid_input"] as const;

const NOT_APPLICABLE_BY_POLICY = "not_applicable_by_policy";

/** Per-pair `missing` codes in the fixed check order of design section 1 (spec B5). A pair counts
 * only the first one it fails. */
export const PAIR_MISSING_CODES = [
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
] as const;
export type PairMissingCode = (typeof PAIR_MISSING_CODES)[number];

export const EVALUATIONS_DIR = "shadow-evaluations";
const INPUT_FILE = "input.json";
const EVALUATION_FILE = "evaluation.json";

/** The wrapper fields M3 aggregates (a schema-valid shadow-evaluation/v0 record has them all). */
export interface M3Evaluation {
  readonly evaluation_cut: string;
  readonly evaluation_status: string;
  readonly unknown_reasons: readonly { readonly code: string }[];
  readonly input_errors: readonly { readonly code: string }[];
  readonly predicate_observations: readonly {
    readonly predicate_id: string;
    readonly status: string;
    readonly reason?: { readonly code: string };
  }[];
  readonly candidate_receipt: { readonly verdict: string } | null;
}

export interface M3Schemas {
  /** Vendored shadow-evaluation-input/v0 schema, as is. */
  readonly input: object;
  /** Vendored shadow-evaluation/v0 schema with `input_digest` out of `required`
   * (schema-check.ts `withoutRequiredInputDigest`, design r10). */
  readonly evaluation: object;
}

export type PairVerdict =
  | { readonly code: PairMissingCode }
  | { readonly code: null; readonly evaluation: M3Evaluation };

/** "sha256:" + hex(sha256(JCS(value))), or null when JCS cannot represent the value (a lone
 * surrogate, or a number JSON.parse turned into Infinity). A digest that cannot be computed is
 * treated as one that does not match. */
function tryDigest(value: unknown): string | null {
  try {
    return `sha256:${sha256Hex(canonicalize(value))}`;
  } catch {
    return null;
  }
}

/** release-evidence `computeInputManifestDigest`: refs sorted by (kind, digest) in UTF-16 code
 * unit order (plain `<`), then "sha256:" + hex(sha256(JCS(sorted refs))). Re-implemented, not
 * imported (spec B2); test/contract compares it with upstream's own output. */
export function inputManifestDigest(
  refs: readonly { readonly kind: string; readonly digest: string }[],
): string | null {
  const sorted = refs
    .map((r) => ({ kind: r.kind, digest: r.digest }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      if (a.digest === b.digest) return 0;
      return a.digest < b.digest ? -1 : 1;
    });
  return tryDigest(sorted);
}

/** release-evidence `computeRecordDigest`: the wrapper without its own `record_digest`. */
export function recordDigest(record: Record<string, unknown>): string | null {
  const { record_digest: _self, ...rest } = record;
  return tryDigest(rest);
}

/** Design section 1: `"sha256:" + hex(sha256(JCS(input.json)))` over JSON.parse of the bytes. */
export function inputDigest(inputBytes: Buffer): string | null {
  const parsed = parseJson(inputBytes);
  return parsed === undefined ? null : tryDigest(parsed);
}

const refKey = (r: { kind: unknown; digest: unknown }): string =>
  canonicalize([String(r.kind), String(r.digest)]);

/**
 * Checks one attributed pair in the fixed order of design section 1 and returns the first failing
 * code, or the wrapper when the pair is valid for the population. `input` is the parsed
 * input.json (already known to carry a string `subject.bundle_digest`); `isBound` runs the git
 * commit-binding check and is only called once every earlier step has passed.
 */
export async function classifyPair(
  pair: {
    readonly input: Record<string, unknown>;
    readonly inputBytes: Buffer;
    readonly evaluationBytes: Buffer | null;
  },
  schemas: M3Schemas,
  isBound: () => Promise<boolean>,
): Promise<PairVerdict> {
  if (pair.evaluationBytes === null) return { code: "no_evaluation_output" };
  const input = pair.input;
  if (checkSchema(schemas.input, input).length > 0) {
    return { code: "evaluation_input_invalid_shape" };
  }
  const parsed = parseJson(pair.evaluationBytes);
  if (parsed === undefined || checkSchema(schemas.evaluation, parsed).length > 0) {
    return { code: "evaluation_invalid_shape" };
  }
  const evaluation = parsed as Record<string, unknown>;
  const storedRecordDigest = recordDigest(evaluation);
  if (storedRecordDigest === null || storedRecordDigest !== evaluation.record_digest) {
    return { code: "evaluation_record_digest_mismatch" };
  }
  if (!Object.hasOwn(evaluation, "input_digest")) {
    return { code: "evaluation_input_digest_absent" };
  }
  const recomputedInputDigest = inputDigest(pair.inputBytes);
  if (recomputedInputDigest === null || recomputedInputDigest !== evaluation.input_digest) {
    return { code: "evaluation_input_digest_mismatch" };
  }
  if (!(await isBound())) return { code: "evaluation_pair_unbound" };

  // From here both documents passed their schema, so the fields below exist with these types.
  const inputCut = input.evaluation_cut as string;
  const evaluationCut = evaluation.evaluation_cut as string;
  if (evaluationCut !== inputCut) return { code: "evaluation_cut_mismatch" };
  const evaluator = evaluation.evaluator as Record<string, unknown>;
  const contractPin = input.contract_pin as Record<string, unknown>;
  if (evaluator.playbook_contract_commit !== contractPin.playbook_commit) {
    return { code: "contract_pin_mismatch" };
  }
  const manifest = evaluation.input_manifest as Record<string, unknown>;
  const manifestRecords = manifest.records as { kind: string; digest: string }[];
  const recomputedManifest = inputManifestDigest(manifestRecords);
  if (recomputedManifest === null || recomputedManifest !== manifest.digest) {
    return { code: "input_manifest_digest_mismatch" };
  }
  const inputRefs = new Set(
    (input.records as { kind: unknown; digest: unknown }[]).map((r) => refKey(r)),
  );
  if (!manifestRecords.every((r) => inputRefs.has(refKey(r)))) {
    return { code: "evaluation_manifest_not_subset" };
  }
  const receipt = evaluation.candidate_receipt;
  if (receipt !== null) {
    const receiptSubject = (receipt as Record<string, unknown>).subject as Record<string, unknown>;
    const inputSubject = input.subject as Record<string, unknown>;
    for (const field of ["bundle_digest", "selection_manifest_digest", "target"]) {
      if (receiptSubject[field] !== inputSubject[field]) {
        return { code: "evaluation_subject_mismatch" };
      }
    }
  }
  if (parseUtcTimestamp(evaluationCut) === null) return { code: "evaluation_cut_invalid" };
  return { code: null, evaluation: evaluation as unknown as M3Evaluation };
}

// ---------------------------------------------------------------------------
// aggregation (design 2.3, spec B6)
// ---------------------------------------------------------------------------

function normalizeCode(code: string, closed: readonly string[]): string {
  return closed.includes(code) ? code : `other:${code}`;
}

/** A null-prototype object (a code or predicate_id key such as `__proto__` stays an own key,
 * docs/cognitive-debt-decisions.md #39). */
function nullProto<T>(): Record<string, T> {
  return Object.create(null);
}

function zeroFilled(closed: readonly string[]): Record<string, number> {
  const out = nullProto<number>();
  for (const code of closed) out[code] = 0;
  return out;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (Object.hasOwn(map, key) ? (map[key] as number) : 0) + 1;
}

/** The 6-key row shared by the top level and each `by_month` value (design 2.3, r13). */
export interface M3Row {
  evaluation_status: Record<string, number>;
  by_code_evaluation: { unknown: Record<string, number>; input_error: Record<string, number> };
  by_predicate: Record<string, Record<string, number>>;
  not_applicable: Record<string, number>;
  abstained: number;
  no_candidate_receipt: number;
}

function emptyRow(): M3Row {
  return {
    evaluation_status: zeroFilled(EVALUATION_STATUSES),
    by_code_evaluation: {
      unknown: zeroFilled(UNKNOWN_REASON_CODES),
      input_error: zeroFilled(INPUT_ERROR_CODES),
    },
    by_predicate: nullProto<Record<string, number>>(),
    not_applicable: nullProto<number>(),
    abstained: 0,
    no_candidate_receipt: 0,
  };
}

function addToRow(row: M3Row, e: M3Evaluation): void {
  // A status outside the closed three cannot pass the schema; it is not given a key.
  if (Object.hasOwn(row.evaluation_status, e.evaluation_status)) {
    bump(row.evaluation_status, e.evaluation_status);
  }
  for (const r of e.unknown_reasons) {
    bump(row.by_code_evaluation.unknown, normalizeCode(r.code, UNKNOWN_REASON_CODES));
  }
  for (const r of e.input_errors) {
    bump(row.by_code_evaluation.input_error, normalizeCode(r.code, INPUT_ERROR_CODES));
  }
  for (const o of e.predicate_observations) {
    if (o.status !== "unknown") continue;
    const code = o.reason?.code;
    if (code === NOT_APPLICABLE_BY_POLICY) {
      bump(row.not_applicable, o.predicate_id);
      continue;
    }
    if (typeof code !== "string") continue;
    if (!Object.hasOwn(row.by_predicate, o.predicate_id)) {
      row.by_predicate[o.predicate_id] = nullProto<number>();
    }
    bump(
      row.by_predicate[o.predicate_id] as Record<string, number>,
      normalizeCode(code, UNKNOWN_REASON_CODES),
    );
  }
  if (e.candidate_receipt === null) row.no_candidate_receipt++;
  else if (e.candidate_receipt.verdict === "abstained") row.abstained++;
}

/** Aggregates valid evaluations into the top-level 6-key row and one row per UTC calendar month
 * of `evaluation_cut` (`YYYY-MM`, the first 7 characters of a time `parseUtcTimestamp` accepted),
 * each month carrying its evaluation count for min_cell. */
export function aggregateM3(evaluations: readonly M3Evaluation[]): {
  overall: M3Row;
  months: Map<string, { units: number; row: Record<string, unknown> }>;
} {
  const overall = emptyRow();
  const monthRows = new Map<string, { units: number; row: M3Row }>();
  for (const e of evaluations) {
    addToRow(overall, e);
    const month = e.evaluation_cut.slice(0, 7);
    const entry = monthRows.get(month) ?? { units: 0, row: emptyRow() };
    entry.units++;
    addToRow(entry.row, e);
    monthRows.set(month, entry);
  }
  const months = new Map<string, { units: number; row: Record<string, unknown> }>();
  for (const key of [...monthRows.keys()].sort()) {
    const { units, row } = monthRows.get(key) as { units: number; row: M3Row };
    months.set(key, { units, row: { ...row } });
  }
  return { overall, months };
}

// ---------------------------------------------------------------------------
// pair enumeration, attribution, binding (spec B5)
// ---------------------------------------------------------------------------

interface PairDir {
  readonly name: string;
  readonly hasInput: boolean;
  readonly hasEvaluation: boolean;
}

/** Direct children `shadow-evaluations/<name>/` holding `input.json` or `evaluation.json` directly
 * (spec B5). Dirs with only other files, and anything nested deeper, are not candidates. */
async function listPairDirs(repo: string, commit: string): Promise<PairDir[]> {
  const entries = await lsTree(repo, commit, `${EVALUATIONS_DIR}/`, true);
  const dirs = new Map<string, { hasInput: boolean; hasEvaluation: boolean }>();
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const parts = entry.path.split("/");
    if (parts.length !== 3 || parts[0] !== EVALUATIONS_DIR) continue;
    const [, name, file] = parts as [string, string, string];
    if (file !== INPUT_FILE && file !== EVALUATION_FILE) continue;
    const d = dirs.get(name) ?? { hasInput: false, hasEvaluation: false };
    if (file === INPUT_FILE) d.hasInput = true;
    else d.hasEvaluation = true;
    dirs.set(name, d);
  }
  return [...dirs.entries()]
    .sort(([a], [b]) => byteCompare(a, b))
    .map(([name, d]) => ({ name, ...d }));
}

/** Design section 1 "評価ペアの束縛": `git log --first-parent --diff-filter=A <selected> -- <path>`
 * is exactly one line for both files and names the same commit, and the newest
 * `git log --first-parent <selected> -- <path>` commit of both files is that commit. */
async function isPairBound(repo: string, commit: string, dir: string): Promise<boolean> {
  const opts = { literalPathspec: true } as const;
  const paths = [`${dir}/${INPUT_FILE}`, `${dir}/${EVALUATION_FILE}`];
  const added: CommitDate[][] = [];
  const latest: CommitDate[][] = [];
  for (const p of paths) {
    added.push(await logFirstParentForPath(repo, commit, p, { ...opts, diffFilter: "A" }));
    latest.push(await logFirstParentForPath(repo, commit, p, opts));
  }
  const [addedInput, addedEvaluation] = added as [CommitDate[], CommitDate[]];
  if (addedInput.length !== 1 || addedEvaluation.length !== 1) return false;
  const introduced = (addedInput[0] as CommitDate).sha;
  if ((addedEvaluation[0] as CommitDate).sha !== introduced) return false;
  return latest.every((log) => log[0]?.sha === introduced);
}

/** The bundle_digest of an input.json that can be attributed (spec B5 (i)/(ii)), or null for
 * (iii): bytes that do not parse, or no string `subject.bundle_digest`. */
function attributionDigest(input: unknown): string | null {
  if (!isRecord(input) || !isRecord(input.subject)) return null;
  const digest = input.subject.bundle_digest;
  return typeof digest === "string" ? digest : null;
}

export interface ResolvedRelease {
  readonly release_id: string;
  readonly bundle_digest: string | null;
}

export interface M3Computed {
  /** Every field of `m3_abstain_reasons` except `by_month`, which run.ts fills after min_cell. */
  readonly output: Record<string, unknown>;
  readonly months: Map<string, { units: number; row: Record<string, unknown> }>;
}

/**
 * The computed M3 (design 2.3). `commit` null = the evaluations repo has no commit at as_of: no
 * pair is read (git is never called), `population.evaluations` is 0, and every resolved release
 * is `no_evaluation` (the repo itself is counted by the caller's `no_commit_at_as_of`).
 */
export async function computeM3(args: {
  readonly repo: string;
  readonly commit: string | null;
  readonly resolved: readonly ResolvedRelease[];
  readonly schemas: M3Schemas;
}): Promise<M3Computed> {
  const releaseDigests = new Set(
    args.resolved.map((r) => r.bundle_digest).filter((d): d is string => d !== null),
  );
  const missing = new Map<PairMissingCode, number>(PAIR_MISSING_CODES.map((c) => [c, 0]));
  const attributedDigests = new Set<string>();
  const validDigests = new Set<string>();
  const valid: M3Evaluation[] = [];

  if (args.commit !== null) {
    const commit = args.commit;
    for (const dir of await listPairDirs(args.repo, commit)) {
      const base = `${EVALUATIONS_DIR}/${dir.name}`;
      if (!dir.hasInput) continue; // (iii): evaluation.json only
      const inputBytes = await showFile(args.repo, commit, `${base}/${INPUT_FILE}`);
      if (inputBytes === null) continue;
      const input = parseJson(inputBytes);
      const digest = attributionDigest(input);
      if (digest === null) continue; // (iii)
      if (!releaseDigests.has(digest)) continue; // (ii)
      attributedDigests.add(digest);
      const evaluationBytes = dir.hasEvaluation
        ? await showFile(args.repo, commit, `${base}/${EVALUATION_FILE}`)
        : null;
      const verdict = await classifyPair(
        { input: input as Record<string, unknown>, inputBytes, evaluationBytes },
        args.schemas,
        () => isPairBound(args.repo, commit, base),
      );
      if (verdict.code === null) {
        valid.push(verdict.evaluation);
        validDigests.add(digest);
      } else {
        missing.set(verdict.code, (missing.get(verdict.code) as number) + 1);
      }
    }
  }

  const releasesWith = (digests: ReadonlySet<string>): number =>
    args.resolved.filter((r) => r.bundle_digest !== null && digests.has(r.bundle_digest)).length;
  const { overall, months } = aggregateM3(valid);
  const missingOut: Record<string, { count: number; unit: string }> = {
    no_evaluation: missingEntry(args.resolved.length - releasesWith(attributedDigests), "release"),
  };
  for (const code of PAIR_MISSING_CODES) {
    missingOut[code] = missingEntry(missing.get(code) as number, "evaluation_pair");
  }
  return {
    output: {
      status: "computed",
      reason: null,
      population: {
        resolved_releases: args.resolved.length,
        evaluated_releases: releasesWith(validDigests),
        evaluations: valid.length,
      },
      missing: missingOut,
      ...overall,
    },
    months,
  };
}
