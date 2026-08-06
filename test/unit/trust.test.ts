import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crossCheckRepositoryAndChange, isTrustedAuthor } from "../../src/application/trust.js";
import { makeComment, makeTokenUsagePayload } from "../support/fixtures.js";

describe("isTrustedAuthor", () => {
  it("trusts a comment posted via an allowlisted GitHub App slug", () => {
    const comment = makeComment({
      id: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      body: "",
      performedViaAppSlug: "my-ci-app",
    });
    assert.equal(isTrustedAuthor(comment, { allowedAppSlugs: ["my-ci-app"] }), true);
  });

  it("trusts a comment from an allowlisted login", () => {
    const comment = makeComment({
      id: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      body: "",
      authorLogin: "ci-bot[bot]",
    });
    assert.equal(isTrustedAuthor(comment, { allowedLogins: ["ci-bot[bot]"] }), true);
  });

  it("does not trust an unlisted author", () => {
    const comment = makeComment({
      id: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      body: "",
      authorLogin: "random-user",
    });
    assert.equal(isTrustedAuthor(comment, { allowedLogins: ["ci-bot[bot]"] }), false);
  });

  it("does not trust anyone when no allowlist is configured at all", () => {
    const comment = makeComment({ id: 1, updatedAt: "2026-01-01T00:00:00Z", body: "" });
    assert.equal(isTrustedAuthor(comment, {}), false);
  });
});

describe("crossCheckRepositoryAndChange", () => {
  it("accepts a payload whose repository/change match the comment's actual location", () => {
    const payload = makeTokenUsagePayload({ repository: "octo/example", changeNumber: 42 });
    const comment = makeComment({
      id: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      body: "",
      issueNumber: 42,
    });
    const result = crossCheckRepositoryAndChange(payload, {
      repositoryFullName: "octo/example",
      comment,
    });
    assert.equal(result.ok, true);
  });

  it("rejects a payload claiming a different repository than the comment appeared on", () => {
    const payload = makeTokenUsagePayload({ repository: "octo/other" });
    const comment = makeComment({ id: 1, updatedAt: "2026-01-01T00:00:00Z", body: "" });
    const result = crossCheckRepositoryAndChange(payload, {
      repositoryFullName: "octo/example",
      comment,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "repository_mismatch");
  });

  it("rejects a payload whose change.number does not match the comment's issue/PR", () => {
    const payload = makeTokenUsagePayload({ repository: "octo/example", changeNumber: 99 });
    const comment = makeComment({
      id: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      body: "",
      issueNumber: 42,
    });
    const result = crossCheckRepositoryAndChange(payload, {
      repositoryFullName: "octo/example",
      comment,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "change_mismatch");
  });

  it("rejects a payload claiming change.type=pull_request when the comment actually appeared on a plain issue with the same number (must-4 regression)", () => {
    // The repo-wide issue-comments endpoint returns comments on plain issues and PRs
    // indiscriminately, and issue/PR numbers share one namespace per repository -- so a
    // marker posted on issue #42 claiming to be about pull_request #42 used to pass this
    // cross-check purely because the *numbers* matched, even though it is not actually about
    // any pull request at all.
    const payload = makeTokenUsagePayload({ repository: "octo/example", changeNumber: 42 });
    const comment = makeComment({
      id: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      body: "",
      issueNumber: 42,
      isPullRequest: false,
    });
    const result = crossCheckRepositoryAndChange(payload, {
      repositoryFullName: "octo/example",
      comment,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "change_type_mismatch");
  });

  it("accepts a pull_request-claiming payload when the comment did appear on that pull request", () => {
    const payload = makeTokenUsagePayload({ repository: "octo/example", changeNumber: 42 });
    const comment = makeComment({
      id: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      body: "",
      issueNumber: 42,
      isPullRequest: true,
    });
    const result = crossCheckRepositoryAndChange(payload, {
      repositoryFullName: "octo/example",
      comment,
    });
    assert.equal(result.ok, true);
  });
});
