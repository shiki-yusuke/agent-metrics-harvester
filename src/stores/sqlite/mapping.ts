// Shared row <-> StoredSnapshot mapping for the `snapshots` table -- extracted so SqliteStore
// (src/stores/sqlite/sqlite-store.ts, part of the harvest CLI's contract) and the report
// layer's read-only SqliteSnapshotReader (src/stores/sqlite/sqlite-snapshot-reader.ts) can
// never silently diverge on how a row becomes a StoredSnapshot.

import type { StoredSnapshot } from "../../application/types.js";

export interface SnapshotRow {
  readonly upsert_key: string;
  readonly repository: string;
  readonly payload: string;
  readonly source_comment_id: number;
  readonly source_updated_at: string;
  readonly marker_sha: string;
}

export const SNAPSHOT_COLUMNS =
  "upsert_key, repository, payload, source_comment_id, source_updated_at, marker_sha";

export function rowToStoredSnapshot(row: SnapshotRow): StoredSnapshot {
  return {
    upsertKey: row.upsert_key,
    repository: row.repository,
    payload: JSON.parse(row.payload),
    sourceCommentId: row.source_comment_id,
    sourceUpdatedAt: row.source_updated_at,
    markerSha: row.marker_sha,
  };
}
