// Orchestration for `agent-metrics-cognitive-debt`: select one commit per git input, hash the
// non-git inputs, walk the release chain, compute M1 / M2 / ack / coverage, emit M3 as
// not_computed, apply min_cell, and write the JCS bytes. Exit codes: 0 written, 1 input/runtime
// failure, 2 usage error, 3 M3 computed path required but not implemented (phase 2).

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeAck } from "./ack.js";
import { CognitiveDebtArgError, HELP_TEXT, parseCognitiveDebtArgs } from "./args.js";
import { loadAllEstimates, releaseMissingCounts, resolveChain } from "./chain.js";
import {
  CognitiveDebtInputError,
  buildInputs,
  hashDirJson,
  hashFile,
  parseAckComposite,
  parseLaneEvidence,
  parseReleaseIds,
  selectCommit,
} from "./inputs.js";
import { NonWellFormedStringError, serializeOutput } from "./jcs.js";
import { computeM1 } from "./m1.js";
import { buildM2Units, computeM2 } from "./m2.js";
import { M3_NOT_COMPUTED, m3Mode } from "./m3.js";
import { buildReport } from "./report.js";
import { assertSupportedSchema } from "./schema-check.js";
import { missingEntry } from "./stats.js";
import { applyMinCell, emptySuppressed } from "./suppress.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** dist/src/cognitive-debt -> dist/test/contract/vendor/release-evidence (copied there by
 * scripts/copy-test-assets.mjs on every build). */
export const DEFAULT_VENDOR_DIR = path.join(
  HERE,
  "..",
  "..",
  "test",
  "contract",
  "vendor",
  "release-evidence",
);

export interface RunIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** dist/src/cognitive-debt -> dist/test/contract/vendor/release-approval/v0 (same copy step). */
export const DEFAULT_RELEASE_APPROVAL_DIR = path.join(
  HERE,
  "..",
  "..",
  "test",
  "contract",
  "vendor",
  "release-approval",
  "v0",
);

export interface RunOverrides {
  /** Directory holding the vendored shadow-evaluation*.schema.json pin. */
  readonly vendorDir?: string;
}

/** The `kind` enum of the vendored release-approval/v0 event schema (ack `by_kind` keys). */
function loadApprovalKinds(dir: string): ReadonlySet<string> {
  const schema = JSON.parse(
    readFileSync(path.join(dir, "release-approval-event.schema.json"), "utf-8"),
  );
  const kinds = schema?.properties?.kind?.enum;
  if (!Array.isArray(kinds) || !kinds.every((k) => typeof k === "string")) {
    throw new Error("release-approval-event.schema.json: properties.kind.enum is not a string[]");
  }
  return new Set(kinds);
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(HERE, "..", "..", "..", "package.json"), "utf-8"));
  return String(pkg.version);
}

function loadVendoredSchema(vendorDir: string, file: string): unknown {
  const schema = JSON.parse(readFileSync(path.join(vendorDir, file), "utf-8"));
  assertSupportedSchema(schema);
  return schema;
}

export async function runCognitiveDebt(
  argv: readonly string[],
  io: RunIo,
  overrides: RunOverrides = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseCognitiveDebtArgs>;
  try {
    parsed = parseCognitiveDebtArgs(argv);
  } catch (err) {
    if (err instanceof CognitiveDebtArgError) {
      io.stderr(`agent-metrics-cognitive-debt: ${err.message}`);
      return 2;
    }
    throw err;
  }
  if (parsed.help) {
    io.stdout(HELP_TEXT);
    return 0;
  }
  const opts = parsed;

  try {
    const vendorDir = overrides.vendorDir ?? DEFAULT_VENDOR_DIR;
    loadVendoredSchema(vendorDir, "shadow-evaluation-input-v0.schema.json");
    const evaluationSchema = loadVendoredSchema(vendorDir, "shadow-evaluation-v0.schema.json");
    if (m3Mode(evaluationSchema) === "computed") {
      io.stderr("cognitive-debt: m3 computed path not implemented (phase 2)");
      return 3;
    }

    const approvalKinds = loadApprovalKinds(DEFAULT_RELEASE_APPROVAL_DIR);
    const asOfAt = opts.asOfAt;
    const [ledgerCommit, laneCommit, corpusCommit, evaluationsCommit] = await Promise.all([
      selectCommit(opts.releaseLedger, asOfAt),
      selectCommit(opts.laneRepo, asOfAt),
      selectCommit(opts.explanations, asOfAt),
      selectCommit(opts.evaluations, asOfAt),
    ]);
    const releaseIdsFile = await hashFile(opts.releaseIds);
    const ackFile = await hashFile(opts.ack);
    const laneEvidenceFiles = await hashDirJson(opts.laneEvidence);
    const releaseIds = parseReleaseIds(releaseIdsFile);
    const composite = parseAckComposite(ackFile);
    const laneEvidence = parseLaneEvidence(laneEvidenceFiles);

    const chain = await resolveChain({
      releaseIds,
      ledgerRepo: opts.releaseLedger,
      ledgerCommit: ledgerCommit?.sha ?? null,
      ledgerPath: opts.ledgerPath,
      bundlesDir: opts.bundlesDir,
      laneRepo: opts.laneRepo,
      laneCommit: laneCommit?.sha ?? null,
      laneEvidence,
    });

    const estimates = await loadAllEstimates(opts.laneRepo, laneCommit?.sha ?? null);
    const m1 = await computeM1(opts.explanations, corpusCommit, asOfAt, estimates);
    const units = await buildM2Units(chain.resolved, opts.laneRepo, laneCommit?.sha ?? null);
    const m2 = computeM2(units, chain.resolved, opts.detail);
    const ack = computeAck(chain.resolved, composite, approvalKinds, m1.everSeen, m1.presentAtAsOf);

    const suppressed = emptySuppressed();
    const m1Out = {
      ...m1.output,
      by_risk_class: applyMinCell("m1", "by_risk_class", "episode", m1.rows, suppressed),
    };
    const m2Out = {
      ...m2.output,
      by_risk_class: applyMinCell("m2", "by_risk_class", "release_lane", m2.rows, suppressed),
    };
    const ackOut = {
      ...ack.ack,
      by_release: applyMinCell("ack", "by_release", "approval", ack.rows, suppressed),
    };

    const noCommit = [ledgerCommit, laneCommit, corpusCommit, evaluationsCommit].filter(
      (c) => c === null,
    ).length;
    const missing = {
      ...Object.fromEntries(
        Object.entries(releaseMissingCounts(chain.releases)).map(([k, n]) => [
          k,
          missingEntry(n, "release"),
        ]),
      ),
      no_commit_at_as_of: missingEntry(noCommit, "repo"),
    };

    const inputs = buildInputs(
      [
        { kind: "evaluations", repo: opts.evaluations, commit: evaluationsCommit?.sha ?? null },
        { kind: "explanations", repo: opts.explanations, commit: corpusCommit?.sha ?? null },
        { kind: "lane_estimates", repo: opts.laneRepo, commit: laneCommit?.sha ?? null },
        {
          kind: "release_ledger",
          repo: opts.releaseLedger,
          commit: ledgerCommit?.sha ?? null,
          ledger_path: opts.ledgerPath,
          bundles_dir: opts.bundlesDir,
        },
      ],
      [
        { kind: "ack_composite", dir: null, files: [ackFile] },
        { kind: "lane_evidence", dir: opts.laneEvidence, files: laneEvidenceFiles },
        { kind: "release_ids", dir: null, files: [releaseIdsFile], count: releaseIds.length },
      ],
    );

    const report = buildReport({
      asOf: opts.asOf,
      version: packageVersion(),
      detail: opts.detail,
      inputs,
      population: {
        requested_releases: releaseIds.length,
        resolved_releases: chain.resolved.length,
      },
      m1: m1Out,
      m2: m2Out,
      m3: { ...M3_NOT_COMPUTED },
      ack: ackOut,
      coverage: ack.coverage,
      missing,
      suppressedRows: suppressed,
    });
    await writeFile(opts.out, serializeOutput(report));
    io.stderr(
      `agent-metrics-cognitive-debt: wrote ${opts.out} (releases=${releaseIds.length} ` +
        `resolved=${chain.resolved.length} m3=not_computed)`,
    );
    return 0;
  } catch (err) {
    if (err instanceof CognitiveDebtInputError || err instanceof NonWellFormedStringError) {
      io.stderr(`agent-metrics-cognitive-debt: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
