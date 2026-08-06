// Deterministic input_fingerprint (spec §5): a sha256 over exactly the inputs that determine a
// cost-per-pr result's content, so "same fingerprint" is actually a sound proxy for "same
// result" (spec §8: "同一 fingerprint から決定的結果") -- not merely "same snapshots".
//
// That requires covering every input the computation actually branches or sums on:
// - which snapshots (by upsert_key + their marker's verified sha256) fed the numerator;
// - the resolved period's own UTC boundaries (two different --month/--week/--timezone
//   requests that happened to resolve to the same snapshot set must still fingerprint
//   differently if their periods differ, since a caller comparing fingerprints has no other
//   way to notice that);
// - the repository set actually used (a --repo list or a --team-config selection);
// - the merged-PR set that determined the denominator/lead-time (repository, pr_number,
//   merged_at -- enough to detect a change in *which* PRs were counted, without pulling in
//   personal fields that were never part of PrMetadataRecord to begin with);
// - the PR-metadata cache format version;
// - the min-sample-size policy actually applied (the ACTUAL resolved value, not just whatever
//   the caller happened to pass through -- see cost-per-pr.ts's DEFAULT_MIN_SAMPLE_SIZE);
// - the team-config content hash, when a team-config selected the repository set.
//
// Everything is sorted before hashing, so re-running the same computation -- regardless of the
// order snapshots or PR records happened to be read back in -- yields a byte-identical
// fingerprint.

import { canonicalizeJcs, sha256Hex } from "../protocol/canonical.js";

export interface FingerprintInput {
  readonly snapshots: readonly { readonly upsertKey: string; readonly markerSha: string }[];
  readonly periodStartUtc: string;
  readonly periodEndUtc: string;
  readonly repositories: readonly string[];
  readonly mergedPrs: readonly {
    readonly repository: string;
    readonly prNumber: number;
    readonly mergedAt: string;
  }[];
  readonly cacheVersion: string;
  readonly minSampleSize: number;
  readonly teamConfigHash?: string;
}

export function computeInputFingerprint(input: FingerprintInput): string {
  const canonical = {
    period: { start_utc: input.periodStartUtc, end_utc: input.periodEndUtc },
    repositories: [...input.repositories].sort(),
    upsert_keys: [...input.snapshots]
      .map((s) => ({ upsert_key: s.upsertKey, marker_sha: s.markerSha }))
      .sort((a, b) => a.upsert_key.localeCompare(b.upsert_key)),
    merged_prs: [...input.mergedPrs]
      .map((r) => ({ repository: r.repository, pr_number: r.prNumber, merged_at: r.mergedAt }))
      .sort((a, b) =>
        `${a.repository}#${a.pr_number}`.localeCompare(`${b.repository}#${b.pr_number}`),
      ),
    cache_version: input.cacheVersion,
    min_sample_size: input.minSampleSize,
    team_config_hash: input.teamConfigHash ?? null,
  };
  return sha256Hex(canonicalizeJcs(canonical));
}
