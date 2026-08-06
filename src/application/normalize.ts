// Protocol doc section 6: "A harvester MUST normalize a known schema's payload to that
// schema's own fields and MUST NOT carry an unrecognized field into its store." Schema
// validation (src/protocol/schema.ts) already rejects any payload with an extra property
// before a payload reaches here (every object in this protocol declares
// additionalProperties:false) -- this function is a second, independent line of defense:
// it rebuilds the stored object field-by-field from the validated payload rather than storing
// the parsed JSON object as-is, so a future schema-validation bug can't smuggle an
// unrecognized field into the store just because validation happened to miss it.

import type {
  Change,
  Coverage,
  CoverageOmission,
  Emitter,
  Repository,
  Subject,
  TokenUsageData,
  TokenUsagePayload,
  TokenUsageRecord,
} from "../protocol/types.js";

function normalizeEmitter(e: Emitter): Emitter {
  return { name: e.name, version: e.version };
}

function normalizeSubject(s: Subject): Subject {
  return { namespace: s.namespace, type: s.type, id: s.id };
}

function normalizeRepository(r: Repository): Repository {
  return { provider: r.provider, id: r.id };
}

function normalizeChange(c: Change | undefined): Change | undefined {
  if (!c) return undefined;
  const out: Change = {};
  if (c.type !== undefined) (out as { type?: string }).type = c.type;
  if (c.number !== undefined) (out as { number?: number }).number = c.number;
  if (c.url !== undefined) (out as { url?: string }).url = c.url;
  if (c.head_sha !== undefined) (out as { head_sha?: string }).head_sha = c.head_sha;
  return out;
}

function normalizeRecord(r: TokenUsageRecord): TokenUsageRecord {
  return {
    activity: { namespace: r.activity.namespace, name: r.activity.name },
    agent: r.agent,
    model: r.model,
    token_kind: r.token_kind,
    tokens: r.tokens,
    ...(r.priced_tokens !== undefined ? { priced_tokens: r.priced_tokens } : {}),
    ...(r.unpriced_tokens !== undefined ? { unpriced_tokens: r.unpriced_tokens } : {}),
    ...(r.estimated_cost_usd !== undefined ? { estimated_cost_usd: r.estimated_cost_usd } : {}),
    ...(r.credits !== undefined ? { credits: r.credits } : {}),
    pricing_status: r.pricing_status,
  };
}

function normalizeOmission(o: CoverageOmission): CoverageOmission {
  return { entry_id: o.entry_id, reason: o.reason, ...(o.detail !== undefined ? { detail: o.detail } : {}) };
}

function normalizeCoverage(c: Coverage): Coverage {
  return {
    status: c.status,
    eligible_entries: c.eligible_entries,
    measured_entries: c.measured_entries,
    excluded_entries: c.excluded_entries,
    ...(c.omissions !== undefined ? { omissions: c.omissions.map(normalizeOmission) } : {}),
  };
}

function normalizeData(d: TokenUsageData): TokenUsageData {
  return {
    mode: d.mode,
    records: d.records.map(normalizeRecord),
    coverage: normalizeCoverage(d.coverage),
  };
}

export function normalizeTokenUsagePayload(payload: TokenUsagePayload): TokenUsagePayload {
  const change = normalizeChange(payload.change);
  return {
    protocol_version: "agent-metrics/v1",
    schema: "token-usage/v1",
    upsert_key: payload.upsert_key,
    emitter: normalizeEmitter(payload.emitter),
    subject: normalizeSubject(payload.subject),
    repository: normalizeRepository(payload.repository),
    ...(change !== undefined ? { change } : {}),
    generated_at: payload.generated_at,
    data: normalizeData(payload.data),
  };
}
