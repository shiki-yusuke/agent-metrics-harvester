// Trust model (docs/protocols/agent-metrics-v1.md section 7): authentication is a
// transport-layer concern, never a payload-layer one. sha256 in the envelope is a checksum,
// not a signature -- it proves the payload wasn't corrupted, not who posted it. These checks
// run in the harvester, independently of whatever the emitter itself may have checked, and a
// payload's own internal fields are never sufficient proof of where it's allowed to land.

import type { AuthConfig, RawComment } from "./types.js";
import type { Change, Repository } from "../protocol/types.js";

export function isTrustedAuthor(comment: RawComment, config: AuthConfig): boolean {
  if (
    comment.performedViaAppSlug &&
    config.allowedAppSlugs?.length &&
    config.allowedAppSlugs.includes(comment.performedViaAppSlug)
  ) {
    return true;
  }
  if (config.allowedLogins?.length && config.allowedLogins.includes(comment.authorLogin)) {
    return true;
  }
  return false;
}

export interface CrossCheckResult {
  readonly ok: boolean;
  readonly code?: "repository_mismatch" | "change_mismatch";
  readonly detail?: string;
}

/** Cross-checks the payload's own `repository`/`change` fields against the change the
 * comment actually appeared on. A payload can claim to be about any repository/PR it likes --
 * this is what stops that claim from being trusted at face value. */
export function crossCheckRepositoryAndChange(
  payload: { repository: Repository; change?: Change },
  actual: { repositoryFullName: string; comment: RawComment },
): CrossCheckResult {
  if (payload.repository.provider !== "github") {
    return { ok: false, code: "repository_mismatch", detail: `unexpected provider "${payload.repository.provider}"` };
  }
  if (payload.repository.id !== actual.repositoryFullName) {
    return {
      ok: false,
      code: "repository_mismatch",
      detail: `payload.repository.id=${payload.repository.id} !== actual=${actual.repositoryFullName}`,
    };
  }
  if (payload.change?.number !== undefined && payload.change.number !== actual.comment.issueNumber) {
    return {
      ok: false,
      code: "change_mismatch",
      detail: `payload.change.number=${payload.change.number} !== actual issue/PR #${actual.comment.issueNumber}`,
    };
  }
  return { ok: true };
}
