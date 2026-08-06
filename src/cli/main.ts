#!/usr/bin/env node
// CLI entrypoint: `agent-metrics-harvester --repo owner/repo --store jsonl --store-path ...`
// Prints a human-readable log to stderr and exactly one JSON summary line to stdout, so the
// GitHub Action wrapper (action/) can capture the summary without scraping log text.

import { CliArgError, parseArgs } from "./args.js";
import { runHarvest } from "./harvest-command.js";

async function main(): Promise<void> {
  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliArgError) {
      console.error(`agent-metrics-harvester: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const { results, errors } = await runHarvest(opts);

  for (const r of results) {
    console.error(
      `[${r.repository}] accepted=${r.accepted} rejected=${r.rejected} skippedSeen=${r.skippedSeen} ` +
        `ignored=${r.ignored} requestsUsed=${r.requestsUsed}` +
        `${r.notModified ? " notModified=true" : ""}${r.stoppedReason ? ` stoppedReason=${r.stoppedReason}` : ""}`,
    );
  }
  for (const [repo, err] of errors) {
    console.error(`[${repo}] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  const totalChanges = results.reduce((sum, r) => sum + r.accepted + r.rejected, 0);
  const summary = {
    changed: totalChanges > 0,
    results,
    errors: Object.fromEntries([...errors].map(([repo, err]) => [repo, err instanceof Error ? err.message : String(err)])),
  };
  console.log(JSON.stringify(summary));

  process.exitCode = errors.size > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("agent-metrics-harvester: fatal error");
  console.error(err);
  process.exitCode = 1;
});
