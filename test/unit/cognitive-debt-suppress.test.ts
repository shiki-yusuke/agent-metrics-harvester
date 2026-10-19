// min_cell: breakdown rows below 5 units are replaced by a suppressed_rows entry without the count;
// the overall row is always present.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalize, serializeOutput } from "../../src/cognitive-debt/jcs.js";
import { applyMinCell, emptySuppressed } from "../../src/cognitive-debt/suppress.js";
import { approvalEvent, baseSpec, bundle, runSpec } from "../support/cognitive-debt-fixtures.js";

const eventId = (n: number) => `sha256:${String(n).padStart(64, "e")}`;

describe("cognitive-debt min_cell", () => {
  it("applyMinCell keeps >= 5 and suppresses < 5 without writing the count", () => {
    const suppressed = {};
    const kept = applyMinCell(
      "m1",
      "by_risk_class",
      "episode",
      new Map([
        ["high", { units: 4, row: { a: 1 } }],
        ["low", { units: 5, row: { a: 2 } }],
      ]),
      suppressed,
    );
    // kept is null-prototype (decisions #39), so compare its own entries.
    assert.deepEqual({ ...kept }, { low: { a: 2 } });
    assert.deepEqual(suppressed, {
      "m1.by_risk_class.high": { reason: "min_cell", unit: "episode", n_lt: 5 },
    });
  });

  for (const [n, visible] of [
    [4, false],
    [5, true],
  ] as const) {
    it(`a release with ${n} approvals ${visible ? "gets" : "does not get"} an ack.by_release row`, async () => {
      const spec = baseSpec();
      const digest = (ctx: { digest: (b: unknown) => string }) => ctx.digest(bundle("R1", "L-1"));
      spec.ack = (ctx) => ({
        approval_events: Array.from({ length: n }, (_, i) =>
          approvalEvent(eventId(i), digest(ctx)),
        ),
        ack_records: [],
      });
      const { report } = await runSpec(spec);
      assert.equal(report.ack.overall.approvals, n);
      if (visible) {
        assert.equal(report.ack.by_release.R1.approvals, 5);
        assert.equal(report.suppressed_rows["ack.by_release.R1"], undefined);
      } else {
        assert.deepEqual(report.ack.by_release, {});
        assert.deepEqual(report.suppressed_rows["ack.by_release.R1"], {
          reason: "min_cell",
          unit: "approval",
          n_lt: 5,
        });
      }
      // M1 (2 episodes) and M2 (1 unit) breakdowns are always suppressed in this fixture.
      assert.deepEqual(report.suppressed_rows["m1.by_risk_class.high"], {
        reason: "min_cell",
        unit: "episode",
        n_lt: 5,
      });
      assert.deepEqual(report.suppressed_rows["m2.by_risk_class.high"], {
        reason: "min_cell",
        unit: "release_lane",
        n_lt: 5,
      });
      assert.equal(report.ack.missing.approvals_without_ack.count, n);
    });
  }

  it("a `__proto__` key stays an own property on both the kept and the suppressed path", () => {
    const suppressed = emptySuppressed();
    const kept = applyMinCell(
      "ack",
      "by_release",
      "approval",
      new Map([["__proto__", { units: 5, row: { approvals: 5 } }]]),
      suppressed,
    );
    // In a `{}` literal, `kept["__proto__"] = row` replaces the prototype and Object.keys(kept) is [].
    assert.deepEqual(Object.keys(kept), ["__proto__"]);
    assert.equal(serializeOutput(kept), '{"__proto__":{"approvals":5}}');
    applyMinCell(
      "m1",
      "by_risk_class",
      "episode",
      new Map([["__proto__", { units: 1, row: {} }]]),
      suppressed,
    );
    assert.equal(
      serializeOutput({ by_release: kept, suppressed_rows: suppressed }),
      '{"by_release":{"__proto__":{"approvals":5}},' +
        '"suppressed_rows":{"m1.by_risk_class.__proto__":{"n_lt":5,"reason":"min_cell","unit":"episode"}}}',
    );
    // The suppressed map itself is null-prototype: a bare `__proto__` key is kept and serialized.
    const bare = emptySuppressed();
    bare.__proto__ = { reason: "min_cell", unit: "approval", n_lt: 5 };
    // With a `{}` literal this assignment sets the prototype and canonicalize writes "{}".
    assert.equal(
      canonicalize(bare),
      '{"__proto__":{"n_lt":5,"reason":"min_cell","unit":"approval"}}',
    );
  });
});
