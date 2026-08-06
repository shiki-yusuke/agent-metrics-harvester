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
});

describe("boundedBackoffDelayMs", () => {
  it("grows exponentially and is capped by maxDelayMs", () => {
    assert.equal(boundedBackoffDelayMs(0, { baseDelayMs: 100, maxDelayMs: 10_000 }), 100);
    assert.equal(boundedBackoffDelayMs(1, { baseDelayMs: 100, maxDelayMs: 10_000 }), 200);
    assert.equal(boundedBackoffDelayMs(10, { baseDelayMs: 100, maxDelayMs: 10_000, maxAttempts: 20 }), 10_000);
  });

  it("returns null once maxAttempts is exceeded, signalling give-up", () => {
    assert.equal(boundedBackoffDelayMs(5, { maxAttempts: 5 }), null);
    assert.notEqual(boundedBackoffDelayMs(4, { maxAttempts: 5 }), null);
  });
});
