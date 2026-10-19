// Argument safety of src/cognitive-debt/git.ts and the M2 observation: a revision that is not a
// 40-hex object id never reaches git. A fake `git` first on PATH records every invocation.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  diffNames,
  isAncestor,
  logFirstParentForPath,
  lsTree,
  parentsOf,
  revListFirstParent,
  showBlob,
  showFile,
} from "../../src/cognitive-debt/git.js";
import { observe } from "../../src/cognitive-debt/m2.js";

const HEX = "a".repeat(40);
const REPO = "/nonexistent/cognitive-debt-repo";

describe("cognitive-debt git argument safety", () => {
  let dir: string;
  let log: string;
  let savedPath: string | undefined;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cd-fake-git-"));
    log = path.join(dir, "calls.log");
    const fake = path.join(dir, "git");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`);
    chmodSync(fake, 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;
  });
  after(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => rmSync(log, { force: true }));

  const calls = () => (existsSync(log) ? readFileSync(log, "utf-8") : "");

  it("the fake git is what runs (control: a valid merge_sha does reach it)", async () => {
    assert.deepEqual(await observe(REPO, HEX, "b".repeat(40)), { code: "merge_sha_unreachable" });
    assert.match(calls(), /merge-base --is-ancestor b{40} a{40}/);
  });

  it("merge_sha HEAD / -C... / short / upper case / revision expressions: unreachable, git not started", async () => {
    for (const bad of [
      "HEAD",
      "-C/tmp",
      "--output=/tmp/x",
      "abc1234",
      "A".repeat(40),
      `${HEX}^1`,
    ]) {
      assert.deepEqual(await observe(REPO, HEX, bad), { code: "merge_sha_unreachable" }, bad);
    }
    assert.equal(calls(), "");
  });

  it("every git.ts function refuses a non-hex revision before starting git", async () => {
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["revListFirstParent", () => revListFirstParent(REPO, "HEAD")],
      ["showBlob", () => showBlob(REPO, "-C")],
      ["showFile", () => showFile(REPO, "HEAD", "x")],
      ["lsTree", () => lsTree(REPO, `${HEX}^1`, "x", false)],
      ["logFirstParentForPath", () => logFirstParentForPath(REPO, "--all", "x")],
      ["isAncestor a", () => isAncestor(REPO, "HEAD", HEX)],
      ["isAncestor b", () => isAncestor(REPO, HEX, "-h")],
      ["parentsOf", () => parentsOf(REPO, "HEAD")],
      ["diffNames a", () => diffNames(REPO, "--output=/tmp/x", HEX)],
      ["diffNames b", () => diffNames(REPO, HEX, "HEAD")],
    ];
    for (const [name, attempt] of attempts) {
      await assert.rejects(attempt(), /40-hex object id/, name);
    }
    assert.equal(calls(), "");
  });

  it("paths go after `--`", async () => {
    await logFirstParentForPath(REPO, HEX, "-p").catch(() => {});
    await lsTree(REPO, HEX, "--name-only", false).catch(() => {});
    const lines = calls().trimEnd().split("\n");
    assert.match(lines[0] as string, / a{40} -- -p$/);
    assert.match(lines[1] as string, / a{40} -- --name-only$/);
  });
});
