#!/usr/bin/env node
// CLI entrypoint for `agent-metrics-dashboard`. Writes exactly one file (`<out>/index.html`);
// everything else -- which repos/records it found, where it wrote to -- goes to stderr, mirroring
// report-main.ts's own stdout/stderr split (a machine-readable JSON summary line on stdout, logs
// on stderr).

import { DashboardArgError, parseDashboardArgs } from "./args.js";
import { runDashboard } from "./command.js";

async function main(): Promise<void> {
  let opts: ReturnType<typeof parseDashboardArgs>;
  try {
    opts = parseDashboardArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof DashboardArgError) {
      console.error(`agent-metrics-dashboard: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const { outPath, data } = await runDashboard(opts);

  console.error(
    `agent-metrics-dashboard: wrote ${outPath} (generated_at=${data.generatedAt} ` +
      `cost.n=${data.cost.meta.n} calibration.n=${data.calibration.meta.n} ` +
      `attribution.n=${data.attribution.meta.n} cohort.n=${data.cohort.meta.n} ` +
      `pipeline_heartbeat_at=${data.freshness.pipelineHeartbeatAt ?? "null"} ` +
      `last_valid_event_at=${data.freshness.lastValidEventAt ?? "null"})`,
  );
  console.log(JSON.stringify({ outPath, generatedAt: data.generatedAt }));
}

main().catch((err) => {
  console.error("agent-metrics-dashboard: fatal error");
  console.error(err);
  process.exitCode = 1;
});
