// Orchestrates the full accept/reject pipeline for one comment body: marker framing ->
// base64/sha256 -> JSON parse -> schema validation -> personal-dimension scan -> limits ->
// upsert_key recomputation. Mirrors test/contract/vendor/verify-fixtures.mjs's `checkPayload`
// pipeline; test/contract asserts this implementation and that vendored oracle agree on every
// fixture in test/contract/vendor/fixtures/expected-results.json.

import { computeUpsertKey } from "./canonical.js";
import { decodeEnvelopeFields, parseMarker } from "./envelope.js";
import { checkDepth, checkLimits } from "./limits.js";
import { scanPersonalDimensions } from "./personal-dimension.js";
import { validateEnvelope, validateTokenUsagePayload } from "./schema.js";
import type {
  DecodeOutcome,
  RejectionReason,
  Repository,
  Subject,
  TokenUsagePayload,
} from "./types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function dedupe(reasons: RejectionReason[]): RejectionReason[] {
  const seen = new Set<string>();
  const out: RejectionReason[] = [];
  for (const r of reasons) {
    const key = `${r.code}:${r.detail ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Runs the full check pipeline against an already-decoded (marker-unwrapped or bare) JSON
 * payload object. Shared by marker-wrapped and bare-payload fixture/production paths. */
export function checkPayload(payload: unknown, rawByteLength: number): RejectionReason[] {
  // Size/depth limits run FIRST and, if violated, short-circuit everything else -- in
  // particular, before scanPersonalDimensions below ever gets a chance to walk the payload.
  // checkLimits' depth check is itself iterative/crash-safe (limits.ts), but there is no
  // reason to let a payload that is already going to be rejected for being too deep also pay
  // for (or risk) a second full walk; this mirrors "malformed input, reject outright, don't
  // attempt further interpretation" already used for an unsupported schema kind below. See
  // test/unit/deep-nesting-crash.test.ts.
  const limitViolations = checkLimits(payload, rawByteLength);
  if (limitViolations.length > 0) {
    return dedupe(limitViolations.map((l) => ({ code: l.code, detail: l.detail })));
  }

  const reasons: RejectionReason[] = [];

  const schemaValue = isRecord(payload) ? payload.schema : undefined;
  if (schemaValue !== "token-usage/v1") {
    // Well-formed envelope but unsupported kind MUST be routed to rejection without
    // attempting to interpret `data` (protocol doc section 6) -- still schema-validate at
    // the envelope level so "malformed envelope" is distinguishable from "well-formed
    // envelope, unsupported kind", same split as the vendored oracle.
    reasons.push({ code: "unsupported_schema_kind" });
    for (const e of validateEnvelope(payload))
      reasons.push({ code: "schema_validation_failed", detail: e });
    for (const v of scanPersonalDimensions(payload)) {
      reasons.push({ code: "personal_dimension_forbidden_key", detail: v });
    }
    return dedupe(reasons);
  }

  for (const e of validateTokenUsagePayload(payload))
    reasons.push({ code: "schema_validation_failed", detail: e });
  for (const v of scanPersonalDimensions(payload)) {
    reasons.push({ code: "personal_dimension_forbidden_key", detail: v });
  }

  if (
    isRecord(payload) &&
    typeof payload.upsert_key === "string" &&
    isRecord(payload.repository) &&
    isRecord(payload.subject)
  ) {
    const recomputed = computeUpsertKey({
      schema: schemaValue,
      repository: payload.repository as unknown as Repository,
      subject: payload.subject as unknown as Subject,
    });
    if (recomputed !== payload.upsert_key) {
      reasons.push({
        code: "upsert_key_mismatch",
        detail: `declared=${payload.upsert_key} recomputed=${recomputed}`,
      });
    }
  }

  return dedupe(reasons);
}

/** Full pipeline starting from raw comment text: marker parse -> envelope decode -> checkPayload. */
export function decodeMarker(commentBody: string): DecodeOutcome {
  const parsed = parseMarker(commentBody);
  if (parsed.ignored) return { kind: "ignored" };

  const decoded = decodeEnvelopeFields(parsed.fields);
  if (!decoded.ok) return { kind: "rejected", reasons: [{ code: decoded.code }] };

  let payload: unknown;
  try {
    payload = JSON.parse(decoded.bytes.toString("utf-8"));
  } catch {
    return { kind: "rejected", reasons: [{ code: "payload_not_valid_json" }] };
  }

  const reasons = checkPayload(payload, decoded.bytes.length);
  if (reasons.length > 0) return { kind: "rejected", reasons };
  return { kind: "accepted", payload: payload as TokenUsagePayload, rawBytes: decoded.bytes };
}

/** Same pipeline for a bare (non-marker-wrapped) JSON payload -- used for the "payload"-kind
 * conformance fixtures, and reusable anywhere a payload is already in hand. */
export function decodePayloadObject(payload: unknown): DecodeOutcome {
  // Depth must be checked BEFORE anything below stringifies `payload`: unlike checkLimits'
  // own depth check (iterative/crash-safe), JSON.stringify is a recursive V8 built-in and can
  // itself overflow the call stack on an attacker-controlled arbitrarily-deep object -- this
  // used to happen right here, computing rawByteLength, before checkPayload's (safe) depth
  // check ever ran. See test/unit/deep-nesting-crash.test.ts.
  const depthViolation = checkDepth(payload);
  if (depthViolation) return { kind: "rejected", reasons: [depthViolation] };

  const rawByteLength = Buffer.byteLength(JSON.stringify(payload), "utf-8");
  const reasons = checkPayload(payload, rawByteLength);
  if (reasons.length > 0) return { kind: "rejected", reasons };
  return {
    kind: "accepted",
    payload: payload as TokenUsagePayload,
    rawBytes: Buffer.from(JSON.stringify(payload), "utf-8"),
  };
}
