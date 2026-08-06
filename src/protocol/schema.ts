// Hand-written structural validation mirroring test/contract/vendor/envelope.schema.json and
// token-usage.schema.json exactly. This repository has zero JSON Schema runtime dependency by
// design (docs/protocols/agent-metrics-v1.md section 8 keeps dependencies minimal); the vendored
// *.schema.json files remain the normative, tool-agnostic source of truth and are re-validated
// against directly by test/contract (via the vendored verify-fixtures.mjs oracle), so any drift
// between this file and the schema JSON is caught by CI, not just trusted by inspection.

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

const GENERATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UPSERT_KEY_RE = /^am1_[0-9a-f]{64}$/;
const SCHEMA_ID_RE = /^[a-z][a-z0-9-]*\/v[0-9]+$/;

function checkAdditionalProperties(
  obj: Obj,
  known: readonly string[],
  pathStr: string,
  out: string[],
) {
  const knownSet = new Set(known);
  for (const key of Object.keys(obj)) {
    if (!knownSet.has(key)) out.push(`${pathStr}: additional property "${key}" not allowed`);
  }
}

/** Validates the envelope-common fields (envelope.schema.json). Works on any payload
 * regardless of `schema` kind -- used both for the known token-usage/v1 path and for the
 * "well-formed envelope, unsupported kind" path (protocol doc section 6). */
export function validateEnvelope(payload: unknown, pathStr = "$"): string[] {
  const errors: string[] = [];
  if (!isObj(payload)) {
    errors.push(`${pathStr}: expected object`);
    return errors;
  }

  const required = [
    "protocol_version",
    "schema",
    "upsert_key",
    "emitter",
    "subject",
    "repository",
    "generated_at",
    "data",
  ];
  for (const key of required) {
    if (!(key in payload)) errors.push(`${pathStr}: missing required property "${key}"`);
  }

  if ("protocol_version" in payload && payload.protocol_version !== "agent-metrics/v1") {
    errors.push(`${pathStr}.protocol_version: expected const "agent-metrics/v1"`);
  }
  if ("schema" in payload) {
    const s = payload.schema;
    if (typeof s !== "string" || !SCHEMA_ID_RE.test(s)) {
      errors.push(`${pathStr}.schema: does not match pattern ${SCHEMA_ID_RE}`);
    }
  }
  if ("upsert_key" in payload) {
    const u = payload.upsert_key;
    if (typeof u !== "string" || !UPSERT_KEY_RE.test(u)) {
      errors.push(`${pathStr}.upsert_key: does not match pattern ${UPSERT_KEY_RE}`);
    }
  }
  if ("emitter" in payload) {
    const e = payload.emitter;
    if (!isObj(e)) {
      errors.push(`${pathStr}.emitter: expected object`);
    } else {
      if (!isNonEmptyString(e.name))
        errors.push(`${pathStr}.emitter.name: expected non-empty string`);
      if (!isNonEmptyString(e.version))
        errors.push(`${pathStr}.emitter.version: expected non-empty string`);
      checkAdditionalProperties(e, ["name", "version"], `${pathStr}.emitter`, errors);
    }
  }
  if ("subject" in payload) {
    const s = payload.subject;
    if (!isObj(s)) {
      errors.push(`${pathStr}.subject: expected object`);
    } else {
      for (const k of ["namespace", "type", "id"]) {
        if (!isNonEmptyString(s[k]))
          errors.push(`${pathStr}.subject.${k}: expected non-empty string`);
      }
      checkAdditionalProperties(s, ["namespace", "type", "id"], `${pathStr}.subject`, errors);
    }
  }
  if ("repository" in payload) {
    const r = payload.repository;
    if (!isObj(r)) {
      errors.push(`${pathStr}.repository: expected object`);
    } else {
      for (const k of ["provider", "id"]) {
        if (!isNonEmptyString(r[k]))
          errors.push(`${pathStr}.repository.${k}: expected non-empty string`);
      }
      checkAdditionalProperties(r, ["provider", "id"], `${pathStr}.repository`, errors);
    }
  }
  if ("change" in payload && payload.change !== undefined) {
    const c = payload.change;
    if (!isObj(c)) {
      errors.push(`${pathStr}.change: expected object`);
    } else {
      if ("type" in c && !isNonEmptyString(c.type))
        errors.push(`${pathStr}.change.type: expected non-empty string`);
      if ("number" in c && !isNonNegInt(c.number))
        errors.push(`${pathStr}.change.number: expected non-negative integer`);
      if ("url" in c && !isNonEmptyString(c.url))
        errors.push(`${pathStr}.change.url: expected non-empty string`);
      if ("head_sha" in c && !isNonEmptyString(c.head_sha))
        errors.push(`${pathStr}.change.head_sha: expected non-empty string`);
      checkAdditionalProperties(
        c,
        ["type", "number", "url", "head_sha"],
        `${pathStr}.change`,
        errors,
      );
    }
  }
  if ("generated_at" in payload) {
    const g = payload.generated_at;
    if (typeof g !== "string" || !GENERATED_AT_RE.test(g)) {
      errors.push(`${pathStr}.generated_at: does not match ISO 8601 UTC pattern`);
    }
  }
  if ("data" in payload && !isObj(payload.data)) {
    errors.push(`${pathStr}.data: expected object`);
  }

  checkAdditionalProperties(
    payload,
    [
      "protocol_version",
      "schema",
      "upsert_key",
      "emitter",
      "subject",
      "repository",
      "change",
      "generated_at",
      "data",
    ],
    pathStr,
    errors,
  );

  return errors;
}

const TOKEN_KINDS = new Set([
  "input_nocache",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "cache_write_unknown",
  "output",
]);
const PRICING_STATUSES = new Set(["priced", "unpriced", "unknown"]);
const COVERAGE_STATUSES = new Set(["complete", "partial", "no_data"]);

function validateTokenUsageRecord(rec: unknown, pathStr: string): string[] {
  const errors: string[] = [];
  if (!isObj(rec)) {
    errors.push(`${pathStr}: expected object`);
    return errors;
  }
  const required = ["activity", "agent", "model", "token_kind", "tokens", "pricing_status"];
  for (const key of required) {
    if (!(key in rec)) errors.push(`${pathStr}: missing required property "${key}"`);
  }
  if ("activity" in rec) {
    const a = rec.activity;
    if (!isObj(a)) {
      errors.push(`${pathStr}.activity: expected object`);
    } else {
      if (!isNonEmptyString(a.namespace))
        errors.push(`${pathStr}.activity.namespace: expected non-empty string`);
      if (!isNonEmptyString(a.name))
        errors.push(`${pathStr}.activity.name: expected non-empty string`);
      checkAdditionalProperties(a, ["namespace", "name"], `${pathStr}.activity`, errors);
    }
  }
  if ("agent" in rec && !isNonEmptyString(rec.agent))
    errors.push(`${pathStr}.agent: expected non-empty string`);
  if ("model" in rec && !isNonEmptyString(rec.model))
    errors.push(`${pathStr}.model: expected non-empty string`);
  if (
    "token_kind" in rec &&
    (typeof rec.token_kind !== "string" || !TOKEN_KINDS.has(rec.token_kind))
  ) {
    errors.push(`${pathStr}.token_kind: not in enum`);
  }
  if ("tokens" in rec && !isNonNegInt(rec.tokens))
    errors.push(`${pathStr}.tokens: expected non-negative integer`);
  if ("priced_tokens" in rec && !isNonNegInt(rec.priced_tokens))
    errors.push(`${pathStr}.priced_tokens: expected non-negative integer`);
  if ("unpriced_tokens" in rec && !isNonNegInt(rec.unpriced_tokens))
    errors.push(`${pathStr}.unpriced_tokens: expected non-negative integer`);
  if (
    "estimated_cost_usd" in rec &&
    !(typeof rec.estimated_cost_usd === "number" && rec.estimated_cost_usd >= 0)
  ) {
    errors.push(`${pathStr}.estimated_cost_usd: expected number >= 0`);
  }
  if ("credits" in rec && !(typeof rec.credits === "number" && rec.credits >= 0)) {
    errors.push(`${pathStr}.credits: expected number >= 0`);
  }
  if (
    "pricing_status" in rec &&
    (typeof rec.pricing_status !== "string" || !PRICING_STATUSES.has(rec.pricing_status))
  ) {
    errors.push(`${pathStr}.pricing_status: not in enum`);
  }
  checkAdditionalProperties(
    rec,
    [
      "activity",
      "agent",
      "model",
      "token_kind",
      "tokens",
      "priced_tokens",
      "unpriced_tokens",
      "estimated_cost_usd",
      "credits",
      "pricing_status",
    ],
    pathStr,
    errors,
  );
  return errors;
}

function validateCoverage(cov: unknown, pathStr: string): string[] {
  const errors: string[] = [];
  if (!isObj(cov)) {
    errors.push(`${pathStr}: expected object`);
    return errors;
  }
  const required = ["status", "eligible_entries", "measured_entries", "excluded_entries"];
  for (const key of required) {
    if (!(key in cov)) errors.push(`${pathStr}: missing required property "${key}"`);
  }
  if ("status" in cov && (typeof cov.status !== "string" || !COVERAGE_STATUSES.has(cov.status))) {
    errors.push(`${pathStr}.status: not in enum`);
  }
  for (const k of ["eligible_entries", "measured_entries", "excluded_entries"]) {
    if (k in cov && !isNonNegInt(cov[k]))
      errors.push(`${pathStr}.${k}: expected non-negative integer`);
  }
  if ("omissions" in cov && cov.omissions !== undefined) {
    const omissions = cov.omissions;
    if (!Array.isArray(omissions)) {
      errors.push(`${pathStr}.omissions: expected array`);
    } else {
      omissions.forEach((o, i) => {
        const p = `${pathStr}.omissions[${i}]`;
        if (!isObj(o)) {
          errors.push(`${p}: expected object`);
          return;
        }
        if (!isNonEmptyString(o.entry_id)) errors.push(`${p}.entry_id: expected non-empty string`);
        if (!isNonEmptyString(o.reason)) errors.push(`${p}.reason: expected non-empty string`);
        if ("detail" in o && typeof o.detail !== "string")
          errors.push(`${p}.detail: expected string`);
        checkAdditionalProperties(o, ["entry_id", "reason", "detail"], p, errors);
      });
    }
  }
  checkAdditionalProperties(
    cov,
    ["status", "eligible_entries", "measured_entries", "excluded_entries", "omissions"],
    pathStr,
    errors,
  );
  return errors;
}

export const MAX_RECORDS = 500;

function validateTokenUsageData(data: unknown, pathStr: string): string[] {
  const errors: string[] = [];
  if (!isObj(data)) {
    errors.push(`${pathStr}: expected object`);
    return errors;
  }
  for (const key of ["mode", "records", "coverage"]) {
    if (!(key in data)) errors.push(`${pathStr}: missing required property "${key}"`);
  }
  if ("mode" in data && data.mode !== "snapshot") {
    errors.push(`${pathStr}.mode: expected const "snapshot"`);
  }
  if ("records" in data) {
    const records = data.records;
    if (!Array.isArray(records)) {
      errors.push(`${pathStr}.records: expected array`);
    } else {
      if (records.length > MAX_RECORDS) {
        errors.push(`${pathStr}.records: array length ${records.length} > maxItems ${MAX_RECORDS}`);
      }
      records.forEach((r, i) =>
        errors.push(...validateTokenUsageRecord(r, `${pathStr}.records[${i}]`)),
      );
    }
  }
  if ("coverage" in data) errors.push(...validateCoverage(data.coverage, `${pathStr}.coverage`));
  checkAdditionalProperties(data, ["mode", "records", "coverage"], pathStr, errors);
  return errors;
}

/** Full token-usage/v1 payload validation: envelope-common fields plus this kind's `data`
 * shape, and `schema` narrowed to the literal "token-usage/v1" (token-usage.schema.json). */
export function validateTokenUsagePayload(payload: unknown, pathStr = "$"): string[] {
  const errors = validateEnvelope(payload, pathStr);
  if (!isObj(payload)) return errors;
  if ("schema" in payload && payload.schema !== "token-usage/v1") {
    errors.push(`${pathStr}.schema: expected const "token-usage/v1"`);
  }
  if ("data" in payload) errors.push(...validateTokenUsageData(payload.data, `${pathStr}.data`));
  return errors;
}
