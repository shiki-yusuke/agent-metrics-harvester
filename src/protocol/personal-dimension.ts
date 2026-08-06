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

// A hard ceiling on how deep this walker will ever descend, independent of and in addition to
// limits.ts's own MAX_DEPTH check. checkPayload (decode.ts) already runs checkLimits first and
// short-circuits before this scan ever sees a too-deep payload in the normal pipeline -- this
// ceiling exists so scanPersonalDimensions is *also* safe to call directly (e.g.
// application/harvest.ts's independent Goodhart re-check call site) without depending on that
// ordering elsewhere continuing to hold in the future.
const HARD_DEPTH_CEILING = 64;

/** Returns the dotted/bracketed paths of every forbidden personal-dimension key found
 * anywhere in `value` (nested, not just top-level). An empty array means no violations.
 *
 * Implemented iteratively (an explicit stack, not recursion) on purpose: this function walks
 * the *entire*, untrusted payload structure, so a maliciously deep input must not be able to
 * overflow the call stack while doing so -- see test/unit/deep-nesting-crash.test.ts. */
export function scanPersonalDimensions(value: unknown, rootPath = ""): string[] {
  const violations: string[] = [];
  const stack: Array<{ node: unknown; path: string; depth: number }> = [
    { node: value, path: rootPath, depth: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack.pop() as { node: unknown; path: string; depth: number };
    if (frame.depth > HARD_DEPTH_CEILING) continue;
    const { node, path, depth } = frame;
    if (Array.isArray(node)) {
      node.forEach((item, i) =>
        stack.push({ node: item, path: `${path}[${i}]`, depth: depth + 1 }),
      );
      continue;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        const here = path ? `${path}.${key}` : key;
        if (FORBIDDEN_PERSONAL_DIMENSION_KEYS.has(key)) violations.push(here);
        stack.push({ node: val, path: here, depth: depth + 1 });
      }
    }
  }
  return violations;
}
