#!/usr/bin/env node
// CLI entrypoint for `agent-metrics-report`. Prints exactly one rendered report (json or
// markdown, per --format) to stdout; everything else -- warnings, status, API usage -- goes to
// stderr, so stdout stays a single, cleanly-parseable artifact (spec §1: "stdout は選択した1
// 形式のみ。警告・API使用量は stderr").

import { ReportArgError, parseReportArgs } from "./report-args.js";
import { runReport } from "./report-command.js";

async function main(): Promise<void> {
  let opts: ReturnType<typeof parseReportArgs>;
  try {
    opts = parseReportArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ReportArgError) {
      console.error(`agent-metrics-report: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const { output, resultA, resultB } = await runReport(opts);
  console.log(output);

  const resultBSummary = resultB
    ? ` | ${resultB.period.label} status=${resultB.status} merged_pr_count=${resultB.mergedPrCount ?? "unknown"} api_requests_used=${resultB.honesty.metadata.apiRequestsUsed}`
    : "";
  console.error(
    `agent-metrics-report: ${resultA.period.label} status=${resultA.status} merged_pr_count=${resultA.mergedPrCount ?? "unknown"} api_requests_used=${resultA.honesty.metadata.apiRequestsUsed}${resultBSummary}`,
  );
}

main().catch((err) => {
  console.error("agent-metrics-report: fatal error");
  console.error(err);
  process.exitCode = 1;
});
