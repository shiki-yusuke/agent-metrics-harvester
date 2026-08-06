// Versioned team-config file (spec §6: "team = versioned config の repo 集合（1 repo の複数
// team 所属は拒否）"). Hand-rolled parser for exactly one fixed, narrow shape -- not a general
// YAML parser -- matching this project's existing "minimal hand-rolled subset, not a generic
// engine" pattern (schema.ts's validator, the vendored verify-fixtures.mjs). Anything outside
// this exact shape is rejected outright (fail-closed) rather than guessed at.
//
//   version: 1
//   teams:
//     - name: platform
//       repositories:
//         - octo-org/repo-a
//         - octo-org/repo-b
//     - name: growth
//       repositories:
//         - octo-org/repo-c
//
// Deviation from the literal spec text (reported to team-lead): the spec calls this file
// "yaml", but this repository's dependency policy allows no runtime dependency beyond
// better-sqlite3, so there is no YAML library to parse arbitrary YAML with. This module
// implements only the fixed two-level list shape above -- sufficient for what a team config
// actually needs to express -- rather than silently accepting the file as JSON (which would
// make the ".yaml" extension a lie) or adding a dependency the project's stated policy forbids.

import { canonicalizeJcs, sha256Hex } from "../protocol/canonical.js";

export class InvalidTeamConfigError extends Error {}

export interface Team {
  readonly name: string;
  readonly repositories: readonly string[];
}

export interface TeamConfig {
  readonly version: number;
  readonly teams: readonly Team[];
}

interface Line {
  readonly indent: number;
  readonly content: string;
  readonly lineNumber: number;
}

function tokenize(text: string): Line[] {
  const lines: Line[] = [];
  const rawLines = text.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] as string;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    lines.push({
      indent: raw.length - raw.trimStart().length,
      content: trimmed,
      lineNumber: i + 1,
    });
  }
  return lines;
}

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

export function parseTeamConfigYaml(text: string): TeamConfig {
  const lines = tokenize(text);
  const fail = (message: string, lineNumber?: number): never => {
    throw new InvalidTeamConfigError(
      lineNumber !== undefined
        ? `team-config line ${lineNumber}: ${message}`
        : `team-config: ${message}`,
    );
  };

  if (lines.length === 0) fail("file is empty");

  let i = 0;
  const versionLine = lines[i] as Line;
  const versionMatch = versionLine.content.match(/^version:\s*(\d+)\s*$/);
  if (!versionMatch)
    fail('expected "version: <n>" as the first non-comment line', versionLine.lineNumber);
  const version = Number((versionMatch as RegExpMatchArray)[1]);
  if (version !== 1)
    fail(
      `unsupported team-config version ${version} (only version 1 is supported)`,
      versionLine.lineNumber,
    );
  i++;

  const teamsLine = lines[i];
  if (!teamsLine || teamsLine.content !== "teams:")
    fail('expected "teams:"', teamsLine?.lineNumber);
  const teamsIndent = (teamsLine as Line).indent;
  i++;

  const teams: Team[] = [];
  while (i < lines.length) {
    const nameLine = lines[i] as Line;
    const nameMatch = nameLine.content.match(/^-\s*name:\s*(.+)$/);
    if (!nameMatch || nameLine.indent <= teamsIndent) {
      fail('expected "- name: <team>"', nameLine.lineNumber);
    }
    const name = ((nameMatch as RegExpMatchArray)[1] ?? "").trim();
    if (name.length === 0) fail("team name must not be empty", nameLine.lineNumber);
    const teamIndent = nameLine.indent;
    i++;

    const reposLine = lines[i];
    if (!reposLine || reposLine.content !== "repositories:" || reposLine.indent <= teamIndent) {
      fail(
        `expected "repositories:" under team "${name}"`,
        reposLine?.lineNumber ?? nameLine.lineNumber,
      );
    }
    const reposIndent = (reposLine as Line).indent;
    i++;

    const repositories: string[] = [];
    while (
      i < lines.length &&
      (lines[i] as Line).indent > reposIndent &&
      /^-\s+\S/.test((lines[i] as Line).content)
    ) {
      const itemLine = lines[i] as Line;
      const repoMatch = itemLine.content.match(/^-\s+(.+)$/);
      const repo = ((repoMatch as RegExpMatchArray)[1] as string).trim();
      if (!REPO_RE.test(repo)) {
        fail(`invalid repository "${repo}" (expected "owner/repo")`, itemLine.lineNumber);
      }
      repositories.push(repo);
      i++;
    }
    if (repositories.length === 0) fail(`team "${name}" has no repositories`, nameLine.lineNumber);

    teams.push({ name, repositories });
  }

  if (teams.length === 0) fail("no teams defined", teamsLine?.lineNumber);

  const seenNames = new Set<string>();
  const seenRepos = new Map<string, string>(); // repository -> owning team name
  for (const team of teams) {
    if (seenNames.has(team.name)) fail(`duplicate team name "${team.name}"`);
    seenNames.add(team.name);

    const seenInTeam = new Set<string>();
    for (const repo of team.repositories) {
      if (seenInTeam.has(repo))
        fail(`team "${team.name}" lists repository "${repo}" more than once`);
      seenInTeam.add(repo);

      const owner = seenRepos.get(repo);
      if (owner !== undefined) {
        fail(
          `repository "${repo}" belongs to both team "${owner}" and team "${team.name}" -- a repository may belong to only one team`,
        );
      }
      seenRepos.set(repo, team.name);
    }
  }

  return { version, teams };
}

/** Selects one team's repository set from a (possibly multi-team) config. If the config
 * defines exactly one team, `teamName` is optional and that team is used automatically; a
 * multi-team config requires `teamName` to disambiguate, and fails closed (rather than
 * silently picking one) if it is missing or unknown. */
export function selectTeam(config: TeamConfig, teamName?: string): Team {
  if (teamName === undefined) {
    if (config.teams.length === 1) return config.teams[0] as Team;
    throw new InvalidTeamConfigError(
      `--team-config defines ${config.teams.length} teams (${config.teams.map((t) => t.name).join(", ")}); --team <name> is required to select one`,
    );
  }
  const team = config.teams.find((t) => t.name === teamName);
  if (!team) {
    throw new InvalidTeamConfigError(
      `--team "${teamName}" not found in team-config (available: ${config.teams.map((t) => t.name).join(", ")})`,
    );
  }
  return team;
}

/** Deterministic hash of a team config's *content* (not the raw file bytes) -- teams/
 * repositories sorted first, so semantically-identical configs written in a different line
 * order still hash identically. Part of a report's input_fingerprint (spec §5) and the
 * cross-comparison compatibility guard (spec §4: comparisons require the same team-config
 * hash). */
export function teamConfigHash(config: TeamConfig): string {
  const canonical = {
    version: config.version,
    teams: [...config.teams]
      .map((t) => ({ name: t.name, repositories: [...t.repositories].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  return sha256Hex(canonicalizeJcs(canonical));
}
