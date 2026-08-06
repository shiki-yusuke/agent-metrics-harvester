// Deterministic input_fingerprint (spec §5): a sha256 over exactly the inputs that determine a
// cost-per-pr result's content -- which snapshots (by upsert_key + their marker's verified
// sha256) fed the numerator, which cache format version produced the metadata, and (if used)
// which team-config content selected the repository set. Sorted before hashing, so re-running
// the same computation -- regardless of the order snapshots happened to be read back in --
// yields byte-identical results (spec §8: "同一 fingerprint から決定的結果").

import { canonicalizeJcs, sha256Hex } from "../protocol/canonical.js";

export interface FingerprintInput {
  readonly snapshots: readonly { readonly upsertKey: string; readonly markerSha: string }[];
  readonly cacheVersion: string;
  readonly teamConfigHash?: string;
}

export function computeInputFingerprint(input: FingerprintInput): string {
  const canonical = {
    upsert_keys: [...input.snapshots]
      .map((s) => ({ upsert_key: s.upsertKey, marker_sha: s.markerSha }))
      .sort((a, b) => a.upsert_key.localeCompare(b.upsert_key)),
    cache_version: input.cacheVersion,
    team_config_hash: input.teamConfigHash ?? null,
  };
  return sha256Hex(canonicalizeJcs(canonical));
}
