// Flag parser for `agent-metrics-cognitive-debt` (cognitive-debt-metrics/v0 design section 4).
// Hand-rolled like src/cli/args.ts -- no argument-parsing dependency.

import { type UtcInstant, parseUtcTimestamp } from "./time.js";

export interface CognitiveDebtOptions {
  readonly releaseIds: string;
  readonly releaseLedger: string;
  readonly ack: string;
  readonly laneRepo: string;
  readonly laneEvidence: string;
  readonly explanations: string;
  readonly evaluations: string;
  readonly asOf: string;
  /** `asOf` parsed by time.ts `parseUtcTimestamp`. */
  readonly asOfAt: UtcInstant;
  readonly out: string;
  readonly detail: boolean;
  /** Ledger path inside the --release-ledger repo. */
  readonly ledgerPath: string;
  /** Bundle directory inside the --release-ledger repo (every `*.json` under it, recursively). */
  readonly bundlesDir: string;
}

export class CognitiveDebtArgError extends Error {}

export const HELP_TEXT = `usage: agent-metrics-cognitive-debt [flags]
       agent-metrics-harvester cognitive-debt [flags]

Writes one cognitive-debt-metrics/v0 JSON report (DRAFT, authority none) from recorded data only.

required:
  --release-ids <file>     JSON array of release ids (strings, or objects with "release_id")
  --release-ledger <repo>  release-evidence git repo (ledger + bundle files)
  --ack <composite.json>   cognitive-ack composite ({approval_events[], ack_records[]})
  --lane-repo <repo>       consumer git repo holding docs/spec/<lane_id>/estimate.json
  --lane-evidence <dir>    directory of lane-evidence:v1 *.json files
  --explanations <repo>    evidence-docs corpus git repo (explanations/EXP-*.json)
  --evaluations <repo>     git repo holding shadow-evaluations/<name>/{input,evaluation}.json
  --as-of <iso>            UTC timestamp, e.g. 2026-10-01T00:00:00Z
  --out <file>             output path (JCS bytes, no trailing newline)

optional:
  --detail                 include m2_prediction_error.detail[] (per release-lane path arrays)
  --ledger-path <rel>      ledger path inside --release-ledger (default: release-events.jsonl)
  --bundles-dir <rel>      bundle dir inside --release-ledger (default: bundles)
  --help                   print this text
`;

const VALUE_FLAGS = {
  "--release-ids": "releaseIds",
  "--release-ledger": "releaseLedger",
  "--ack": "ack",
  "--lane-repo": "laneRepo",
  "--lane-evidence": "laneEvidence",
  "--explanations": "explanations",
  "--evaluations": "evaluations",
  "--as-of": "asOf",
  "--out": "out",
  "--ledger-path": "ledgerPath",
  "--bundles-dir": "bundlesDir",
} as const;

type ValueKey = (typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS];

const REQUIRED: readonly (keyof typeof VALUE_FLAGS)[] = [
  "--release-ids",
  "--release-ledger",
  "--ack",
  "--lane-repo",
  "--lane-evidence",
  "--explanations",
  "--evaluations",
  "--as-of",
  "--out",
];

export type ParsedArgs =
  | { readonly help: true }
  | (CognitiveDebtOptions & { readonly help: false });

/** A relative path inside a repo: non-empty, not absolute, no "." / ".." segment. */
function assertRepoRelative(value: string, flag: string): string {
  const trimmed = value.replace(/\/+$/, "");
  const segments = trimmed.split("/");
  if (
    trimmed.length === 0 ||
    value.startsWith("/") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new CognitiveDebtArgError(
      `${flag} must be a relative path inside the repo, got "${value}"`,
    );
  }
  return trimmed;
}

export function parseCognitiveDebtArgs(argv: readonly string[]): ParsedArgs {
  const values: Partial<Record<ValueKey, string>> = {};
  let detail = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--detail") {
      detail = true;
      continue;
    }
    if (Object.hasOwn(VALUE_FLAGS, flag)) {
      const key = VALUE_FLAGS[flag as keyof typeof VALUE_FLAGS];
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CognitiveDebtArgError(`${flag} requires a value`);
      }
      if (values[key] !== undefined)
        throw new CognitiveDebtArgError(`${flag} given more than once`);
      values[key] = value;
      i++;
      continue;
    }
    throw new CognitiveDebtArgError(`unrecognized argument: ${flag}`);
  }
  const missing = REQUIRED.filter((flag) => values[VALUE_FLAGS[flag]] === undefined);
  if (missing.length > 0) {
    throw new CognitiveDebtArgError(`missing required flag(s): ${missing.join(", ")}`);
  }
  const asOf = values.asOf as string;
  const asOfAt = parseUtcTimestamp(asOf);
  if (asOfAt === null) {
    throw new CognitiveDebtArgError(
      `--as-of must be an ISO 8601 UTC timestamp like 2026-10-01T00:00:00Z, got "${asOf}"`,
    );
  }
  return {
    help: false,
    releaseIds: values.releaseIds as string,
    releaseLedger: values.releaseLedger as string,
    ack: values.ack as string,
    laneRepo: values.laneRepo as string,
    laneEvidence: values.laneEvidence as string,
    explanations: values.explanations as string,
    evaluations: values.evaluations as string,
    asOf,
    asOfAt,
    out: values.out as string,
    detail,
    ledgerPath: assertRepoRelative(values.ledgerPath ?? "release-events.jsonl", "--ledger-path"),
    bundlesDir: assertRepoRelative(values.bundlesDir ?? "bundles", "--bundles-dir"),
  };
}
