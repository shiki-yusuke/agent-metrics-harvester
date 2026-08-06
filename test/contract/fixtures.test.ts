// Conformance test: this repository's own src/protocol/* pipeline must reach the exact
// accept/reject/ignore verdict (and, for rejects, the exact reason code) that
// test/contract/vendor/fixtures/expected-results.json declares for every fixture vendored
// from the agent-metrics/v1 protocol's normative contract (see vendor/UPSTREAM.md).
//
// This is deliberately a *second* implementation of the check pipeline, not a call into the
// vendored verify-fixtures.mjs oracle -- the point of a conformance suite is that this
// repository's production code independently reaches the same verdicts, not that it merely
// runs the reference script and reports its exit code. execFileVerifyFixturesOracle below
// keeps that oracle in the loop too, as a belt-and-suspenders cross-check.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { computeUpsertKey } from "../../src/protocol/canonical.js";
import { decodeMarker, decodePayloadObject } from "../../src/protocol/decode.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.join(HERE, "vendor");
const FIXTURES_DIR = path.join(VENDOR_DIR, "fixtures");

function readText(filename: string): string {
  return readFileSync(path.join(FIXTURES_DIR, filename), "utf-8");
}
function readJson(filename: string): unknown {
  return JSON.parse(readText(filename));
}

interface CorrectionPayload {
  schema: string;
  repository: { provider: string; id: string };
  subject: { namespace: string; type: string; id: string };
  upsert_key: string;
  data?: { records?: unknown[] };
}

interface ManifestEntry {
  id: string;
  kind: "marker" | "ignored-marker" | "payload" | "correction-pair";
  files: Record<string, string>;
  expected: "accept" | "reject" | "ignore";
  reason_code: string | null;
  assert?: "same_upsert_key_different_content" | "same_upsert_key_record_removed";
}

interface Manifest {
  fixtures: ManifestEntry[];
}

const manifest = readJson("expected-results.json") as Manifest;

function runMarkerFixture(entry: ManifestEntry) {
  const markerFile = entry.files.marker;
  if (!markerFile) throw new Error(`fixture ${entry.id} missing marker file`);
  const markerText = readText(markerFile);
  return decodeMarker(markerText);
}

function runPayloadFixture(entry: ManifestEntry) {
  const payloadFile = entry.files.payload;
  if (!payloadFile) throw new Error(`fixture ${entry.id} missing payload file`);
  return decodePayloadObject(readJson(payloadFile));
}

describe("agent-metrics/v1 contract fixtures", () => {
  for (const entry of manifest.fixtures) {
    it(`${entry.id} (expected=${entry.expected})`, () => {
      if (entry.kind === "correction-pair") {
        return; // handled separately below
      }
      const outcome = entry.kind === "payload" ? runPayloadFixture(entry) : runMarkerFixture(entry);

      if (entry.expected === "ignore") {
        assert.equal(outcome.kind, "ignored", `expected ignore, got ${outcome.kind}`);
        return;
      }
      if (entry.expected === "accept") {
        assert.equal(
          outcome.kind,
          "accepted",
          `expected accept, got ${outcome.kind}: ${
            outcome.kind === "rejected" ? JSON.stringify(outcome.reasons) : ""
          }`,
        );
        return;
      }
      // expected === "reject"
      assert.equal(outcome.kind, "rejected", `expected reject, got ${outcome.kind}`);
      if (outcome.kind === "rejected" && entry.reason_code) {
        const codes = outcome.reasons.map((r) => r.code);
        assert.ok(
          codes.includes(entry.reason_code as (typeof codes)[number]),
          `expected reason_code "${entry.reason_code}" among [${codes.join(", ")}]`,
        );
      }
    });
  }

  describe("correction-pair fixtures", () => {
    const pairs = manifest.fixtures.filter((e) => e.kind === "correction-pair");
    for (const entry of pairs) {
      it(entry.id, () => {
        const firstFile = entry.files.first;
        const secondFile = entry.files.second;
        if (!firstFile || !secondFile)
          throw new Error(`fixture ${entry.id} missing first/second file`);
        const first = readJson(firstFile) as CorrectionPayload;
        const second = readJson(secondFile) as CorrectionPayload;

        const firstOutcome = decodePayloadObject(first);
        const secondOutcome = decodePayloadObject(second);
        assert.equal(
          firstOutcome.kind,
          "accepted",
          `first payload of ${entry.id} must individually validate`,
        );
        assert.equal(
          secondOutcome.kind,
          "accepted",
          `second payload of ${entry.id} must individually validate`,
        );

        const firstKey = computeUpsertKey({
          schema: first.schema,
          repository: first.repository,
          subject: first.subject,
        });
        const secondKey = computeUpsertKey({
          schema: second.schema,
          repository: second.repository,
          subject: second.subject,
        });
        assert.equal(
          firstKey,
          secondKey,
          "correction pair must share the same recomputed upsert_key",
        );
        assert.equal(first.upsert_key, firstKey);
        assert.equal(second.upsert_key, secondKey);

        if (entry.assert === "same_upsert_key_different_content") {
          assert.notEqual(
            JSON.stringify(first),
            JSON.stringify(second),
            "pair must differ in content",
          );
        }
        if (entry.assert === "same_upsert_key_record_removed") {
          const firstRecords: unknown[] = first.data?.records ?? [];
          const secondSet = new Set(
            (second.data?.records ?? []).map((r: unknown) => JSON.stringify(r)),
          );
          const removed = firstRecords.filter((r) => !secondSet.has(JSON.stringify(r)));
          assert.ok(
            removed.length > 0,
            "second payload must drop at least one record present in the first",
          );
        }
      });
    }
  });

  it("vendored verify-fixtures.mjs oracle also passes (independent cross-check)", () => {
    // Belt-and-suspenders: the upstream reference script, run unmodified, must also report
    // all fixtures passing. If this ever disagrees with the assertions above, the protocol
    // contract itself (not just this repository's re-implementation) needs investigation.
    execFileSync(process.execPath, [path.join(VENDOR_DIR, "verify-fixtures.mjs")], {
      stdio: "pipe",
    });
  });
});
