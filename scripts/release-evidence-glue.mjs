#!/usr/bin/env node
// Release-evidence deploy-adapter glue for the dashboard workflow (D5 / release-evidence/v0).
//
//   assemble  (build job)   -- measure dashboard-dist, place release-manifest.json into it,
//                              assemble + seal the evidence bundle, record `prepared`.
//   finalize  (evidence job) -- after the real Pages deploy: fetch release-manifest.json from
//                              the LIVE site, verify wrapper + JCS(content) == the sealed
//                              bundle's artifact digest + one content spot-check, then record
//                              `deployed` (preview_skipped: this target has no preview tier)
//                              and `verified` -- or `failed(verification)` when the read-back
//                              does not hold. The deploy DID happen either way, so `deployed`
//                              is recorded in both branches; only the verdict differs.
//
// This script deliberately spawns the release-evidence CLI for every ledger write instead of
// importing its core: the CLI is the supported boundary (transition + gate checks run before
// any append; an illegal record exits 3 and writes nothing), and this glue must not be able to
// bypass it. The only library import is the vendored JCS, for recomputing the content digest.
//
// Zero npm dependencies; runs on node >= 22 (global fetch).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback;
    console.error(`missing required argument --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const sha256 = (buf) => `sha256:${createHash("sha256").update(buf).digest("hex")}`;

function cli(reDir, args) {
  try {
    return execFileSync("node", [path.join(reDir, "dist/src/cli/main.js"), ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (err) {
    // CLI の拒否 (遷移違反 exit 3 / 使い方 exit 2) は glue の stack trace ではなく
    // CLI 自身の stderr (inherit 済み) が説明する。同じ code で静かに伝播する。
    const status = typeof err?.status === "number" ? err.status : 1;
    console.error(`release-evidence CLI exited ${status} (command: ${args[0]} ${args[1] ?? ""})`);
    process.exit(status);
  }
}

async function assemble() {
  const reDir = arg("re");
  const site = arg("site");
  const repo = arg("repo");
  const commit = arg("commit");
  const tree = arg("tree");
  const recipeFile = arg("recipe-file");
  const runId = arg("run-id");
  const outDir = arg("out");
  const previous = arg("previous", "");
  mkdirSync(outDir, { recursive: true });

  // 1. measure the built site and place release-manifest.json into it (one CLI command;
  //    the CLI round-trips the write immediately so a broken write cannot slip through).
  const m = JSON.parse(cli(reDir, ["manifest", site, "--write"]));

  // 2. pin what was run and what ran it. The toolchain descriptor is written out and hashed,
  //    exactly as the contract's build.toolchain_digest asks (a recorded descriptor, not prose).
  const toolchainDescriptor = [
    `node=${process.version}`,
    `package-lock.json=${sha256(readFileSync("package-lock.json"))}`,
  ].join("\n");
  const toolchainPath = path.join(outDir, "toolchain.txt");
  writeFileSync(toolchainPath, `${toolchainDescriptor}\n`);

  const releaseId = `agent-metrics-dashboard@${runId}`;
  const bundle = {
    schema_version: "release-evidence/v0",
    release_id: releaseId,
    source: { repo, commit_sha: commit, tree_digest: tree, resolution: "git_tree" },
    lane_ref: null,
    lane_ref_omitted: {
      code: "no_lane_scheduled_rebuild",
      note: "Scheduled/dispatched dashboard rebuild from main; no lane exists per rebuild. Each contributing PR carried its own lane where one applied.",
    },
    review: null,
    review_omitted: {
      code: "scheduled_rebuild_deploys_reviewed_main",
      note: "This deploy ships whatever main already contains; per-change review happened on the PRs that reached main, not on this rebuild.",
    },
    artifacts: [
      {
        kind: "static_site",
        digest: m.digest,
        content_manifest_digest: m.content_manifest_digest,
      },
    ],
    build: {
      recipe_digest: sha256(readFileSync(recipeFile)),
      recipe_ref: recipeFile,
      toolchain_digest: sha256(readFileSync(toolchainPath)),
      toolchain_ref: "toolchain.txt (recorded alongside the ledger)",
    },
    known_deviations: [],
    rollback: { previous_release_id: previous === "" ? null : previous },
    integrity: { level: "digest_only", signature: null },
  };
  const bundlePath = path.join(outDir, "bundle.json");
  writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);

  // 3. seal: prepare validates the bundle against the contract schema and appends `prepared`.
  const ledgerPath = path.join(outDir, "release-events.jsonl");
  const prep = JSON.parse(
    cli(reDir, ["prepare", "--bundle", bundlePath, "--ledger", ledgerPath, "--actor", "ci"]),
  );

  const outputs = {
    release_id: releaseId,
    bundle_digest: prep.bundle_digest,
    artifact_digest: m.digest,
    content_manifest_digest: m.content_manifest_digest,
  };
  writeFileSync(path.join(outDir, "outputs.json"), `${JSON.stringify(outputs, null, 2)}\n`);
  console.log(JSON.stringify(outputs, null, 2));
}

async function finalize() {
  const reDir = arg("re");
  const outDir = arg("out");
  const pageUrl = arg("page-url").replace(/\/?$/, "/");

  const outputs = JSON.parse(readFileSync(path.join(outDir, "outputs.json"), "utf-8"));
  const bundlePath = path.join(outDir, "bundle.json");
  const ledgerPath = path.join(outDir, "release-events.jsonl");
  const bundle = JSON.parse(readFileSync(bundlePath, "utf-8"));

  // The deploy already happened (the deploy job succeeded before this job runs), so `deployed`
  // is a fact regardless of what the read-back finds. preview_skipped: Pages has no preview
  // tier for this site -- the exact case the contract's preview_skipped models.
  cli(reDir, [
    "record",
    "deployed",
    "--ledger",
    ledgerPath,
    "--release-id",
    outputs.release_id,
    "--bundle-digest",
    outputs.bundle_digest,
    "--environment",
    "production",
    "--preview-skipped",
    "--preview-skipped-code",
    "no_preview_environment_scheduled_rebuild",
    "--bundle",
    bundlePath,
    "--actor",
    "ci",
  ]);

  // Read back from the LIVE site: wrapper shape, content digest == the sealed artifact digest,
  // and one content spot-check (index.html's bytes hash to what the manifest recorded).
  const problems = [];
  let wrapper = null;
  const res = await fetch(`${pageUrl}release-manifest.json`, { redirect: "follow" });
  if (!res.ok) {
    problems.push(`release-manifest.json fetch failed: HTTP ${res.status}`);
  } else {
    wrapper = await res.json();
    const keys = Object.keys(wrapper).sort().join(",");
    if (keys !== "content,schema_version") problems.push(`unexpected wrapper keys: ${keys}`);
    if (wrapper.schema_version !== "release-evidence/v0")
      problems.push(`wrong schema_version: ${wrapper.schema_version}`);
  }
  if (wrapper && problems.length === 0) {
    const { canonicalize, sha256hex } = await import(
      path.resolve(reDir, "vendor/playbook-shared/jcs.mjs")
    );
    const live = `sha256:${sha256hex(canonicalize(wrapper.content))}`;
    if (live !== bundle.artifacts[0].digest) {
      problems.push(
        `live content digest ${live} != sealed artifact digest ${bundle.artifacts[0].digest}`,
      );
    }
    const spot = "index.html";
    const expected = wrapper.content[spot];
    if (typeof expected !== "string") {
      problems.push(`manifest has no entry for spot-check file ${spot}`);
    } else {
      const body = Buffer.from(await (await fetch(`${pageUrl}${spot}`)).arrayBuffer());
      const got = sha256(body);
      if (got !== expected)
        problems.push(`spot-check ${spot}: live ${got} != manifest ${expected}`);
    }
  }

  if (problems.length === 0) {
    cli(reDir, [
      "record",
      "verified",
      "--ledger",
      ledgerPath,
      "--release-id",
      outputs.release_id,
      "--bundle-digest",
      outputs.bundle_digest,
      "--environment",
      "production",
      "--actor",
      "ci",
    ]);
    console.log(`read-back verified: ${outputs.release_id} (${outputs.artifact_digest})`);
    return;
  }
  cli(reDir, [
    "record",
    "failed",
    "--ledger",
    ledgerPath,
    "--release-id",
    outputs.release_id,
    "--bundle-digest",
    outputs.bundle_digest,
    "--environment",
    "production",
    "--failure-phase",
    "verification",
    "--reason",
    `read-back failed: ${problems.join("; ")}`,
    "--actor",
    "ci",
  ]);
  console.error("read-back FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const mode = process.argv[2];
if (mode === "assemble") await assemble();
else if (mode === "finalize") await finalize();
else {
  console.error("usage: release-evidence-glue.mjs <assemble|finalize> --re <dir> ...");
  process.exit(2);
}
