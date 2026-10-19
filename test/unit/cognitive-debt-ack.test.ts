// ack negative fixtures: approval kinds outside the release-approval/v0 enum, and ack records
// whose occurred_at is not a real UTC time.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adoptAck } from "../../src/cognitive-debt/ack.js";
import type { AckRecord } from "../../src/cognitive-debt/inputs.js";
import { parseUtcTimestamp } from "../../src/cognitive-debt/time.js";
import {
  EVENT_1,
  SHA_A,
  SHA_B,
  ackRecord,
  approvalEvent,
  baseSpec,
  bundle,
  runSpec,
} from "../support/cognitive-debt-fixtures.js";

const B1 = bundle("R1", "L-1");

describe("cognitive-debt ack", () => {
  it("a kind outside the release-approval/v0 enum is counted as `other`, never echoed as a key", async () => {
    const spec = baseSpec();
    const second = `sha256:${"2".repeat(64)}`;
    spec.ack = (ctx) => ({
      approval_events: [
        approvalEvent(EVENT_1, ctx.digest(B1), "principal"),
        approvalEvent(second, ctx.digest(B1), "approval_granted"),
      ],
      ack_records: [ackRecord(SHA_A, EVENT_1)],
    });
    const { report } = await runSpec(spec);
    assert.deepEqual(report.ack.overall.by_kind, { approval_granted: 1, other: 1 });
    assert.ok(!JSON.stringify(report).includes('"principal"'));
  });

  it("an ack record whose occurred_at is not a real UTC time is not adopted", async () => {
    for (const occurred_at of [
      "2026-01-11T00:00:00",
      "2026-02-30T00:00:00Z",
      "2026-01-11 00:00:00Z",
    ]) {
      const spec = baseSpec();
      spec.ack = (ctx) => ({
        approval_events: [approvalEvent(EVENT_1, ctx.digest(B1))],
        ack_records: [ackRecord(SHA_A, EVENT_1, { occurred_at })],
      });
      const { report } = await runSpec(spec);
      assert.equal(report.ack.population.approvals_with_ack, 0, occurred_at);
      assert.deepEqual(report.ack.missing.approvals_without_ack, { count: 1, unit: "approval" });
      assert.equal(report.ack.missing.duplicate_ack_records.count, 0);
    }
  });

  it("an invalid record does not outrank a valid one for the same approval", async () => {
    const spec = baseSpec();
    spec.ack = (ctx) => ({
      approval_events: [approvalEvent(EVENT_1, ctx.digest(B1))],
      ack_records: [
        ackRecord(SHA_A, EVENT_1, { occurred_at: "2026-01-11T00:00:00Z", self_report: "held" }),
        ackRecord(SHA_B, EVENT_1, { occurred_at: "2026-01-12T00:00:00", self_report: "rejected" }),
      ],
    });
    const { report } = await runSpec(spec);
    assert.equal(report.ack.population.approvals_with_ack, 1);
    assert.equal(report.ack.overall.self_report.held, 1);
    assert.equal(report.ack.overall.self_report.rejected, 0);
    assert.equal(report.ack.missing.duplicate_ack_records.count, 0);
  });

  it("adoptAck takes the later occurred_at even when only the 9th fraction digit differs", () => {
    const record = (record_id: string, occurred_at: string): AckRecord => ({
      record_id,
      approval_event_id: EVENT_1,
      occurredAt: parseUtcTimestamp(occurred_at) as NonNullable<
        ReturnType<typeof parseUtcTimestamp>
      >,
      self_report: "acknowledged",
      scopes: [],
    });
    const later = record("rec-a", "2026-01-15T00:00:00.000000001Z");
    const earlier = record("rec-b", "2026-01-15T00:00:00.000000000Z");
    // As epoch-ms floats both times are equal, so the old reader fell to the record_id tie-break (rec-b).
    assert.equal(adoptAck([later, earlier])?.record_id, "rec-a");
    assert.equal(adoptAck([earlier, later])?.record_id, "rec-a");
  });
});
