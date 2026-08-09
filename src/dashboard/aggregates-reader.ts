// Reads every `aggregates/*.jsonl` file under `--aggregates-dir` and buckets each line by
// `kind`. Reuses `projectAggregateRecord` (the exact same validator scripts/push-aggregate.mjs
// runs before it ever appends a line) as a purely defensive read-time filter here: a line that
// fails projection -- a torn trailing write, a stale line from a schema version this build
// predates -- is silently skipped, never a fatal error (spec: this generator must still produce
// a full 5-panel dashboard from partially-missing/malformed aggregate data, not crash on it).
// This module never writes; validation failures here have no rejection path to report through,
// unlike push-aggregate's.

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { projectAggregateRecord } from "../aggregates/schema.js";
import type {
  AttributionAuditSummaryRecord,
  CalibrationPointRecord,
  HeartbeatRecord,
} from "../aggregates/types.js";

export interface AggregateRecords {
  readonly attributionAuditSummaries: readonly AttributionAuditSummaryRecord[];
  readonly calibrationPoints: readonly CalibrationPointRecord[];
  readonly heartbeats: readonly HeartbeatRecord[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export async function readAggregates(aggregatesDir: string): Promise<AggregateRecords> {
  const attributionAuditSummaries: AttributionAuditSummaryRecord[] = [];
  const calibrationPoints: CalibrationPointRecord[] = [];
  const heartbeats: HeartbeatRecord[] = [];

  if (!existsSync(aggregatesDir)) {
    return { attributionAuditSummaries, calibrationPoints, heartbeats };
  }

  const entries = await readdir(aggregatesDir);
  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl")).sort();

  for (const file of jsonlFiles) {
    const text = await readFile(path.join(aggregatesDir, file), "utf-8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainObject(parsed)) continue;

      const projection = projectAggregateRecord(parsed.kind, parsed);
      if (!projection.ok) continue;

      if (projection.record.kind === "attribution_audit_summary") {
        attributionAuditSummaries.push(projection.record);
      } else if (projection.record.kind === "calibration_point") {
        calibrationPoints.push(projection.record);
      } else {
        heartbeats.push(projection.record);
      }
    }
  }

  return { attributionAuditSummaries, calibrationPoints, heartbeats };
}
