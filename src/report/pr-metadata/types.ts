// PR metadata sidecar cache (spec §3): the report layer's OWN cache, separate from anything
// the harvest CLI stores. Fields are exactly the closed set spec §3 allows -- author/reviewer/
// assignee/title/label are projected away at the point of mapping a raw GitHub API response
// into this shape and are never held, even transiently, beyond that mapping step (spec §6:
// "GitHub レスポンスの個人情報は cache 前に除去").

export type PrLifecycleState = "merged";

export interface PrMetadataRecord {
  readonly repository: string;
  readonly prNumber: number;
  readonly openedAt: string;
  readonly mergedAt: string;
  readonly state: PrLifecycleState;
  readonly githubUpdatedAt: string;
  readonly fetchedAt: string;
}

/** A merged_at window that has been exhaustively fetched for one repository -- no
 * incomplete_results, no missed pagination, no un-split >1000-result query. Used to decide
 * whether a request can be served entirely from cache (spec §3: "確定済み過去期間を完全カバー
 * していればオフライン"). */
export interface CoverageRange {
  readonly startUtc: string;
  readonly endUtc: string;
}

export const PR_METADATA_CACHE_VERSION = "pr-metadata-cache/v1";

export interface PrMetadataCache {
  readonly cacheVersion: typeof PR_METADATA_CACHE_VERSION;
  /** Keyed by `${repository}#${prNumber}`. */
  readonly records: Readonly<Record<string, PrMetadataRecord>>;
  /** Keyed by repository. */
  readonly coverage: Readonly<Record<string, readonly CoverageRange[]>>;
}

export function emptyCache(): PrMetadataCache {
  return { cacheVersion: PR_METADATA_CACHE_VERSION, records: {}, coverage: {} };
}

export function recordKey(repository: string, prNumber: number): string {
  return `${repository}#${prNumber}`;
}
