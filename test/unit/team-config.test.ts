import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidTeamConfigError,
  parseTeamConfigYaml,
  selectTeam,
  teamConfigHash,
} from "../../src/report/team-config.js";

const VALID = `
version: 1
teams:
  - name: platform
    repositories:
      - octo-org/repo-a
      - octo-org/repo-b
  - name: growth
    repositories:
      - octo-org/repo-c
`;

describe("parseTeamConfigYaml", () => {
  it("parses the fixed two-level shape", () => {
    const config = parseTeamConfigYaml(VALID);
    assert.equal(config.version, 1);
    assert.equal(config.teams.length, 2);
    assert.deepEqual(config.teams[0], {
      name: "platform",
      repositories: ["octo-org/repo-a", "octo-org/repo-b"],
    });
    assert.deepEqual(config.teams[1], { name: "growth", repositories: ["octo-org/repo-c"] });
  });

  it("tolerates blank lines and comment lines", () => {
    const withComments = `
# top-level comment
version: 1

teams:
  # a comment between teams
  - name: platform
    repositories:
      - octo-org/repo-a
`;
    const config = parseTeamConfigYaml(withComments);
    assert.equal(config.teams.length, 1);
  });

  it("rejects an unsupported version", () => {
    assert.throws(
      () =>
        parseTeamConfigYaml("version: 2\nteams:\n  - name: a\n    repositories:\n      - o/r\n"),
      InvalidTeamConfigError,
    );
  });

  it("rejects a repository belonging to two teams", () => {
    const dup = `
version: 1
teams:
  - name: platform
    repositories:
      - octo-org/repo-a
  - name: growth
    repositories:
      - octo-org/repo-a
`;
    assert.throws(() => parseTeamConfigYaml(dup), InvalidTeamConfigError);
  });

  it("rejects a duplicate team name", () => {
    const dup = `
version: 1
teams:
  - name: platform
    repositories:
      - octo-org/repo-a
  - name: platform
    repositories:
      - octo-org/repo-b
`;
    assert.throws(() => parseTeamConfigYaml(dup), InvalidTeamConfigError);
  });

  it("rejects a team with zero repositories", () => {
    const empty = "version: 1\nteams:\n  - name: platform\n    repositories:\n";
    assert.throws(() => parseTeamConfigYaml(empty), InvalidTeamConfigError);
  });

  it("rejects a malformed repository (not owner/repo)", () => {
    const bad = "version: 1\nteams:\n  - name: platform\n    repositories:\n      - not-a-repo\n";
    assert.throws(() => parseTeamConfigYaml(bad), InvalidTeamConfigError);
  });

  it("rejects a missing 'teams:' line", () => {
    assert.throws(() => parseTeamConfigYaml("version: 1\n"), InvalidTeamConfigError);
  });

  it("rejects an empty file", () => {
    assert.throws(() => parseTeamConfigYaml(""), InvalidTeamConfigError);
    assert.throws(() => parseTeamConfigYaml("   \n\n"), InvalidTeamConfigError);
  });
});

describe("selectTeam", () => {
  it("auto-selects the only team when no name is given", () => {
    const single = parseTeamConfigYaml(
      "version: 1\nteams:\n  - name: platform\n    repositories:\n      - o/r\n",
    );
    assert.deepEqual(selectTeam(single), { name: "platform", repositories: ["o/r"] });
  });

  it("requires --team when the config defines more than one team", () => {
    const config = parseTeamConfigYaml(VALID);
    assert.throws(() => selectTeam(config), InvalidTeamConfigError);
  });

  it("selects the named team", () => {
    const config = parseTeamConfigYaml(VALID);
    assert.deepEqual(selectTeam(config, "growth"), {
      name: "growth",
      repositories: ["octo-org/repo-c"],
    });
  });

  it("fails closed on an unknown team name", () => {
    const config = parseTeamConfigYaml(VALID);
    assert.throws(() => selectTeam(config, "nonexistent"), InvalidTeamConfigError);
  });
});

describe("teamConfigHash", () => {
  it("is deterministic for the same content", () => {
    const a = parseTeamConfigYaml(VALID);
    const b = parseTeamConfigYaml(VALID);
    assert.equal(teamConfigHash(a), teamConfigHash(b));
  });

  it("is order-independent (team order, repository order)", () => {
    const reordered = `
version: 1
teams:
  - name: growth
    repositories:
      - octo-org/repo-c
  - name: platform
    repositories:
      - octo-org/repo-b
      - octo-org/repo-a
`;
    const a = parseTeamConfigYaml(VALID);
    const b = parseTeamConfigYaml(reordered);
    assert.equal(teamConfigHash(a), teamConfigHash(b));
  });

  it("differs when content differs", () => {
    const other =
      "version: 1\nteams:\n  - name: platform\n    repositories:\n      - octo-org/repo-z\n";
    const a = parseTeamConfigYaml(VALID);
    const b = parseTeamConfigYaml(other);
    assert.notEqual(teamConfigHash(a), teamConfigHash(b));
  });
});
