// F2-derived metrics (cognitive-debt-metrics/v0 design 2.4): ack per approval_event_id, and
// coverage of the release's lane scope by the adopted ack's scopes. `self_report` is counted as
// stated -- no score, no ranking, no threshold. `by_kind` keys are the release-approval/v0 `kind`
// enum (read from the vendored pin) plus `other`; an input kind string is never echoed as a key.

import type { ReleaseLink } from "./chain.js";
import type { AckComposite, AckRecord, ApprovalEvent } from "./inputs.js";
import { byteCompare } from "./jcs.js";
import { missingEntry, ratio2 } from "./stats.js";
import { compareUtc } from "./time.js";

export const ACK_NOTE = "held / rejected は本人の停止であり不合格ではない";

const SELF_REPORTS = ["acknowledged", "held", "rejected"] as const;

export const OTHER_KIND = "other";

interface Approval {
  readonly release: ReleaseLink;
  readonly event: ApprovalEvent;
  /** Adopted record, or null = approvals_without_ack. */
  readonly ack: AckRecord | null;
  readonly candidates: number;
}

/** Design 2.4: several records for one approval -> occurred_at max, then the byte-order last
 * record_id. */
export function adoptAck(records: readonly AckRecord[]): AckRecord | null {
  let best: AckRecord | null = null;
  for (const r of records) {
    if (best === null) {
      best = r;
      continue;
    }
    const order = compareUtc(r.occurredAt, best.occurredAt);
    if (order > 0 || (order === 0 && byteCompare(r.record_id, best.record_id) > 0)) best = r;
  }
  return best;
}

function collectApprovals(resolved: readonly ReleaseLink[], composite: AckComposite): Approval[] {
  const byEvent = new Map<string, AckRecord[]>();
  for (const r of composite.ackRecords) {
    const list = byEvent.get(r.approval_event_id) ?? [];
    list.push(r);
    byEvent.set(r.approval_event_id, list);
  }
  const approvals: Approval[] = [];
  const seen = new Set<string>();
  const events = [...composite.approvalEvents].sort((a, b) => byteCompare(a.event_id, b.event_id));
  for (const release of resolved) {
    for (const event of events) {
      if (event.bundle_digest !== release.bundle_digest || seen.has(event.event_id)) continue;
      seen.add(event.event_id);
      const records = byEvent.get(event.event_id) ?? [];
      approvals.push({ release, event, ack: adoptAck(records), candidates: records.length });
    }
  }
  return approvals;
}

function ackRow(
  approvals: readonly Approval[],
  approvalKinds: ReadonlySet<string>,
  everSeen: ReadonlySet<string>,
  presentAtAsOf: ReadonlySet<string>,
): Record<string, unknown> {
  const byKind: Record<string, number> = {};
  const selfReport: Record<string, number> = Object.fromEntries(SELF_REPORTS.map((s) => [s, 0]));
  let highScopes = 0;
  let present = 0;
  let neverExisted = 0;
  let absentAtAsOf = 0;
  for (const a of approvals) {
    const kind = approvalKinds.has(a.event.kind) ? a.event.kind : OTHER_KIND;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (a.ack === null) continue;
    const key = (SELF_REPORTS as readonly string[]).includes(a.ack.self_report)
      ? a.ack.self_report
      : `other:${a.ack.self_report}`;
    selfReport[key] = (selfReport[key] ?? 0) + 1;
    for (const s of a.ack.scopes) {
      if (s.risk_class === "high") {
        highScopes++;
        if (s.explanation_present === true) present++;
      }
      if (s.explanation_id !== null) {
        if (!everSeen.has(s.explanation_id)) neverExisted++;
        else if (!presentAtAsOf.has(s.explanation_id)) absentAtAsOf++;
      }
    }
  }
  return {
    approvals: approvals.length,
    approvals_with_ack: approvals.filter((a) => a.ack !== null).length,
    by_kind: byKind,
    self_report: selfReport,
    explanation_present: { high_scopes: highScopes, present, rate: ratio2(present, highScopes) },
    explanation_missing: {
      explanation_never_existed: neverExisted,
      explanation_absent_at_as_of: absentAtAsOf,
    },
  };
}

export interface AckResult {
  readonly ack: Record<string, unknown>;
  readonly coverage: Record<string, unknown>;
  readonly rows: ReadonlyMap<string, { units: number; row: Record<string, unknown> }>;
}

export function computeAck(
  resolved: readonly ReleaseLink[],
  composite: AckComposite,
  approvalKinds: ReadonlySet<string>,
  everSeen: ReadonlySet<string>,
  presentAtAsOf: ReadonlySet<string>,
): AckResult {
  const approvals = collectApprovals(resolved, composite);
  const rows = new Map<string, { units: number; row: Record<string, unknown> }>();
  for (const release of resolved) {
    const mine = approvals.filter((a) => a.release.release_id === release.release_id);
    if (mine.length === 0) continue;
    rows.set(release.release_id, {
      units: mine.length,
      row: ackRow(mine, approvalKinds, everSeen, presentAtAsOf),
    });
  }
  const ack = {
    population: {
      resolved_releases: resolved.length,
      approvals: approvals.length,
      approvals_with_ack: approvals.filter((a) => a.ack !== null).length,
    },
    missing: {
      approvals_without_ack: missingEntry(
        approvals.filter((a) => a.ack === null).length,
        "approval",
      ),
      duplicate_ack_records: missingEntry(
        approvals.reduce((n, a) => n + Math.max(0, a.candidates - 1), 0),
        "ack_record",
      ),
      approvals_with_duplicate_ack: missingEntry(
        approvals.filter((a) => a.candidates > 1).length,
        "approval",
      ),
    },
    notes: ACK_NOTE,
    overall: ackRow(approvals, approvalKinds, everSeen, presentAtAsOf),
  };

  // Coverage (F2 C8): the unit is the approval; a release contributes only when it has a lane
  // scope (its effective revision's impact_scan_snapshot.digest).
  let denominator = 0;
  let numerator = 0;
  let denominatorHigh = 0;
  let numeratorHigh = 0;
  let withoutScope = 0;
  let withoutEvent = 0;
  for (const release of resolved) {
    const mine = approvals.filter((a) => a.release.release_id === release.release_id);
    if (mine.length === 0) withoutEvent++;
    const est = release.lane?.estimate;
    if (est === undefined || est.kind !== "ok" || est.revision.snapshot === null) {
      withoutScope++;
      continue;
    }
    const scope = est.revision.snapshot.digest;
    const high = est.revision.risk_class === "high";
    for (const a of mine) {
      const covered = a.ack?.scopes.some((s) => s.scope_digest === scope) === true;
      denominator++;
      if (covered) numerator++;
      if (high) {
        denominatorHigh++;
        if (covered) numeratorHigh++;
      }
    }
  }
  const coverage = {
    population: {
      approvals_in_denominator: denominator,
      approvals_in_denominator_high: denominatorHigh,
    },
    missing: {
      releases_without_lane_scope: missingEntry(withoutScope, "release"),
      approvals_without_event: missingEntry(withoutEvent, "release"),
    },
    covered: numerator,
    covered_high: numeratorHigh,
    ratio: ratio2(numerator, denominator),
    ratio_high: ratio2(numeratorHigh, denominatorHigh),
  };
  return { ack, coverage, rows };
}
