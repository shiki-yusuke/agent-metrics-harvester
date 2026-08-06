// Orchestrates the PR-metadata cache against a live GitHub Search fetch (spec §3): serves a
// repository+period entirely from cache when it's both fully covered AND fully in the past
// (a still-open/current period is never trusted from cache alone, since more PRs can still
// merge into it before it closes); otherwise fetches, and on ANY incompleteness (incomplete_
// results, a safety-valve stop, an unsplittable >1000-result window) marks the WHOLE result
// incomplete rather than silently keeping whatever partial records were found -- spec §3's
// "headline KPI を出さない" starts here, one level below cost-per-pr.ts.

import { type ShouldStop, fetchMergedPrsBulk } from "./bulk-fetch.js";
import {
  addCoverage,
  loadCache,
  rangeCoversFully,
  recordsForRepositoryInRange,
  saveCache,
  upsertRecords,
} from "./cache.js";
import type { GithubSearchClient } from "./github-search-client.js";
import { type PrMetadataCache, type PrMetadataRecord, emptyCache } from "./types.js";

export type MetadataMode = "auto" | "cache-only";

export interface MetadataResult {
  readonly recordsByRepository: ReadonlyMap<string, readonly PrMetadataRecord[]>;
  /** True only if every requested repository's metadata for [startUtc, endUtc) is known to be
   * exhaustive. False means the caller MUST NOT compute a headline merged_pr_count from this
   * result -- spec §3. */
  readonly complete: boolean;
  readonly asOf: string;
  readonly apiRequestsUsed: number;
  readonly cache: PrMetadataCache;
}

export interface ResolveMetadataOptions {
  readonly mode: MetadataMode;
  readonly shouldStop: ShouldStop;
  readonly now?: () => Date;
}

export async function resolveMetadata(
  client: GithubSearchClient | null,
  cache: PrMetadataCache,
  repositories: readonly string[],
  startUtc: string,
  endUtc: string,
  options: ResolveMetadataOptions,
): Promise<MetadataResult> {
  const now = options.now ?? (() => new Date());
  let workingCache = cache;
  let complete = true;
  let apiRequestsUsed = 0;
  const recordsByRepository = new Map<string, readonly PrMetadataRecord[]>();

  const isCurrentOrFuturePeriod = Date.parse(endUtc) > now().getTime();

  for (const repository of repositories) {
    const existingCoverage = workingCache.coverage[repository] ?? [];
    const fullyCovered = rangeCoversFully(existingCoverage, startUtc, endUtc);

    if (fullyCovered && !isCurrentOrFuturePeriod) {
      recordsByRepository.set(
        repository,
        recordsForRepositoryInRange(workingCache, repository, startUtc, endUtc),
      );
      continue;
    }

    if (options.mode === "cache-only" || client === null) {
      complete = false;
      recordsByRepository.set(
        repository,
        recordsForRepositoryInRange(workingCache, repository, startUtc, endUtc),
      );
      continue;
    }

    const result = await fetchMergedPrsBulk(
      client,
      repository,
      startUtc,
      endUtc,
      options.shouldStop,
      now,
    );
    apiRequestsUsed += result.requestsUsed;

    if (result.incomplete) {
      complete = false;
      recordsByRepository.set(
        repository,
        recordsForRepositoryInRange(workingCache, repository, startUtc, endUtc),
      );
      continue;
    }

    workingCache = upsertRecords(workingCache, result.records);
    if (!isCurrentOrFuturePeriod) {
      workingCache = addCoverage(workingCache, repository, { startUtc, endUtc });
    }
    recordsByRepository.set(repository, result.records);
  }

  return {
    recordsByRepository,
    complete,
    asOf: now().toISOString(),
    apiRequestsUsed,
    cache: workingCache,
  };
}

export { loadCache, saveCache, emptyCache };
