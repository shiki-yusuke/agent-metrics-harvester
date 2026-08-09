// Pins the EXACT flag values `.github/workflows/dashboard.yml`'s "Generate the static
// dashboard" step passes to `agent-metrics-dashboard`, run against the real built CLI in the
// exact same $GITHUB_WORKSPACE-relative directory layout that step runs in
// (`repo/`, `metrics-data-checkout/`, `dashboard-dist/` as same-level siblings, never a ".."
// segment). This exists because of a real regression: an earlier version of that workflow step
// used `working-directory: repo` plus `--store-path ../metrics-data-checkout/...`, and
// src/cli/path-safety.ts's `assertNoPathTraversal` rejects ANY ".." segment unconditionally (by
// design -- see that file) -- so every scheduled/dispatched run of that workflow would have
// exited 2 at CLI arg-parse time, before Pages ever saw a deploy. `npm test` never executes
// dashboard.yml itself, so the only way this suite can catch that regression class is by
// running the CLI with the literal argv dashboard.yml uses. If dashboard.yml's paths ever
// change, update the literals below to match -- keep the two in sync.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dist/test/e2e -> repo root (four levels up: e2e, test, dist, root).
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const DASHBOARD_MAIN = path.join(REPO_ROOT, "dist", "src", "dashboard", "main.js");

describe("dashboard.yml's exact 'Generate the static dashboard' invocation", () => {
  let workspace: string;

  before(async () => {
    // Mirrors $GITHUB_WORKSPACE: `metrics-data-checkout/` is a sibling of where `dashboard-dist/`
    // will be written, exactly as actions/checkout with `path: metrics-data-checkout` leaves it.
    workspace = await mkdtemp(path.join(tmpdir(), "agent-metrics-dashboard-workflow-args-"));
    await mkdir(path.join(workspace, "metrics-data-checkout"), { recursive: true });
    await writeFile(
      path.join(workspace, "metrics-data-checkout", "agent-metrics-store.jsonl"),
      "",
      "utf-8",
    );
  });

  after(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("exits 0 and writes dashboard-dist/index.html with the workflow's literal flags", async () => {
    // These --flag/value pairs must match dashboard.yml's "Generate the static dashboard" step
    // verbatim (aside from --now, added here only so this test is deterministic).
    const args = [
      "--store",
      "jsonl",
      "--store-path",
      "metrics-data-checkout/agent-metrics-store.jsonl",
      "--aggregates-dir",
      "metrics-data-checkout/aggregates",
      "--out",
      "dashboard-dist",
      "--now",
      "2026-08-15T00:00:00Z",
    ];

    // A regression back to a "../"-style path would throw here (PathTraversalError -> exit 2),
    // exactly the failure mode this test exists to catch -- execFileSync throws on any non-zero
    // exit.
    execFileSync("node", [DASHBOARD_MAIN, ...args], { cwd: workspace, encoding: "utf-8" });

    const html = await readFile(path.join(workspace, "dashboard-dist", "index.html"), "utf-8");
    assert.match(html, /<!doctype html>/);
  });
});
