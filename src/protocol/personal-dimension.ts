// Personal-dimension scan (docs/protocols/agent-metrics-v1.md section 7). Runs independently
// of JSON Schema validation -- even though every object this protocol defines already
// declares additionalProperties:false (so an added personal-dimension key would also fail
// schema validation today), this scan is the second, schema-independent MUST: a future
// optional-field addition must not accidentally reopen the door.
//
// This set matches test/contract/vendor/verify-fixtures.mjs exactly. Implementers MAY extend
// it for their own deployment's identity conventions; they MUST NOT shrink it (protocol doc
// section 7).

export const FORBIDDEN_PERSONAL_DIMENSION_KEYS: ReadonlySet<string> = new Set([
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

/** Returns the dotted/bracketed paths of every forbidden personal-dimension key found
 * anywhere in `value` (nested, not just top-level). An empty array means no violations. */
export function scanPersonalDimensions(value: unknown, pathStr = ""): string[] {
  const violations: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      violations.push(...scanPersonalDimensions(item, `${pathStr}[${i}]`));
    });
    return violations;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const here = pathStr ? `${pathStr}.${key}` : key;
      if (FORBIDDEN_PERSONAL_DIMENSION_KEYS.has(key)) violations.push(here);
      violations.push(...scanPersonalDimensions(val, here));
    }
  }
  return violations;
}
