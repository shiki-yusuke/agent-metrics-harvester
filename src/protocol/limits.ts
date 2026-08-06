// Limits (docs/protocols/agent-metrics-v1.md section 8). `records[]` maxItems is also
// enforced by the token-usage schema (schema.ts); payload size and nesting depth are checked
// here because they apply at the envelope level, before/independent of kind-specific schema
// validation -- matching test/contract/vendor/verify-fixtures.mjs's split.

export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_DEPTH = 8;

export interface LimitViolation {
  readonly code: "payload_too_large" | "payload_too_deep";
  readonly detail: string;
}

function maxDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map(maxDepth));
}

export function checkLimits(payload: unknown, rawByteLength: number): LimitViolation[] {
  const violations: LimitViolation[] = [];
  if (rawByteLength > MAX_PAYLOAD_BYTES) {
    violations.push({
      code: "payload_too_large",
      detail: `${rawByteLength} bytes > ${MAX_PAYLOAD_BYTES}`,
    });
  }
  const depth = maxDepth(payload);
  if (depth > MAX_DEPTH) {
    violations.push({ code: "payload_too_deep", detail: `depth ${depth} > ${MAX_DEPTH}` });
  }
  return violations;
}
