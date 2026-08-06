// Envelope (marker) framing -- docs/protocols/agent-metrics-v1.md section 2:
//   <!-- agent-metrics:v1 payload_b64=<base64> sha256=<lowercase 64-hex> -->
// An HTML comment that does not open with the literal tag "agent-metrics:v1" is not a marker
// this protocol defines and MUST be ignored, not treated as malformed (legacy-marker-ignored
// fixture) -- other tools post their own hidden comments on the same PR/change.

import { sha256Hex } from "./canonical.js";

const MARKER_RE = /<!--\s*agent-metrics:v1\s+([\s\S]*?)\s*-->/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ParsedMarker {
  readonly ignored: boolean;
  readonly fields: Readonly<Record<string, string>>;
}

/** Scans arbitrary comment text for the agent-metrics:v1 tag. `ignored: true` means "not a
 * marker this protocol owns" -- the caller must skip it silently, never error on it. */
export function parseMarker(commentBody: string): ParsedMarker {
  const m = commentBody.match(MARKER_RE);
  if (!m) return { ignored: true, fields: {} };
  const body = m[1] ?? "";
  const fields: Record<string, string> = {};
  for (const match of body.matchAll(/([a-z_][a-z0-9_]*)=(\S+)/g)) {
    fields[match[1] as string] = match[2] as string;
  }
  return { ignored: false, fields };
}

export type EnvelopeDecodeResult =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly code: "envelope_fields_missing" | "envelope_base64_decode_failed" | "envelope_hash_mismatch" };

/** Decodes and hash-verifies the marker's payload_b64/sha256 fields. Never trusts the
 * declared sha256 as a signature -- it is a checksum recomputed here over the decoded byte
 * sequence, before any JSON parsing is attempted (protocol doc section 2). */
export function decodeEnvelopeFields(fields: Readonly<Record<string, string>>): EnvelopeDecodeResult {
  const payloadB64 = fields.payload_b64;
  const declaredSha = fields.sha256;
  if (!payloadB64 || !declaredSha) {
    return { ok: false, code: "envelope_fields_missing" };
  }
  if (payloadB64.length % 4 !== 0 || !BASE64_RE.test(payloadB64)) {
    return { ok: false, code: "envelope_base64_decode_failed" };
  }
  const bytes = Buffer.from(payloadB64, "base64");
  const actualSha = sha256Hex(bytes);
  if (actualSha !== declaredSha.toLowerCase()) {
    return { ok: false, code: "envelope_hash_mismatch" };
  }
  return { ok: true, bytes };
}
