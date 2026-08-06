// Markdown renderer (spec §1: "同一 domain object からの renderer"). Reads from the exact
// same CostPerPrResult/ComparisonResult the JSON renderer reads from -- no separate
// computation path, so the two formats can never show different numbers for the same run
// (spec §8: "JSON と Markdown が同一 domain result 由来").
//
// Three things spec §8 requires this renderer to always include: sample size (n), a coverage
// summary, and the metadata as-of timestamp -- plus, whenever a comparison is rendered, the
// fixed correlation-caveat sentence (spec §4) verbatim, and it must never claim quality was
// "maintained" (quality is simply not measured in v1, full stop -- spec §5's
// `quality_status: "not_measured"` and §7's cut of "「品質維持」の自動文言").

import type { ComparisonResult, MetricComparison } from "../comparison.js";
import type { CostPerPrResult } from "../cost-per-pr.js";

function fmtUsd(n: number | null): string {
  return n === null ? "n/a" : `$${n.toFixed(2)}`;
}

function fmtPercent(n: number | null): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

function statusLabel(status: CostPerPrResult["status"]): string {
  switch (status) {
    case "ok_observed":
      return "OK -- fully observed";
    case "partial_cost":
      return "Partial -- some cost data is missing (see coverage below)";
    case "no_telemetry":
      return "No telemetry -- merged PRs exist but no cost markers were found this period";
    case "metadata_incomplete":
      return "Metadata incomplete -- merged PR count could not be fully resolved (fetch/cache gap or safety-valve stop)";
    case "insufficient_sample":
      return "Insufficient sample -- fewer merged PRs than the minimum sample size";
    case "zero_denominator":
      return "Zero merged PRs in this period";
  }
}

function renderSingleResult(result: CostPerPrResult, heading: string): string {
  const lines: string[] = [];
  lines.push(`## ${heading}`);
  lines.push("");
  lines.push(
    `- Period: \`${result.period.label}\` (${result.period.timezone}), \`${result.period.start.utc}\` to \`${result.period.end.utc}\` (UTC, exclusive end)`,
  );
  lines.push(`- Repositories: ${result.repositories.map((r) => `\`${r}\``).join(", ")}`);
  lines.push(`- Status: ${statusLabel(result.status)}`);
  lines.push(
    `- Merged PRs (n): ${result.mergedPrCount ?? `unknown (partial count seen: ${result.mergedPrPartialCount})`}`,
  );
  lines.push("");

  if (result.estimatedCostPerMergedPrUsd !== null) {
    lines.push(`**Estimated cost per merged PR: ${fmtUsd(result.estimatedCostPerMergedPrUsd)}**`);
  } else if (result.estimatedCostPerMergedPrLowerBoundUsd !== null) {
    lines.push(
      `**Estimated cost per merged PR: at least ${fmtUsd(result.estimatedCostPerMergedPrLowerBoundUsd)}** (exact figure unavailable -- see coverage below)`,
    );
  } else {
    lines.push("**Estimated cost per merged PR: n/a**");
  }
  lines.push("");

  if (result.leadTime) {
    lines.push(
      `- PR lead time: median ${result.leadTime.medianHours.toFixed(1)}h, p90 ${result.leadTime.p90Hours.toFixed(1)}h (n=${result.leadTime.sampleCount})`,
    );
  } else {
    lines.push("- PR lead time: n/a");
  }
  if (result.creditsTotal > 0) {
    lines.push(
      `- Provider credits observed (separate unit, not converted to USD): ${result.creditsTotal}`,
    );
  }
  lines.push("");

  lines.push("### Coverage");
  lines.push("");
  const h = result.honesty;
  lines.push(
    `- Snapshots in period: ${h.snapshotTotalCount} (complete: ${h.snapshotStatusCounts.complete}, partial: ${h.snapshotStatusCounts.partial}, no_data: ${h.snapshotStatusCounts.noData})`,
  );
  lines.push(
    `- Snapshots linked to a PR: ${h.snapshotsLinkedCount}; unlinked: ${h.snapshotsUnlinkedCount}`,
  );
  lines.push(
    `- Merged PRs with at least one snapshot ever recorded: ${h.mergedPrWithAnySnapshotCount}; without any: ${h.mergedPrWithoutSnapshotCount}`,
  );
  lines.push(
    `- Records by pricing status -- priced: ${h.recordsByPricingStatus.priced.count} (${h.recordsByPricingStatus.priced.tokens} tokens); ` +
      `unpriced: ${h.recordsByPricingStatus.unpriced.count} (${h.recordsByPricingStatus.unpriced.tokens} tokens); ` +
      `unknown: ${h.recordsByPricingStatus.unknown.count} (${h.recordsByPricingStatus.unknown.tokens} tokens)`,
  );
  if (h.pricedMissingCostCount > 0) {
    lines.push(`- Priced records missing an actual cost figure: ${h.pricedMissingCostCount}`);
  }
  const omissionEntries = Object.entries(h.omissionCountsByReason);
  if (omissionEntries.length > 0) {
    lines.push(
      `- Omissions by reason: ${omissionEntries.map(([reason, count]) => `${reason}=${count}`).join(", ")}`,
    );
  }
  lines.push(
    `- PR metadata: ${h.metadata.complete ? "complete" : "INCOMPLETE"} as of \`${h.metadata.asOf}\` (${h.metadata.apiRequestsUsed} API requests used)`,
  );
  lines.push(
    `- quality_status: \`${h.qualityStatus}\` -- quality is not measured by this report; the numbers above are cost/volume/speed only`,
  );
  lines.push(`- input_fingerprint: \`${result.inputFingerprint}\``);
  lines.push("");
  return lines.join("\n");
}

function renderMetricRow(m: MetricComparison): string {
  const change = m.nullReason
    ? `n/a (${m.nullReason})`
    : `${fmtPercent(m.changePercent)} change, ${fmtPercent(m.improvementPercent)} improvement`;
  return `| ${m.metric} | ${m.baselineValue ?? "n/a"} | ${m.value ?? "n/a"} | ${change} |`;
}

function buildCappedSummarySentence(comparison: ComparisonResult): string {
  const clauses: string[] = [];
  if (comparison.costPerMergedPr.improvementPercent !== null) {
    clauses.push(
      `観測された推定AI利用コスト/merged PRが${fmtPercent(Math.abs(comparison.costPerMergedPr.improvementPercent))}${comparison.costPerMergedPr.improvementPercent >= 0 ? "改善" : "悪化"}し`,
    );
  }
  if (comparison.mergedPrCount.improvementPercent !== null) {
    clauses.push(
      `merged PR数が${fmtPercent(Math.abs(comparison.mergedPrCount.improvementPercent))}${comparison.mergedPrCount.improvementPercent >= 0 ? "増加" : "減少"}し`,
    );
  }
  if (comparison.leadTimeMedianHours.improvementPercent !== null) {
    clauses.push(
      `PR lead time中央値が${fmtPercent(Math.abs(comparison.leadTimeMedianHours.improvementPercent))}${comparison.leadTimeMedianHours.improvementPercent >= 0 ? "短縮" : "悪化"}した`,
    );
  }
  const body =
    clauses.length > 0
      ? `期間Bでは期間Aに比べ、${clauses.join("、")}。`
      : "期間Aと期間Bの間で、十分なデータのある指標はなかった。";
  // The two closing disclaimer sentences are fixed verbatim (spec §4) and always present,
  // regardless of which clauses above were available -- this is the cap the spec places on
  // any auto-generated comparison summary, and the only place "quality" is ever mentioned in
  // relation to a comparison (explicitly as NOT measured, never as maintained).
  return `${body}これは記述的な期間比較であり、AI利用による因果効果を示すものではない。品質は本レポートでは未測定。`;
}

export function renderMarkdownReport(
  resultA: CostPerPrResult,
  resultB?: CostPerPrResult,
  comparison?: ComparisonResult,
): string {
  if (!resultB || !comparison) {
    return `# Cost per merged PR\n\n${renderSingleResult(resultA, resultA.period.label)}`;
  }

  const lines: string[] = [];
  lines.push("# Cost per merged PR -- period comparison");
  lines.push("");
  lines.push(renderSingleResult(resultA, `Period A: ${resultA.period.label}`));
  lines.push(renderSingleResult(resultB, `Period B: ${resultB.period.label}`));
  lines.push("## Comparison");
  lines.push("");
  lines.push(
    `- Policy: \`${comparison.policy.version}\` (minimum sample size: ${comparison.policy.minSampleSize})`,
  );
  lines.push(
    `- Sample size -- A: ${comparison.sampleSizeA ?? "unknown"}, B: ${comparison.sampleSizeB ?? "unknown"}`,
  );
  lines.push("");
  lines.push("| Metric | A (baseline) | B | Change |");
  lines.push("|---|---|---|---|");
  lines.push(renderMetricRow(comparison.costPerMergedPr));
  lines.push(renderMetricRow(comparison.mergedPrCount));
  lines.push(renderMetricRow(comparison.leadTimeMedianHours));
  lines.push("");
  lines.push(buildCappedSummarySentence(comparison));
  lines.push("");
  return lines.join("\n");
}
