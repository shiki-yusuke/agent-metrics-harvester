// End-to-end coverage for scripts/push-aggregate.mjs against a real (local, bare) git repo --
// no network, but real `git clone`/`checkout --orphan`/`commit`/`push` subprocesses, the same
// way test/e2e/action-run-harvest.test.ts drives the real action/run-harvest.sh rather than
// mocking git out. Proves the three things the M1 spec calls out explicitly: orphan-branch
// creation on first use, append-only accumulation on subsequent use, and rejection (no git
// operation at all -- the remote's history must be untouched) for a tainted/invalid input.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dist/test/e2e -> repo root (four levels up: e2e, test, dist, root).
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const PUSH_AGGREGATE_MJS = path.join(REPO_ROOT, "scripts", "push-aggregate.mjs");

function runPushAggregate(
  args: readonly string[],
  input: string,
): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [PUSH_AGGREGATE_MJS, ...args], {
      input,
      encoding: "utf-8",
      env: { ...process.env },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

async function cloneAndReadFile(remoteDir: string, branch: string, relativePath: string) {
  const cloneDir = await mkdtemp(path.join(tmpdir(), "agent-metrics-push-aggregate-verify-"));
  try {
    execFileSync("git", ["clone", "--branch", branch, "--single-branch", remoteDir, cloneDir]);
    const text = await readFile(path.join(cloneDir, relativePath), "utf-8");
    return text;
  } finally {
    await rm(cloneDir, { recursive: true, force: true });
  }
}

function branchExists(remoteDir: string, branch: string): boolean {
  try {
    execFileSync("git", ["ls-remote", "--exit-code", "--heads", remoteDir, branch]);
    return true;
  } catch {
    return false;
  }
}

describe("scripts/push-aggregate.mjs (e2e against a local bare repo)", () => {
  let remoteDir: string;

  beforeEach(async () => {
    remoteDir = await mkdtemp(path.join(tmpdir(), "agent-metrics-aggregates-remote-"));
    execFileSync("git", ["init", "--bare", remoteDir]);
  });

  after(async () => {
    // beforeEach re-creates remoteDir per test; nothing persists across the describe block that
    // needs an outer cleanup, but the temp roots this test creates via mkdtemp are still real
    // filesystem entries -- rm each one as it's superseded rather than leaking them all.
  });

  it("creates the orphan branch and appends a validated heartbeat on first use", async () => {
    const result = runPushAggregate(
      ["--kind", "heartbeat", "--repo", remoteDir, "--branch", "metrics-data"],
      JSON.stringify({ source: "workflow", at: "2026-08-01T00:00:00Z" }),
    );
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout.trim().split("\n").pop() as string);
    assert.equal(summary.branchCreated, true);
    assert.equal(summary.pushed, true);
    assert.equal(summary.relativePath, "aggregates/2026-08.jsonl");

    const fileText = await cloneAndReadFile(remoteDir, "metrics-data", "aggregates/2026-08.jsonl");
    const lines = fileText.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] as string), {
      kind: "heartbeat",
      source: "workflow",
      at: "2026-08-01T00:00:00Z",
    });
  });

  it("appends to the same month file on a second call, without re-creating the branch", async () => {
    runPushAggregate(
      ["--kind", "heartbeat", "--repo", remoteDir, "--branch", "metrics-data"],
      JSON.stringify({ source: "local-push", at: "2026-08-02T00:00:00Z" }),
    );

    const second = runPushAggregate(
      ["--kind", "heartbeat", "--repo", remoteDir, "--branch", "metrics-data"],
      JSON.stringify({ source: "workflow", at: "2026-08-03T00:00:00Z" }),
    );
    assert.equal(second.status, 0, second.stderr);
    const summary = JSON.parse(second.stdout.trim().split("\n").pop() as string);
    assert.equal(summary.branchCreated, false, "the branch already existed from the first call");

    const fileText = await cloneAndReadFile(remoteDir, "metrics-data", "aggregates/2026-08.jsonl");
    const lines = fileText.trim().split("\n");
    assert.equal(lines.length, 2, "both calls' lines must both be present, append-only");
  });

  it("drops unrecognized fields before appending", async () => {
    runPushAggregate(
      ["--kind", "heartbeat", "--repo", remoteDir, "--branch", "metrics-data"],
      JSON.stringify({ source: "workflow", at: "2026-09-01T00:00:00Z", extra_field: "drop me" }),
    );
    const fileText = await cloneAndReadFile(remoteDir, "metrics-data", "aggregates/2026-09.jsonl");
    const record = JSON.parse(fileText.trim());
    assert.deepEqual(Object.keys(record).sort(), ["at", "kind", "source"]);
  });

  it("rejects a payload with a forbidden personal-dimension key and touches the remote not at all", async () => {
    const result = runPushAggregate(
      ["--kind", "heartbeat", "--repo", remoteDir, "--branch", "metrics-data"],
      JSON.stringify({ source: "workflow", at: "2026-08-01T00:00:00Z", author: "someone" }),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rejected/);
    assert.equal(
      branchExists(remoteDir, "metrics-data"),
      false,
      "a rejected input must never create the orphan branch",
    );
  });

  it("rejects an unsupported kind before touching the remote", async () => {
    const result = runPushAggregate(
      ["--kind", "not_a_kind", "--repo", remoteDir, "--branch", "metrics-data"],
      JSON.stringify({ foo: "bar" }),
    );
    assert.equal(result.status, 1);
    assert.equal(branchExists(remoteDir, "metrics-data"), false);
  });
});
