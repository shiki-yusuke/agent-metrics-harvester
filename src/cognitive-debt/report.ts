// The cognitive-debt-metrics/v0 envelope (design section 3) and its fixed `limits[]` (design
// section 5, verbatim, in this order).

export const SCHEMA_VERSION = "cognitive-debt-metrics/v0";
export const GENERATOR_NAME = "agent-metrics-harvester";

export const LIMITS: readonly string[] = [
  "M1 の起点は「解説が初めて uncovered と書いた commit」であって、負債が生じた時刻ではない。",
  "M2 と coverage の lane revision は `T_release` 以前の最新 snapshot で近似している。`lane_ref` は revision を pin しない。観測は merge_sha の first-parent 差分だけで、follow-up や別 PR は含まない。dir 候補の hit は `dir_width` と併読する。",
  "M3 は shadow 評価であり本番 receipt の verdict ではない。母集団は永続化された評価レコードだけで、現状は 0 件から始まり、`input_digest` が wrapper に入るまでは null。bucket の時刻は自己申告の `evaluation_cut`。",
  "coverage は lane の scope 集合を正とし、scope を記録しなかった release は分母に入らない。",
  "個人・チーム・モデルの評価に使えない。min_cell 抑制は再識別の完全な防止ではない。",
  "M3 は wrapper の `input_digest`（release-evidence 側の追加）が前提で、それまで null。`input_digest` が揃っても束縛は「評価器がこの入力 bytes を見た」ことまでで、評価器の実装が正しかったことの証明ではない。",
];

export interface ReportParts {
  readonly asOf: string;
  readonly version: string;
  readonly detail: boolean;
  readonly inputs: readonly Record<string, unknown>[];
  /** Design section 1: `--release-ids` count (distinct) and releases the chain resolved to a
   * bundle. */
  readonly population: { readonly requested_releases: number; readonly resolved_releases: number };
  readonly m1: Record<string, unknown>;
  readonly m2: Record<string, unknown>;
  readonly m3: Record<string, unknown>;
  readonly ack: Record<string, unknown>;
  readonly coverage: Record<string, unknown>;
  readonly missing: Record<string, unknown>;
  readonly suppressedRows: Record<string, unknown>;
}

export function buildReport(p: ReportParts): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    authority: "none",
    as_of: p.asOf,
    generator: { name: GENERATOR_NAME, version: p.version, options: { detail: p.detail } },
    inputs: p.inputs,
    population: { ...p.population },
    m1_open_assertions: p.m1,
    m2_prediction_error: p.m2,
    m3_abstain_reasons: p.m3,
    ack: p.ack,
    coverage: p.coverage,
    missing: p.missing,
    suppressed_rows: p.suppressedRows,
    limits: [...LIMITS],
  };
}
