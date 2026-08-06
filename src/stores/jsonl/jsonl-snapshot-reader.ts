// Read-only JSONL SnapshotReader (report layer). Reuses replayJsonlJournal (journal.ts) --
// the exact same function JsonlStore itself uses -- so "which lines count as committed" can
// never diverge between the harvest CLI and the report CLI. In particular, a batch that never
// reached its trailing checkpoint line (a crash mid-commitBatch) is discarded by
// replayJsonlJournal itself, before this class ever sees it: the report layer's "未完了 tail
// を絶対に集計しない" requirement is structurally the same guarantee as the harvester's own
// crash-recovery invariant, not a separately-maintained one.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { StoredSnapshot } from "../../application/types.js";
import type { SnapshotReader } from "../../report/snapshot-reader.js";
import { replayJsonlJournal } from "./journal.js";

export class JsonlSnapshotReader implements SnapshotReader {
  constructor(private readonly filePath: string) {}

  async listCurrentSnapshots(repositories: readonly string[]): Promise<readonly StoredSnapshot[]> {
    if (!existsSync(this.filePath)) return [];
    const raw = await readFile(this.filePath, "utf-8");
    const { snapshots } = replayJsonlJournal(raw);
    const repoSet = new Set(repositories);
    return [...snapshots.values()].filter((s) => repoSet.has(s.repository));
  }
}
