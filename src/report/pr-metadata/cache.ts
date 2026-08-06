// Load/save the versioned PR-metadata sidecar cache, and coverage-range bookkeeping (spec §3).
// A version mismatch is treated as "start fresh" (rebuild by fetching), never as an opportunity
// to guess at an incompatible shape -- the same "reject rather than partially interpret"
// stance the harvester's own protocol layer takes for an unrecognized schema kind.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CoverageRange,
  PR_METADATA_CACHE_VERSION,
  type PrMetadataCache,
  type PrMetadataRecord,
  emptyCache,
  recordKey,
} from "./types.js";

export async function loadCache(filePath: string): Promise<PrMetadataCache> {
  if (!existsSync(filePath)) return emptyCache();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return emptyCache();
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { cacheVersion?: unknown }).cacheVersion !== PR_METADATA_CACHE_VERSION
  ) {
    return emptyCache();
  }
  const cache = parsed as PrMetadataCache;
  return {
    cacheVersion: PR_METADATA_CACHE_VERSION,
    records: cache.records ?? {},
    coverage: cache.coverage ?? {},
  };
}

export async function saveCache(filePath: string, cache: PrMetadataCache): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(cache, null, 2), "utf-8");
}

/** True if the union of `ranges` fully covers [startUtc, endUtc). Ranges are assumed already
 * coalesced (see mergeCoverageRange) -- this does not itself merge overlapping input. */
export function rangeCoversFully(
  ranges: readonly CoverageRange[],
  startUtc: string,
  endUtc: string,
): boolean {
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  const sorted = [...ranges].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
  let coveredUpTo = startMs;
  for (const r of sorted) {
    const rStart = Date.parse(r.startUtc);
    const rEnd = Date.parse(r.endUtc);
    if (rStart > coveredUpTo) break; // gap
    if (rEnd > coveredUpTo) coveredUpTo = rEnd;
    if (coveredUpTo >= endMs) return true;
  }
  return coveredUpTo >= endMs;
}

/** Inserts a newly-fetched, exhaustively-covered range and coalesces it with any
 * overlapping/adjacent existing ranges, so the list stays minimal. */
export function mergeCoverageRange(
  ranges: readonly CoverageRange[],
  addition: CoverageRange,
): CoverageRange[] {
  const all = [...ranges, addition].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
  const merged: CoverageRange[] = [];
  for (const r of all) {
    const last = merged[merged.length - 1];
    if (last && Date.parse(r.startUtc) <= Date.parse(last.endUtc)) {
      if (Date.parse(r.endUtc) > Date.parse(last.endUtc)) {
        merged[merged.length - 1] = { startUtc: last.startUtc, endUtc: r.endUtc };
      }
    } else {
      merged.push(r);
    }
  }
  return merged;
}

export function upsertRecords(
  cache: PrMetadataCache,
  records: readonly PrMetadataRecord[],
): PrMetadataCache {
  const nextRecords = { ...cache.records };
  for (const r of records) {
    nextRecords[recordKey(r.repository, r.prNumber)] = r;
  }
  return { ...cache, records: nextRecords };
}

export function addCoverage(
  cache: PrMetadataCache,
  repository: string,
  range: CoverageRange,
): PrMetadataCache {
  const existing = cache.coverage[repository] ?? [];
  return {
    ...cache,
    coverage: { ...cache.coverage, [repository]: mergeCoverageRange(existing, range) },
  };
}

export function recordsForRepositoryInRange(
  cache: PrMetadataCache,
  repository: string,
  startUtc: string,
  endUtc: string,
): PrMetadataRecord[] {
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  return Object.values(cache.records).filter((r) => {
    if (r.repository !== repository) return false;
    const mergedMs = Date.parse(r.mergedAt);
    return mergedMs >= startMs && mergedMs < endMs;
  });
}
