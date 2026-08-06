import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareByGithubOrder, sortByGithubOrder } from "../../src/application/order.js";
import { makeComment } from "../support/fixtures.js";

describe("order: correction conflict order is GitHub's (updated_at, id), never generated_at", () => {
  it("sorts ascending by updated_at first", () => {
    const early = makeComment({ id: 5, updatedAt: "2026-01-01T00:00:00Z", body: "" });
    const late = makeComment({ id: 1, updatedAt: "2026-02-01T00:00:00Z", body: "" });
    assert.equal(compareByGithubOrder(early, late), -1);
    assert.deepEqual(sortByGithubOrder([late, early]), [early, late]);
  });

  it("ties on updated_at are broken by ascending comment id", () => {
    const a = makeComment({ id: 10, updatedAt: "2026-01-01T00:00:00Z", body: "" });
    const b = makeComment({ id: 20, updatedAt: "2026-01-01T00:00:00Z", body: "" });
    assert.equal(compareByGithubOrder(a, b), -10);
    assert.deepEqual(sortByGithubOrder([b, a]), [a, b]);
  });
});
