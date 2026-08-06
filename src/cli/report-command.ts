// Wires a parsed ReportOptions into the real production dependencies and runs the
// `cost-per-pr` command end to end: resolve repository set (--repo or --team-config) -> load
// PR-metadata cache -> resolve period(s) -> resolve metadata (cache/live, with the shared
// SafetyValve enforced across periods) -> compute cost-per-pr -> optionally compare -> render
// -> persist the updated cache. Kept separate from report-main.ts so it stays testable without
// going through argv parsing or process.exit.

import { readFile } from "node:fs/promises";
import { SafetyValve } from "../application/safety-valve.js";
import { type ComparisonResult, compareResults } from "../report/comparison.js";
import {
  type CostPerPrResult,
  DEFAULT_MIN_SAMPLE_SIZE,
  computeCostPerPr,
} from "../report/cost-per-pr.js";
import { computeInputFingerprint } from "../report/fingerprint.js";
import { isWithinPeriod, resolvePeriod } from "../report/period.js";
import { loadCache, saveCache } from "../report/pr-metadata/cache.js";
import { GithubSearchClient } from "../report/pr-metadata/github-search-client.js";
import { resolveMetadata } from "../report/pr-metadata/metadata-provider.js";
import { PR_METADATA_CACHE_VERSION, type PrMetadataCache } from "../report/pr-metadata/types.js";
import { renderJsonReport } from "../report/render/json.js";
import { renderMarkdownReport } from "../report/render/markdown.js";
import type { SnapshotReader } from "../report/snapshot-reader.js";
import {
  teamConfigHash as hashTeamConfig,
  parseTeamConfigYaml,
  selectTeam,
} from "../report/team-config.js";
import { JsonlSnapshotReader } from "../stores/jsonl/jsonl-snapshot-reader.js";
import { SqliteSnapshotReader } from "../stores/sqlite/sqlite-snapshot-reader.js";
import type { ReportOptions } from "./report-args.js";

export interface RunReportOutput {
  readonly output: string;
  readonly resultA: CostPerPrResult;
  readonly resultB?: CostPerPrResult;
  readonly comparison?: ComparisonResult;
}

function openSnapshotReader(opts: ReportOptions): SnapshotReader {
  return opts.storeKind === "sqlite"
    ? new SqliteSnapshotReader(opts.storePath)
    : new JsonlSnapshotReader(opts.storePath);
}

async function resolveRepositories(
  opts: ReportOptions,
): Promise<{ repositories: string[]; teamConfigHash?: string }> {
  if (!opts.teamConfigPath) return { repositories: [...opts.repos] };
  const text = await readFile(opts.teamConfigPath, "utf-8");
  const config = parseTeamConfigYaml(text);
  const team = selectTeam(config, opts.teamName);
  return { repositories: [...team.repositories], teamConfigHash: hashTeamConfig(config) };
}

async function computeOnePeriod(
  periodLabel: string,
  opts: ReportOptions,
  repositories: readonly string[],
  teamConfigHash: string | undefined,
  snapshotReader: SnapshotReader,
  cache: PrMetadataCache,
  client: GithubSearchClient | null,
  safetyValve: SafetyValve,
  now: () => Date,
): Promise<{ result: CostPerPrResult; updatedCache: PrMetadataCache }> {
  const period = resolvePeriod(periodLabel, opts.timezone);

  const metadataResult = await resolveMetadata(
    client,
    cache,
    repositories,
    period.start.utc,
    period.end.utc,
    {
      mode: opts.metadataMode,
      shouldStop: (pending, rateLimitRemaining) =>
        safetyValve.previewCheck(pending, rateLimitRemaining).stop,
      now,
    },
  );
  safetyValve.recordRequests(metadataResult.apiRequestsUsed);

  const allSnapshots = await snapshotReader.listCurrentSnapshots(repositories);
  const inPeriodSnapshots = allSnapshots.filter((s) =>
    isWithinPeriod(s.payload.generated_at, period),
  );
  const mergedPrs = repositories.flatMap(
    (repo) => metadataResult.recordsByRepository.get(repo) ?? [],
  );
  const resolvedMinSampleSize = opts.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
  const inputFingerprint = computeInputFingerprint({
    snapshots: inPeriodSnapshots.map((s) => ({ upsertKey: s.upsertKey, markerSha: s.markerSha })),
    periodStartUtc: period.start.utc,
    periodEndUtc: period.end.utc,
    repositories,
    mergedPrs: mergedPrs.map((pr) => ({
      repository: pr.repository,
      prNumber: pr.prNumber,
      mergedAt: pr.mergedAt,
    })),
    cacheVersion: PR_METADATA_CACHE_VERSION,
    minSampleSize: resolvedMinSampleSize,
    teamConfigHash,
  });

  const result = await computeCostPerPr({
    period,
    repositories,
    snapshotReader,
    mergedPrRecordsByRepository: metadataResult.recordsByRepository,
    metadataComplete: metadataResult.complete,
    metadataAsOf: metadataResult.asOf,
    metadataApiRequestsUsed: metadataResult.apiRequestsUsed,
    inputFingerprint,
    minSampleSize: resolvedMinSampleSize,
  });

  return { result, updatedCache: metadataResult.cache };
}

export async function runReport(
  opts: ReportOptions,
  now: () => Date = () => new Date(),
): Promise<RunReportOutput> {
  const { repositories, teamConfigHash } = await resolveRepositories(opts);

  const snapshotReader = openSnapshotReader(opts);
  const cache = await loadCache(opts.metadataCachePath);
  const client =
    opts.metadataMode === "cache-only"
      ? null
      : new GithubSearchClient({ token: opts.githubToken, baseUrl: opts.githubBaseUrl });
  const safetyValve = new SafetyValve({
    maxApiRequests: opts.maxApiRequests,
    rateLimitFloor: opts.rateLimitFloor,
    maxRuntimeMs: opts.maxRuntimeSeconds !== undefined ? opts.maxRuntimeSeconds * 1000 : undefined,
  });

  // --month/--week names the period the caller is actually asking about (rendered/compared as
  // "period B", the value being evaluated); --compare-month/--compare-week names the earlier
  // reference period to measure it against ("period A", the baseline) -- e.g.
  // "--month 2026-07 --compare-month 2026-06" reads as "how did July do, compared to June as
  // the baseline."
  const primary = await computeOnePeriod(
    opts.periodLabel,
    opts,
    repositories,
    teamConfigHash,
    snapshotReader,
    cache,
    client,
    safetyValve,
    now,
  );
  let finalCache = primary.updatedCache;

  let resultA = primary.result;
  let resultB: CostPerPrResult | undefined;
  let comparison: ComparisonResult | undefined;

  if (opts.comparePeriodLabel) {
    const baseline = await computeOnePeriod(
      opts.comparePeriodLabel,
      opts,
      repositories,
      teamConfigHash,
      snapshotReader,
      finalCache,
      client,
      safetyValve,
      now,
    );
    finalCache = baseline.updatedCache;
    resultA = baseline.result; // the compare-period is the baseline ("A")
    resultB = primary.result; // the primary period is the value being evaluated ("B")
    comparison = compareResults(resultA, resultB, {
      teamConfigHashA: teamConfigHash,
      teamConfigHashB: teamConfigHash,
    });
  }

  await saveCache(opts.metadataCachePath, finalCache);

  const output =
    opts.format === "json"
      ? JSON.stringify(renderJsonReport(resultA, resultB, comparison), null, 2)
      : renderMarkdownReport(resultA, resultB, comparison);

  return { output, resultA, resultB, comparison };
}
