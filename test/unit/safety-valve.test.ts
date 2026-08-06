import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SafetyValve, boundedBackoffDelayMs } from "../../src/application/safety-valve.js";

describe("SafetyValve", () => {
  it("stops once maxApiRequests is reached", () => {
    const valve = new SafetyValve({ maxApiRequests: 3 });
    assert.equal(valve.check().stop, false);
    valve.recordRequests(3);
    const result = valve.check();
    assert.equal(result.stop, true);
    assert.equal(result.reason, "max_api_requests_exceeded");
  });

  it("stops once maxRuntimeMs elapses", () => {
    let now = 0;
    const valve = new SafetyValve({ maxRuntimeMs: 1000 }, () => now);
    assert.equal(valve.check().stop, false);
    now = 1500;
    const result = valve.check();
    assert.equal(result.stop, true);
    assert.equal(result.reason, "max_runtime_exceeded");
  });

  it("stops once rate-limit-remaining reaches the floor", () => {
    const valve = new SafetyValve({ rateLimitFloor: 50 });
    assert.equal(valve.check(100).stop, false);
    const result = valve.check(50);
    assert.equal(result.stop, true);
    assert.equal(result.reason, "rate_limit_floor_reached");
  });

  it("never stops when no limits are configured", () => {
    const valve = new SafetyValve({});
    valve.recordRequests(1_000_000);
    assert.equal(valve.check(0).stop, false);
  });

  describe("previewCheck (must-2 regression: live, per-page budget enforcement)", () => {
    it("check() and previewCheck(0, ...) agree -- previewCheck is a strict generalization, not a different check", () => {
      const valve = new SafetyValve({ maxApiRequests: 3 });
      assert.equal(valve.previewCheck(0).stop, valve.check().stop);
      valve.recordRequests(3);
      assert.equal(valve.previewCheck(0).stop, valve.check().stop);
    });

    it("treats pendingRequests as additional requests not yet recorded, without mutating requestsUsed", () => {
      const valve = new SafetyValve({ maxApiRequests: 3 });
      assert.equal(valve.previewCheck(2).stop, false); // 0 recorded + 2 pending = 2, under 3
      assert.equal(valve.previewCheck(3).stop, true); // 0 recorded + 3 pending = 3, at the limit
      assert.equal(valve.requestsUsed, 0, "previewCheck must never mutate the actual counter");
    });

    it("combines already-recorded usage with pending usage", () => {
      const valve = new SafetyValve({ maxApiRequests: 5 });
      valve.recordRequests(3);
      assert.equal(valve.previewCheck(1).stop, false); // 3 + 1 = 4, under 5
      assert.equal(valve.previewCheck(2).stop, true); // 3 + 2 = 5, at the limit
    });
  });
});

describe("boundedBackoffDelayMs", () => {
  it("grows exponentially and is capped by maxDelayMs", () => {
    assert.equal(boundedBackoffDelayMs(0, { baseDelayMs: 100, maxDelayMs: 10_000 }), 100);
    assert.equal(boundedBackoffDelayMs(1, { baseDelayMs: 100, maxDelayMs: 10_000 }), 200);
    assert.equal(
      boundedBackoffDelayMs(10, { baseDelayMs: 100, maxDelayMs: 10_000, maxAttempts: 20 }),
      10_000,
    );
  });

  it("returns null once maxAttempts is exceeded, signalling give-up", () => {
    assert.equal(boundedBackoffDelayMs(5, { maxAttempts: 5 }), null);
    assert.notEqual(boundedBackoffDelayMs(4, { maxAttempts: 5 }), null);
  });
});
