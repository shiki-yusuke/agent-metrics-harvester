// Offline end-to-end test (spec section 7): a fake GitHub source serves real, vendored
// agent-metrics/v1 fixture markers (test/contract/vendor/fixtures) through the exact same
// CommentSource interface a real GitHub source implements, driven through the real
// harvestRepository orchestration, into a real JsonlStore and a real SqliteStore in the same
// run -- and both backends must land on the identical accept/reject/ignore outcome and
// identical stored snapshots. No network access anywhere in this file.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { harvestRepository } from "../../src/application/harvest.js";
import { SafetyValve } from "../../src/application/safety-valve.js";
import type { RawComment } from "../../src/application/types.js";
import { JsonlStore } from "../../src/stores/jsonl/jsonl-store.js";
import { SqliteStore } from "../../src/stores/sqlite/sqlite-store.js";
import { markerTextFor } from "../support/fixtures.js";
import { FakeGithubCommentSource } from "./fake-github-source.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_FIXTURES = path.join(HERE, "..", "contract", "vendor", "fixtures");

function readFixtureText(name: string): string {
  return readFileSync(path.join(VENDOR_FIXTURES, name), "utf-8");
}
function readFixtureJson(name: string): unknown {
  return JSON.parse(readFixtureText(name));
}

const REPOSITORY = "octo-org/spec-lane-demo";
const AUTH = { allowedLogins: ["trusted-ci[bot]"] };

function buildComments(): RawComment[] {
  const base = {
    authorLogin: "trusted-ci[bot]",
    authorType: "Bot" as const,
  };

  return [
    {
      ...base,
      id: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      htmlUrl: "https://example.invalid/1",
      issueNumber: 42, // matches valid-minimum.json's change.number
      body: readFixtureText("valid-minimum.marker.txt"),
    },
    {
      ...base,
      id: 2,
      updatedAt: "2026-01-01T00:01:00Z",
      htmlUrl: "https://example.invalid/2",
      issueNumber: 43, // matches valid-multi-record.json's change.number
      body: readFixtureText("valid-multi-record.marker.txt"),
    },
    {
      ...base,
      id: 3,
      updatedAt: "2026-01-01T00:02:00Z",
      htmlUrl: "https://example.invalid/3",
      issueNumber: 1,
      body: readFixtureText("invalid-hash.marker.txt"),
    },
    {
      ...base,
      id: 4,
      updatedAt: "2026-01-01T00:03:00Z",
      htmlUrl: "https://example.invalid/4",
      issueNumber: 1,
      body: readFixtureText("invalid-base64.marker.txt"),
    },
    {
      ...base,
      id: 5,
      updatedAt: "2026-01-01T00:04:00Z",
      htmlUrl: "https://example.invalid/5",
      issueNumber: 1,
      body: markerTextFor(readFixtureJson("invalid-unsupported-kind.json")),
    },
    {
      ...base,
      id: 6,
      updatedAt: "2026-01-01T00:05:00Z",
      htmlUrl: "https://example.invalid/6",
      issueNumber: 1,
      body: markerTextFor(readFixtureJson("invalid-personal-dimension.json")),
    },
    {
      ...base,
      id: 7,
      updatedAt: "2026-01-01T00:06:00Z",
      htmlUrl: "https://example.invalid/7",
      issueNumber: 1,
      body: readFixtureText("legacy-marker-ignored.marker.txt"),
    },
    {
      ...base,
      id: 8,
      updatedAt: "2026-01-01T00:07:00Z",
      htmlUrl: "https://example.invalid/8",
      issueNumber: 88, // matches correction-same-key-{1,2}.json's change.number
      body: markerTextFor(readFixtureJson("correction-same-key-1.json")),
    },
    {
      ...base,
      id: 9,
      updatedAt: "2026-01-01T00:08:00Z",
      htmlUrl: "https://example.invalid/9",
      issueNumber: 88,
      body: markerTextFor(readFixtureJson("correction-same-key-2.json")),
    },
  ];
}

describe("offline E2E: fake GitHub source serving real fixture markers", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-metrics-harvester-e2e-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("JSONL and SQLite reach the identical result from the identical comment stream", async () => {
    const comments = buildComments();

    const jsonlStore = await JsonlStore.open(path.join(dir, "e2e.jsonl"));
    const sqliteStore = await SqliteStore.open(path.join(dir, "e2e.sqlite"));

    const jsonlResult = await harvestRepository(
      {
        source: new FakeGithubCommentSource(REPOSITORY, comments),
        store: jsonlStore,
        safetyValve: new SafetyValve({}),
      },
      { lookbackDays: 3650, auth: AUTH },
    );
    const sqliteResult = await harvestRepository(
      {
        source: new FakeGithubCommentSource(REPOSITORY, comments),
        store: sqliteStore,
        safetyValve: new SafetyValve({}),
      },
      { lookbackDays: 3650, auth: AUTH },
    );

    assert.deepEqual(
      {
        accepted: jsonlResult.accepted,
        rejected: jsonlResult.rejected,
        ignored: jsonlResult.ignored,
      },
      {
        accepted: sqliteResult.accepted,
        rejected: sqliteResult.rejected,
        ignored: sqliteResult.ignored,
      },
    );
    // 2 clean accepts (valid-minimum, valid-multi-record) + 2 accepts from the correction pair
    // (the second upserts over the first's upsert_key, but both individually pass the
    // pipeline) = 4; 4 rejects (invalid-hash, invalid-base64, unsupported-kind,
    // personal-dimension); 1 ignore (legacy-marker-ignored).
    assert.equal(jsonlResult.accepted, 4);
    assert.equal(jsonlResult.rejected, 4);
    assert.equal(jsonlResult.ignored, 1);

    const minimumPayload = readFixtureJson("valid-minimum.json") as { upsert_key: string };
    const multiRecordPayload = readFixtureJson("valid-multi-record.json") as { upsert_key: string };
    const correctionPayload2 = readFixtureJson("correction-same-key-2.json") as {
      upsert_key: string;
      data: { records: unknown[] };
    };

    for (const upsertKey of [
      minimumPayload.upsert_key,
      multiRecordPayload.upsert_key,
      correctionPayload2.upsert_key,
    ]) {
      const fromJsonl = await jsonlStore.readSnapshot(upsertKey);
      const fromSqlite = await sqliteStore.readSnapshot(upsertKey);
      assert.ok(fromJsonl, `expected a stored snapshot for ${upsertKey} in JSONL`);
      assert.ok(fromSqlite, `expected a stored snapshot for ${upsertKey} in SQLite`);
      assert.deepEqual(fromJsonl, fromSqlite);
    }

    // The correction pair must have resolved to the *second* payload's content (snapshot
    // replace semantics), not the first's, in both backends.
    const corrected = await jsonlStore.readSnapshot(correctionPayload2.upsert_key);
    assert.deepEqual(corrected?.payload.data.records, correctionPayload2.data.records);
    assert.equal(corrected?.sourceCommentId, 9);

    await sqliteStore.close();
  });
});
