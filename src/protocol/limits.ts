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

// Iterative (non-recursive) depth check with an early bailout, on purpose: a function whose
// entire job is "detect input that is too deeply nested" must not itself use unbounded
// recursion to do that detection -- a maliciously deep payload (a few thousand levels of
// `{"a":{"a":...}}`) would overflow the call stack and crash the whole process *before* the
// original recursive version ever got to report "too deep." An explicit stack plus an
// early-return the moment `MAX_DEPTH` is exceeded keeps this safe regardless of how deep a
// hostile payload goes. See test/unit/deep-nesting-crash.test.ts.
function exceedsMaxDepth(root: unknown): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop() as { node: unknown; depth: number };
    if (frame.depth > MAX_DEPTH) return true;
    const { node } = frame;
    if (node === null || typeof node !== "object") continue;
    const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const child of children) stack.push({ node: child, depth: frame.depth + 1 });
  }
  return false;
}

// Exposed standalone (not just folded into checkLimits below) so a caller that must guard a
// payload against attacker-controlled depth *before* doing anything else with it -- in
// particular before JSON.stringify, itself a recursive, depth-unsafe V8 built-in -- can run
// only this crash-safe check first, without needing rawByteLength computed up front. See
// decode.ts's decodePayloadObject and test/unit/deep-nesting-crash.test.ts.
export function checkDepth(payload: unknown): LimitViolation | undefined {
  if (!exceedsMaxDepth(payload)) return undefined;
  return { code: "payload_too_deep", detail: `nesting exceeds max depth ${MAX_DEPTH}` };
}

export function checkLimits(payload: unknown, rawByteLength: number): LimitViolation[] {
  const violations: LimitViolation[] = [];
  if (rawByteLength > MAX_PAYLOAD_BYTES) {
    violations.push({
      code: "payload_too_large",
      detail: `${rawByteLength} bytes > ${MAX_PAYLOAD_BYTES}`,
    });
  }
  const depthViolation = checkDepth(payload);
  if (depthViolation) violations.push(depthViolation);
  return violations;
}
