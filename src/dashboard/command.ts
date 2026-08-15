// Wires a parsed DashboardOptions into real production dependencies and produces
// `<out>/index.html`: discover every repository the store contains -> read its current
// snapshots -> read the aggregates directory -> compute the domain object -> render -> write.
// Kept separate from main.ts so it stays testable without going through argv parsing or
// process.exit -- the same split report-command.ts/report-main.ts already use.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SnapshotReader } from "../report/snapshot-reader.js";
import { JsonlSnapshotReader } from "../stores/jsonl/jsonl-snapshot-reader.js";
import { SqliteSnapshotReader } from "../stores/sqlite/sqlite-snapshot-reader.js";
import { readAggregates } from "./aggregates-reader.js";
import {
  JsonlAllRepositoriesReader,
  SqliteAllRepositoriesReader,
} from "./all-repositories-reader.js";
import type { AllRepositoriesReader } from "./all-repositories-reader.js";
import type { DashboardOptions } from "./args.js";
import { computeDashboardData } from "./compute.js";
import { readEmptyReasonConfig } from "./empty-reason-config.js";
import { renderDashboardHtml } from "./render.js";
import type { DashboardData } from "./types.js";

export interface RunDashboardOutput {
  readonly outPath: string;
  readonly html: string;
  readonly data: DashboardData;
}

function openReaders(opts: DashboardOptions): {
  allRepos: AllRepositoriesReader;
  snapshots: SnapshotReader;
} {
  return opts.storeKind === "sqlite"
    ? {
        allRepos: new SqliteAllRepositoriesReader(opts.storePath),
        snapshots: new SqliteSnapshotReader(opts.storePath),
      }
    : {
        allRepos: new JsonlAllRepositoriesReader(opts.storePath),
        snapshots: new JsonlSnapshotReader(opts.storePath),
      };
}

export async function runDashboard(
  opts: DashboardOptions,
  nowFn: () => Date = () => new Date(),
): Promise<RunDashboardOutput> {
  const now = opts.now !== undefined ? new Date(opts.now) : nowFn();

  const { allRepos, snapshots: snapshotReader } = openReaders(opts);
  const repositories = await allRepos.listAllRepositories();
  const snapshots =
    repositories.length > 0 ? await snapshotReader.listCurrentSnapshots(repositories) : [];

  const { attributionAuditSummaries, calibrationPoints, heartbeats } = await readAggregates(
    opts.aggregatesDir,
  );

  const data = computeDashboardData({
    snapshots,
    attributionAuditSummaries,
    calibrationPoints,
    heartbeats,
    now,
  });

  // Reads and validates the operator's own empty-reason classification, if supplied -- never
  // part of computeDashboardData's inputs (see empty-reason-config.ts's header): this is a
  // publication-boundary judgment, not a measured quantity, so it flows straight to the
  // presentation layer only.
  const emptyReasons =
    opts.emptyReasonConfigPath !== undefined
      ? await readEmptyReasonConfig(opts.emptyReasonConfigPath)
      : undefined;

  const html = renderDashboardHtml(data, emptyReasons);

  await mkdir(opts.outDir, { recursive: true });
  const outPath = path.join(opts.outDir, "index.html");
  await writeFile(outPath, html, "utf-8");

  return { outPath, html, data };
}
