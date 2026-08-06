#!/usr/bin/env node
// Verifies contracts/agent-metrics/v1/fixtures/* against envelope.schema.json and
// token-usage.schema.json, and re-derives every value a harvester is required (MUST,
// per docs/protocols/agent-metrics-v1.md) to independently recompute rather than trust:
// envelope sha256, RFC 8785 JCS upsert_key identity, and the personal-dimension scan.
//
// Zero npm dependencies by design (docs/protocols/agent-metrics-v1.md section 8): this file
// implements a JSON Schema (draft 2020-12) subset sufficient for the two schemas it ships
// next to, plus its own RFC 8785 canonicalizer, rather than pulling in ajv or a JCS library.
// The schemas themselves are standard JSON Schema and remain usable with any conformant
// validator -- this file's validator subset only has to agree with them, not replace them.
//
// Usage: node verify-fixtures.mjs   (no arguments, no install step)

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");

// ---------------------------------------------------------------------------
// RFC 8785 JSON Canonicalization Scheme (minimal, sufficient for this protocol's
// upsert-identity object: nested plain objects/arrays of strings and non-negative
// integers, no floats, no non-ASCII keys). Key ordering uses JS's default string
// comparison, which is UTF-16 code unit order -- exactly what RFC 8785 requires.
// ---------------------------------------------------------------------------
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

function sha256hex(bufOrStr) {
  return createHash("sha256").update(bufOrStr).digest("hex");
}

// upsert_key recipe (docs/protocols/agent-metrics-v1.md section 5): identity is
// {schema, repository, subject} only -- generated_at / change / emitter.version / token
// and cost values are deliberately excluded so re-measurement, re-pricing, and head_sha
// updates all resolve to the same key (a correction), not a new row.
function recomputeUpsertKey(payload) {
  const identity = {
    schema: payload.schema,
    repository: payload.repository,
    subject: payload.subject,
  };
  return "am1_" + sha256hex(canonicalize(identity));
}

// ---------------------------------------------------------------------------
// Personal-dimension scan (docs/protocols/agent-metrics-v1.md section 6). This runs
// independently of JSON Schema validation -- even though every object in this protocol's
// schemas already declares additionalProperties:false (so an added personal-dimension key
// would also fail schema validation today), this scan is the second, schema-independent
// MUST: a future optional-field addition must not accidentally reopen the door.
// ---------------------------------------------------------------------------
const FORBIDDEN_PERSONAL_DIMENSION_KEYS = new Set([
  "author",
  "reviewer",
  "assignee",
  "owner",
  "user_id",
  "username",
  "email",
  "display_name",
  "handle",
  "chat_id",
  "real_name",
]);

function scanPersonalDimensions(value, pathStr = "") {
  const violations = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => violations.push(...scanPersonalDimensions(item, `${pathStr}[${i}]`)));
    return violations;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      const here = pathStr ? `${pathStr}.${key}` : key;
      if (FORBIDDEN_PERSONAL_DIMENSION_KEYS.has(key)) violations.push(here);
      violations.push(...scanPersonalDimensions(val, here));
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Limits (docs/protocols/agent-metrics-v1.md section 8). maxItems on `records` is also
// enforced in token-usage.schema.json; payload size and nesting depth are checked here
// because they apply at the envelope level, before/independent of kind-specific schema
// validation.
// ---------------------------------------------------------------------------
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_DEPTH = 8;

function maxDepth(value) {
  if (value === null || typeof value !== "object") return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map(maxDepth));
}

function checkLimits(payload, rawByteLength) {
  const violations = [];
  if (rawByteLength > MAX_PAYLOAD_BYTES) {
    violations.push(`payload_too_large: ${rawByteLength} bytes > ${MAX_PAYLOAD_BYTES}`);
  }
  const depth = maxDepth(payload);
  if (depth > MAX_DEPTH) {
    violations.push(`payload_too_deep: depth ${depth} > ${MAX_DEPTH}`);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema (draft 2020-12 subset) validator: type, const, enum, pattern,
// minLength, minimum, maxItems, required, properties, additionalProperties, items, allOf,
// and $ref (to a sibling schema file, or to a local #/$defs/... pointer). This is exactly
// the subset envelope.schema.json and token-usage.schema.json use -- it is not a general
// draft 2020-12 implementation.
// ---------------------------------------------------------------------------
const schemaFileCache = new Map();

function loadSchemaFile(filename) {
  if (!schemaFileCache.has(filename)) {
    const text = readFileSync(path.join(HERE, filename), "utf-8");
    schemaFileCache.set(filename, JSON.parse(text));
  }
  return schemaFileCache.get(filename);
}

function resolvePointer(doc, pointer) {
  // pointer looks like "#/$defs/tokenUsageRecord"
  const parts = pointer.replace(/^#\//, "").split("/").filter(Boolean);
  let node = doc;
  for (const part of parts) node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return node;
}

function resolveRef(ref, currentDoc) {
  if (ref.startsWith("#/")) {
    return { schema: resolvePointer(currentDoc, ref), doc: currentDoc };
  }
  const [filename, pointer] = ref.split("#");
  const doc = loadSchemaFile(filename);
  if (!pointer) return { schema: doc, doc };
  return { schema: resolvePointer(doc, "#" + pointer), doc };
}

function typeOf(instance) {
  if (instance === null) return "null";
  if (Array.isArray(instance)) return "array";
  if (typeof instance === "number") return Number.isInteger(instance) ? "integer" : "number";
  return typeof instance; // "string" | "object" | "boolean"
}

function validateAgainst(schema, instance, currentDoc, pathStr, errors) {
  if (schema.$ref) {
    const { schema: refSchema, doc: refDoc } = resolveRef(schema.$ref, currentDoc);
    validateAgainst(refSchema, instance, refDoc, pathStr, errors);
    return;
  }
  if (schema.allOf) {
    for (const sub of schema.allOf) validateAgainst(sub, instance, currentDoc, pathStr, errors);
    return;
  }
  if (schema.const !== undefined && instance !== schema.const) {
    errors.push(`${pathStr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(instance)}`);
  }
  if (schema.enum && !schema.enum.includes(instance)) {
    errors.push(`${pathStr}: ${JSON.stringify(instance)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type) {
    const actual = typeOf(instance);
    const ok =
      actual === schema.type ||
      (schema.type === "number" && actual === "integer");
    if (!ok) errors.push(`${pathStr}: expected type ${schema.type}, got ${actual}`);
  }
  if (schema.pattern && typeof instance === "string" && !new RegExp(schema.pattern).test(instance)) {
    errors.push(`${pathStr}: ${JSON.stringify(instance)} does not match pattern ${schema.pattern}`);
  }
  if (schema.minLength !== undefined && typeof instance === "string" && instance.length < schema.minLength) {
    errors.push(`${pathStr}: string shorter than minLength ${schema.minLength}`);
  }
  if (schema.minimum !== undefined && typeof instance === "number" && instance < schema.minimum) {
    errors.push(`${pathStr}: ${instance} < minimum ${schema.minimum}`);
  }
  if (Array.isArray(instance)) {
    if (schema.maxItems !== undefined && instance.length > schema.maxItems) {
      errors.push(`${pathStr}: array length ${instance.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      errors.push(`${pathStr}: array length ${instance.length} < minItems ${schema.minItems}`);
    }
    if (schema.items) {
      instance.forEach((item, i) => validateAgainst(schema.items, item, currentDoc, `${pathStr}[${i}]`, errors));
    }
  }
  if (instance !== null && typeof instance === "object" && !Array.isArray(instance)) {
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in instance)) errors.push(`${pathStr}: missing required property "${key}"`);
      }
    }
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in instance) validateAgainst(subSchema, instance[key], currentDoc, `${pathStr}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(instance)) {
        if (!known.has(key)) errors.push(`${pathStr}: additional property "${key}" not allowed`);
      }
    }
  }
}

function validate(schemaFilename, instance) {
  const doc = loadSchemaFile(schemaFilename);
  const errors = [];
  validateAgainst(doc, instance, doc, "$", errors);
  return errors;
}

// ---------------------------------------------------------------------------
// Envelope (marker) parsing -- mirrors docs/protocols/agent-metrics-v1.md section 2.
// ---------------------------------------------------------------------------
const MARKER_RE = /<!--\s*agent-metrics:v1\s+([\s\S]*?)\s*-->/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function parseMarker(markerText) {
  const m = markerText.match(MARKER_RE);
  if (!m) return { ignored: true };
  const body = m[1];
  const fields = Object.fromEntries(
    [...body.matchAll(/([a-z_][a-z0-9_]*)=(\S+)/g)].map(([, k, v]) => [k, v]),
  );
  return { ignored: false, fields };
}

function decodeMarkerPayload(fields) {
  const reasons = [];
  if (!fields.payload_b64 || !fields.sha256) {
    reasons.push("envelope_fields_missing");
    return { reasons };
  }
  if (fields.payload_b64.length % 4 !== 0 || !BASE64_RE.test(fields.payload_b64)) {
    reasons.push("envelope_base64_decode_failed");
    return { reasons };
  }
  const bytes = Buffer.from(fields.payload_b64, "base64");
  const actualSha = sha256hex(bytes);
  if (actualSha !== fields.sha256.toLowerCase()) {
    reasons.push("envelope_hash_mismatch");
    return { reasons };
  }
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf-8"));
  } catch {
    reasons.push("payload_not_valid_json");
    return { reasons };
  }
  return { reasons, payload, bytes };
}

// ---------------------------------------------------------------------------
// Full check pipeline for a decoded payload object (shared by marker-wrapped and
// bare-payload fixtures).
// ---------------------------------------------------------------------------
function checkPayload(payload, rawByteLength) {
  const reasons = [];

  if (payload.schema !== "token-usage/v1") {
    reasons.push("unsupported_schema_kind");
    // Still schema-validate at the envelope level so we can tell "malformed envelope"
    // apart from "well-formed envelope, unsupported kind" -- but don't attempt to
    // interpret `data` for a kind we don't know.
    reasons.push(...validate("envelope.schema.json", payload));
    reasons.push(...scanPersonalDimensions(payload));
    reasons.push(...checkLimits(payload, rawByteLength));
    return dedupe(reasons);
  }

  reasons.push(...validate("token-usage.schema.json", payload));
  reasons.push(...scanPersonalDimensions(payload).map((v) => `personal_dimension_forbidden_key: ${v}`));
  reasons.push(...checkLimits(payload, rawByteLength));

  if (typeof payload.upsert_key === "string" && typeof payload.schema === "string" && payload.repository && payload.subject) {
    const recomputed = recomputeUpsertKey(payload);
    if (recomputed !== payload.upsert_key) {
      reasons.push(`upsert_key_mismatch: declared=${payload.upsert_key} recomputed=${recomputed}`);
    }
  }

  return dedupe(reasons);
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function reasonCodesOf(reasons) {
  // Normalizes "code: detail" strings down to their leading code token for comparison
  // against expected-results.json's reason_code field.
  return reasons.map((r) => r.split(":")[0].trim());
}

// ---------------------------------------------------------------------------
// Fixture runner
// ---------------------------------------------------------------------------
function readFixtureText(filename) {
  return readFileSync(path.join(FIXTURES_DIR, filename), "utf-8");
}

function readFixtureJson(filename) {
  return JSON.parse(readFixtureText(filename));
}

function runMarkerFixture(entry) {
  const markerText = readFixtureText(entry.files.marker);
  const parsed = parseMarker(markerText);
  if (parsed.ignored) {
    return { category: "ignore", reasons: [] };
  }
  const decoded = decodeMarkerPayload(parsed.fields);
  if (decoded.reasons.length > 0) {
    return { category: "reject", reasons: decoded.reasons };
  }
  const reasons = checkPayload(decoded.payload, decoded.bytes.length);
  return { category: reasons.length > 0 ? "reject" : "accept", reasons };
}

function runPayloadFixture(entry) {
  const payload = readFixtureJson(entry.files.payload);
  const rawByteLength = Buffer.byteLength(JSON.stringify(payload), "utf-8");
  const reasons = checkPayload(payload, rawByteLength);
  return { category: reasons.length > 0 ? "reject" : "accept", reasons };
}

function runCorrectionPairFixture(entry) {
  const first = readFixtureJson(entry.files.first);
  const second = readFixtureJson(entry.files.second);
  const problems = [];

  const firstReasons = checkPayload(first, Buffer.byteLength(JSON.stringify(first), "utf-8"));
  const secondReasons = checkPayload(second, Buffer.byteLength(JSON.stringify(second), "utf-8"));
  if (firstReasons.length > 0) problems.push(`first payload not individually valid: ${firstReasons.join("; ")}`);
  if (secondReasons.length > 0) problems.push(`second payload not individually valid: ${secondReasons.join("; ")}`);

  const firstKey = recomputeUpsertKey(first);
  const secondKey = recomputeUpsertKey(second);
  if (firstKey !== secondKey) {
    problems.push(`upsert_key differs across correction pair: ${firstKey} !== ${secondKey}`);
  }
  if (first.upsert_key !== firstKey) problems.push(`first.upsert_key declared value does not match recomputed identity`);
  if (second.upsert_key !== secondKey) problems.push(`second.upsert_key declared value does not match recomputed identity`);

  if (entry.assert === "same_upsert_key_different_content") {
    if (JSON.stringify(first) === JSON.stringify(second)) {
      problems.push("correction-same-key pair must differ in content, not just be a byte-identical duplicate");
    }
  }
  if (entry.assert === "same_upsert_key_record_removed") {
    const firstRecords = first.data?.records ?? [];
    const secondRecords = second.data?.records ?? [];
    const secondSet = new Set(secondRecords.map((r) => JSON.stringify(r)));
    const removed = firstRecords.filter((r) => !secondSet.has(JSON.stringify(r)));
    if (removed.length === 0) {
      problems.push("expected second payload to drop at least one record present in the first (snapshot replace semantics)");
    }
  }

  return { category: problems.length > 0 ? "reject" : "accept", reasons: problems };
}

function main() {
  const manifest = readFixtureJson("expected-results.json");
  let failures = 0;

  console.log(`agent-metrics:v1 fixture verification (${manifest.fixtures.length} fixtures)\n`);

  for (const entry of manifest.fixtures) {
    let result;
    if (entry.kind === "marker" || entry.kind === "ignored-marker") {
      result = runMarkerFixture(entry);
    } else if (entry.kind === "payload") {
      result = runPayloadFixture(entry);
    } else if (entry.kind === "correction-pair") {
      result = runCorrectionPairFixture(entry);
    } else {
      throw new Error(`unknown fixture kind: ${entry.kind}`);
    }

    let ok = result.category === entry.expected;
    if (ok && entry.expected === "reject" && entry.reason_code) {
      const codes = reasonCodesOf(result.reasons);
      ok = codes.includes(entry.reason_code);
    }

    const status = ok ? "PASS" : "FAIL";
    if (!ok) failures++;
    console.log(`[${status}] ${entry.id}  (expected=${entry.expected}, got=${result.category})`);
    if (!ok || process.env.VERBOSE) {
      for (const r of result.reasons) console.log(`         - ${r}`);
    }
  }

  console.log(`\n${manifest.fixtures.length - failures}/${manifest.fixtures.length} fixtures passed.`);
  if (failures > 0) {
    console.error(`\n${failures} fixture(s) FAILED.`);
    process.exit(1);
  }
}

main();
