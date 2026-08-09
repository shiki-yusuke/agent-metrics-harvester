// Smoke test for the composite Action's numeric inputs (action.yml's max-api-requests /
// lookback-days / rate-limit-floor / max-runtime-seconds), driven through the actual
// action/run-harvest.sh script rather than through parseArgs directly -- the harvest CLI's
// own numeric-flag validation (src/cli/args.ts, see the G5 regression fix) only reaches the
// Action if run-harvest.sh's `--flag value` forwarding and its downstream `has-errors` /
// `cli-exit-code` outputs actually carry the CLI's exit-2 rejection through. This test spawns
// the real bash script -- no network access, and it never reaches GithubClient because
// parseArgs rejects the bad flag before openStore/harvestAll ever run.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dist/test/e2e -> repo root (four levels up: e2e, test, dist, root).
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const RUN_HARVEST_SH = path.join(REPO_ROOT, "action", "run-harvest.sh");

function parseGithubOutput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe("action/run-harvest.sh numeric-input smoke test", () => {
  let stateDir: string;
  let githubOutputPath: string;

  before(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "agent-metrics-action-state-"));
    githubOutputPath = path.join(
      await mkdtemp(path.join(tmpdir(), "agent-metrics-gh-output-")),
      "output",
    );
  });

  after(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(path.dirname(githubOutputPath), { recursive: true, force: true });
  });

  it("a non-numeric max-api-requests input fails the CLI (exit 2) and surfaces as has-errors=true, not a silently-disabled safety valve", () => {
    // run-harvest.sh itself never fails on the CLI's exit code (see its own comment: state
    // already committed for other repos must not be rolled back) -- it always exits 0 here and
    // relays the CLI's outcome via $GITHUB_OUTPUT for a later action.yml step to act on.
    execFileSync("bash", [RUN_HARVEST_SH], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: REPO_ROOT,
        STATE_DIR: stateDir,
        REPOS: "octo/example",
        STORE_KIND: "jsonl",
        STORE_PATH: "store.jsonl",
        ALLOWED_LOGINS: "trusted-bot[bot]",
        ALLOWED_APP_SLUGS: "",
        MAX_API_REQUESTS: "abc", // the Action-input equivalent of the CLI's --max-api-requests abc
        GITHUB_OUTPUT: githubOutputPath,
      },
    });

    const outputs = parseGithubOutput(readFileSync(githubOutputPath, "utf-8"));
    assert.equal(
      outputs["cli-exit-code"],
      "2",
      "the CLI must reject the bad flag at arg-parse time",
    );
    assert.equal(
      outputs["has-errors"],
      "true",
      "an unparseable/missing CLI summary line (because arg parsing failed before any output " +
        "was printed) must be treated as an error, not silently ignored",
    );
    assert.equal(outputs.changed, "false");
  });
});
