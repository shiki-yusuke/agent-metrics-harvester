// Git plumbing for `scripts/push-aggregate.mjs` -- every git operation runs as a subprocess
// (`execFile`, never a git library dependency: zero-dep policy) against a scratch working
// directory this module fully owns (removed and recreated on every call). Mirrors
// action/prepare-state.sh + action/commit-state.sh's own checkout-orphan-if-missing / append /
// commit-if-changed / push shape, but as one Node function instead of two bash scripts, since
// push-aggregate runs both from a developer's laptop and from the dashboard workflow.

import { execFile } from "node:child_process";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_AUTHOR_NAME = "agent-metrics-harvester";
const DEFAULT_AUTHOR_EMAIL = "actions@users.noreply.github.com";

export interface AppendAggregateOptions {
  /** Anything `git clone`/`git ls-remote` accepts: an authenticated HTTPS URL, an SSH remote,
   * or a local path (the last is what test/e2e/push-aggregate.test.ts points at a temp bare
   * repo). Building an authenticated URL out of a token is the CLI's job (scripts/
   * push-aggregate.mjs), not this module's -- this module never reads an env var itself. */
  readonly repoUrl: string;
  readonly branch: string;
  /** A scratch directory this call owns outright: removed and recreated at the start of the
   * call, left on disk (with the fresh clone in it) when the call returns, for the caller to
   * clean up or inspect. */
  readonly workDir: string;
  /** Path of the aggregates file within the branch, e.g. "aggregates/2026-08.jsonl". */
  readonly relativePath: string;
  /** One already-serialized JSON line, WITHOUT a trailing newline -- this function appends
   * exactly one "\n"-terminated line, never more than one, per call. */
  readonly line: string;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly commitMessage?: string;
}

export interface AppendAggregateResult {
  readonly branchCreated: boolean;
  /** False only if there were somehow no local changes to push (defensive; an append always
   * grows the target file, so this should never actually be observed). */
  readonly pushed: boolean;
}

async function git(args: readonly string[], cwd: string): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd });
  return { stdout };
}

/** `git ls-remote --exit-code --heads` exits 2 specifically when the ref does not exist on the
 * remote; any other non-zero exit (bad URL, auth failure, network error) is a real failure this
 * must not swallow as "branch missing," or a broken remote would look identical to a first run
 * and this function would happily try to re-initialize an orphan branch against it. */
async function branchExistsOnRemote(repoUrl: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-remote", "--exit-code", "--heads", repoUrl, branch]);
    return true;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 2) return false;
    throw err;
  }
}

export async function appendAggregateLine(
  opts: AppendAggregateOptions,
): Promise<AppendAggregateResult> {
  const authorName = opts.authorName ?? DEFAULT_AUTHOR_NAME;
  const authorEmail = opts.authorEmail ?? DEFAULT_AUTHOR_EMAIL;
  const authorConfigArgs = [`user.name=${authorName}`, `user.email=${authorEmail}`];

  await rm(opts.workDir, { recursive: true, force: true });
  await mkdir(opts.workDir, { recursive: true });

  const branchCreated = !(await branchExistsOnRemote(opts.repoUrl, opts.branch));

  if (branchCreated) {
    await git(["clone", "--depth", "1", opts.repoUrl, "."], opts.workDir);
    await git(["checkout", "--orphan", opts.branch], opts.workDir);
    try {
      await git(["rm", "-rf", "."], opts.workDir);
    } catch {
      // A brand-new default branch with nothing tracked yet fails `git rm -rf .` -- fine, there
      // was nothing to remove (same tolerance action/prepare-state.sh applies for this case).
    }
    await writeFile(
      path.join(opts.workDir, "README.md"),
      "# agent-metrics-harvester aggregates branch\n\n" +
        "This branch holds only sanitized, append-only aggregate observations " +
        "(attribution-audit summaries, calibration points, heartbeats -- counts and digests\n" +
        "only, never a raw intent id or session id) written by `scripts/push-aggregate.mjs` and\n" +
        "the dashboard GitHub Action. Do not edit it by hand.\n",
    );
    await git(["add", "README.md"], opts.workDir);
    await git(
      [
        "-c",
        authorConfigArgs[0] as string,
        "-c",
        authorConfigArgs[1] as string,
        "commit",
        "-m",
        "Initialize aggregates branch",
      ],
      opts.workDir,
    );
  } else {
    await git(
      ["clone", "--branch", opts.branch, "--single-branch", "--depth", "1", opts.repoUrl, "."],
      opts.workDir,
    );
  }

  const targetPath = path.join(opts.workDir, opts.relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await appendFile(targetPath, `${opts.line}\n`, "utf-8");

  await git(["add", opts.relativePath], opts.workDir);

  const status = await git(["status", "--porcelain"], opts.workDir);
  if (status.stdout.trim().length === 0) {
    return { branchCreated, pushed: false };
  }

  await git(
    [
      "-c",
      authorConfigArgs[0] as string,
      "-c",
      authorConfigArgs[1] as string,
      "commit",
      "-m",
      opts.commitMessage ?? `push-aggregate: append to ${opts.relativePath}`,
    ],
    opts.workDir,
  );
  await git(["push", "origin", `HEAD:${opts.branch}`], opts.workDir);

  return { branchCreated, pushed: true };
}
