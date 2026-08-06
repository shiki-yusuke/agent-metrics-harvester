// Pure JSONL journal replay -- extracted from JsonlStore so the exact same "which lines count
// as committed" logic can be reused, unmodified, by both the harvest CLI's JsonlStore (which
// mutates its own in-memory maps from this) and the report layer's read-only
// JsonlSnapshotReader (src/stores/jsonl/jsonl-snapshot-reader.ts). This is the ONLY place that
// decision is made: any journal lines appended after the last checkpoint line for their batch
// belong to an incomplete/crashed commitBatch call and MUST be discarded, never applied --
// exactly the invariant test/unit/jsonl-crash-injection.test.ts proves for the harvester, and
// the same invariant the report layer depends on for "未完了 tail を絶対に集計しない."
//
// This file has zero knowledge of harvesting, reporting, or anything beyond "given this
// journal's raw text, what is the final committed state" -- it is not itself a Store or a
// SnapshotReader, just the shared pure function both are built on.

import type { Checkpoint, StoredSnapshot } from "../../application/types.js";

export interface SnapshotLine {
  readonly t: "snapshot";
  readonly upsertKey: string;
  readonly repository: string;
  readonly payload: unknown;
  readonly sourceCommentId: number;
  readonly sourceUpdatedAt: string;
  readonly markerSha: string;
}
export interface SeenLine {
  readonly t: "seen";
  readonly repository: string;
  readonly commentId: number;
  readonly markerSha: string;
}
export interface RejectionLine {
  readonly t: "rejection";
  readonly repository: string;
  readonly commentId: number;
  readonly commentUrl?: string;
  readonly markerSha?: string;
  readonly reasons: unknown;
  readonly detectedAt: string;
}
export interface CheckpointLine {
  readonly t: "checkpoint";
  readonly source: string;
  readonly checkpoint: Checkpoint;
}
export type JournalLine = SnapshotLine | SeenLine | RejectionLine | CheckpointLine;

export function seenKey(repository: string, commentId: number, markerSha: string): string {
  return `${repository} ${commentId} ${markerSha}`;
}

export interface JournalReplayResult {
  readonly checkpoints: ReadonlyMap<string, Checkpoint>;
  readonly snapshots: ReadonlyMap<string, StoredSnapshot>;
  readonly seen: ReadonlySet<string>;
}

/** Replays a JSONL journal's raw file text into the state a fully-committed reader should see.
 * Never throws on a torn/truncated trailing line (a crash mid-write) -- such a line can never
 * parse as valid JSON *and* be a checkpoint line at once, so it can't make an incomplete batch
 * look committed; it is simply skipped. */
export function replayJsonlJournal(rawText: string): JournalReplayResult {
  const checkpoints = new Map<string, Checkpoint>();
  const seen = new Set<string>();
  const snapshots = new Map<string, StoredSnapshot>();

  const rawLines = rawText.split("\n").filter((l) => l.trim().length > 0);

  let pendingSnapshots: StoredSnapshot[] = [];
  let pendingSeen: Array<{ repository: string; commentId: number; markerSha: string }> = [];

  for (const line of rawLines) {
    let obj: JournalLine;
    try {
      obj = JSON.parse(line) as JournalLine;
    } catch {
      continue;
    }

    if (obj.t === "snapshot") {
      pendingSnapshots.push({
        upsertKey: obj.upsertKey,
        repository: obj.repository,
        payload: obj.payload as StoredSnapshot["payload"],
        sourceCommentId: obj.sourceCommentId,
        sourceUpdatedAt: obj.sourceUpdatedAt,
        markerSha: obj.markerSha,
      });
    } else if (obj.t === "seen") {
      pendingSeen.push({
        repository: obj.repository,
        commentId: obj.commentId,
        markerSha: obj.markerSha,
      });
    } else if (obj.t === "rejection") {
      // Audit-only line; not applied to any queryable in-memory state.
    } else if (obj.t === "checkpoint") {
      for (const s of pendingSnapshots) snapshots.set(s.upsertKey, s);
      for (const se of pendingSeen) seen.add(seenKey(se.repository, se.commentId, se.markerSha));
      checkpoints.set(obj.source, obj.checkpoint);
      pendingSnapshots = [];
      pendingSeen = [];
    }
  }
  // Any lines left in `pendingSnapshots`/`pendingSeen` here belong to a batch that never
  // reached its checkpoint line -- discarded, exactly as if commitBatch had never been called.

  return { checkpoints, snapshots, seen };
}
