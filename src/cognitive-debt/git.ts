// Thin, read-only git plumbing for cognitive-debt-metrics/v0. Every call is a `git` subprocess
// resolved from PATH via `execFile` (no shell, no git library -- same discipline as
// src/aggregates/git.ts). Nothing here reads the working tree or the index: every content read
// is `git show <commit>:<path>` / `git show <blob oid>` against recorded history (design
// section 1 "読む場所").
//
// Argument safety: every revision argument must be a 40-hex object id (`assertObjectId`, checked
// before git is started), so no input string can be read as an option or a revision expression
// (`HEAD`, `-C...`, `x^1`). Paths always go after `--`. The single non-hex revision is the
// literal `HEAD` in `revListFirstParentFromHead`, which takes no revision argument at all.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 256 * 1024 * 1024;

interface GitResult {
  readonly code: number;
  readonly stdout: Buffer;
}

async function run(repo: string, args: readonly string[]): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repo, "-c", "core.quotepath=off", ...args],
      { encoding: "buffer", maxBuffer: MAX_BUFFER, env: { ...process.env, LC_ALL: "C" } },
    );
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer };
    if (typeof e.code === "number") {
      return { code: e.code, stdout: e.stdout ?? Buffer.alloc(0) };
    }
    throw err;
  }
}

async function runOk(repo: string, args: readonly string[]): Promise<Buffer> {
  const r = await run(repo, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${repo} (exit ${r.code})`);
  return r.stdout;
}

const OBJECT_ID = /^[0-9a-f]{40}$/;

/** True for a full, lower-case 40-hex object id -- the only revision form passed to git. */
export function isObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

function assertObjectId(value: string): string {
  if (!isObjectId(value)) throw new TypeError("git revision must be a 40-hex object id");
  return value;
}

export interface CommitDate {
  readonly sha: string;
  /** Committer date, Unix seconds. */
  readonly ct: number;
}

/** True when `repo` is inside a git repository at all. */
export async function isGitRepo(repo: string): Promise<boolean> {
  return (await run(repo, ["rev-parse", "--git-dir"])).code === 0;
}

async function revListFrom(repo: string, rev: string): Promise<CommitDate[]> {
  const head = await run(repo, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]);
  if (head.code !== 0) return [];
  const out = await runOk(repo, ["rev-list", "--first-parent", "--format=%ct", rev, "--"]);
  const lines = out.toString("utf-8").split("\n");
  const commits: CommitDate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.startsWith("commit ")) continue;
    commits.push({ sha: line.slice("commit ".length).trim(), ct: Number(lines[i + 1]) });
    i++;
  }
  return commits;
}

/** `git rev-list --first-parent HEAD` in its output order (from HEAD towards the root), each
 * with its committer date. Empty when HEAD does not resolve (a repo with no commits). */
export async function revListFirstParentFromHead(repo: string): Promise<CommitDate[]> {
  return revListFrom(repo, "HEAD");
}

/** `git rev-list --first-parent <sha>`, same shape as `revListFirstParentFromHead`. */
export async function revListFirstParent(repo: string, sha: string): Promise<CommitDate[]> {
  return revListFrom(repo, assertObjectId(sha));
}

async function showSpec(repo: string, spec: string): Promise<Buffer | null> {
  const r = await run(repo, ["show", "--no-textconv", spec, "--"]);
  return r.code === 0 ? r.stdout : null;
}

/** `git show --no-textconv <blob oid>` as raw bytes (no textconv filter can rewrite them), or
 * null when the object does not exist. */
export async function showBlob(repo: string, oid: string): Promise<Buffer | null> {
  return showSpec(repo, assertObjectId(oid));
}

/** `git show --no-textconv <commit>:<path>` as raw bytes, or null when the path does not exist
 * at that commit. The spec starts with the checked hex id, so `path` cannot become an option. */
export async function showFile(repo: string, commit: string, path: string): Promise<Buffer | null> {
  return showSpec(repo, `${assertObjectId(commit)}:${path}`);
}

export interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  readonly path: string;
}

/** `git ls-tree [-r] -z <commit> -- <path>`. `path` ending in "/" lists that directory's
 * entries. */
export async function lsTree(
  repo: string,
  commit: string,
  path: string,
  recursive: boolean,
): Promise<TreeEntry[]> {
  const args = ["ls-tree", "-z", ...(recursive ? ["-r"] : []), assertObjectId(commit), "--", path];
  const out = await runOk(repo, args);
  const entries: TreeEntry[] = [];
  for (const record of out.toString("utf-8").split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    entries.push({
      mode: mode as string,
      type: type as string,
      oid: oid as string,
      path: record.slice(tab + 1),
    });
  }
  return entries;
}

/** `git log --first-parent --format=%H %ct [--reverse] <commit> -- <path>`. */
export async function logFirstParentForPath(
  repo: string,
  commit: string,
  path: string,
  options: { readonly reverse?: boolean; readonly diffFilter?: string } = {},
): Promise<CommitDate[]> {
  const args = ["log", "--first-parent", "--format=%H %ct"];
  if (options.reverse) args.push("--reverse");
  if (options.diffFilter) args.push(`--diff-filter=${options.diffFilter}`);
  args.push(assertObjectId(commit), "--", path);
  const out = await runOk(repo, args);
  return out
    .toString("utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const [sha, ct] = l.split(" ");
      return { sha: sha as string, ct: Number(ct) };
    });
}

/** `git merge-base --is-ancestor <a> <b>`. Any failure other than "is not an ancestor" (an
 * object that does not exist) is also reported as false -- the caller's question is only
 * whether `a` is reachable from `b`. */
export async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  const args = ["merge-base", "--is-ancestor", assertObjectId(a), assertObjectId(b)];
  return (await run(repo, args)).code === 0;
}

/** Parent shas of `sha` (`git rev-list --parents -n 1`); empty for a root commit. */
export async function parentsOf(repo: string, sha: string): Promise<string[]> {
  const out = await runOk(repo, ["rev-list", "--parents", "-n", "1", assertObjectId(sha), "--"]);
  const parts = out.toString("utf-8").trim().split(" ");
  return parts.slice(1).filter((p) => p.length > 0);
}

/** `git diff --name-only --no-renames -z <a> <b>` (design section 2.2's observation; `a` is the
 * merge commit's first parent as returned by `parentsOf`). */
export async function diffNames(repo: string, a: string, b: string): Promise<string[]> {
  const args = ["diff", "--name-only", "--no-renames", "-z", assertObjectId(a), assertObjectId(b)];
  const out = await runOk(repo, [...args, "--"]);
  return out
    .toString("utf-8")
    .split("\0")
    .filter((p) => p.length > 0);
}
