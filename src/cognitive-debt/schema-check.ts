// Minimal JSON Schema checker for the vendored release-evidence shadow schemas
// (test/contract/vendor/release-evidence/). Same semantics as release-evidence's `runSchema`
// (its vendored playbook-shared schema-validator.mjs), restricted to exactly the keywords those
// two schemas use. Any other keyword is refused up front by `assertSupportedSchema` -- a keyword
// this checker silently ignored would accept anything (the failure mode upstream's own `oneOf`
// history records), so an upstream re-pin that starts using a new keyword must fail loudly here.

export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "additionalProperties",
  "allOf",
  "const",
  "else",
  "enum",
  "if",
  "items",
  "maxItems",
  "minItems",
  "minLength",
  "not",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "then",
  "type",
]);

type Schema = Record<string, unknown>;

export class UnsupportedSchemaKeywordError extends Error {}

/** Walks every subschema and throws on the first keyword outside SUPPORTED_KEYWORDS. */
export function assertSupportedSchema(schema: unknown, at = "$"): void {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new UnsupportedSchemaKeywordError(`${at}: a schema must be an object`);
  }
  for (const [key, value] of Object.entries(schema as Schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new UnsupportedSchemaKeywordError(`${at}: unsupported schema keyword "${key}"`);
    }
    if (key === "properties") {
      for (const [name, sub] of Object.entries(value as Schema)) {
        assertSupportedSchema(sub, `${at}.properties.${name}`);
      }
    } else if (key === "allOf" || key === "oneOf") {
      (value as unknown[]).forEach((sub, i) => assertSupportedSchema(sub, `${at}.${key}[${i}]`));
    } else if (
      key === "items" ||
      key === "if" ||
      key === "then" ||
      key === "else" ||
      key === "not"
    ) {
      assertSupportedSchema(value, `${at}.${key}`);
    } else if (key === "additionalProperties" && typeof value === "object" && value !== null) {
      assertSupportedSchema(value, `${at}.${key}`);
    }
  }
}

function typeOf(instance: unknown): string {
  if (instance === null) return "null";
  if (Array.isArray(instance)) return "array";
  if (typeof instance === "number") return Number.isInteger(instance) ? "integer" : "number";
  return typeof instance;
}

function validateAgainst(schema: Schema, instance: unknown, at: string, errors: string[]): void {
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validateAgainst(sub as Schema, instance, at, errors);
  }
  if (schema.if !== undefined) {
    const ifErrors: string[] = [];
    validateAgainst(schema.if as Schema, instance, at, ifErrors);
    const branch = ifErrors.length === 0 ? schema.then : schema.else;
    if (branch !== undefined) validateAgainst(branch as Schema, instance, at, errors);
  }
  if (schema.not !== undefined) {
    const notErrors: string[] = [];
    validateAgainst(schema.not as Schema, instance, at, notErrors);
    if (notErrors.length === 0) errors.push(`${at}: must not validate against "not"`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((sub) => {
      const branchErrors: string[] = [];
      validateAgainst(sub as Schema, instance, at, branchErrors);
      return branchErrors.length === 0;
    }).length;
    if (matched !== 1) errors.push(`${at}: oneOf matched ${matched}`);
  }
  if (schema.const !== undefined && instance !== schema.const) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(instance)) {
    errors.push(`${at}: not in enum`);
  }
  if (schema.type !== undefined) {
    const actual = typeOf(instance);
    const allowed = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type];
    if (!allowed.some((t) => actual === t || (t === "number" && actual === "integer"))) {
      errors.push(`${at}: expected type ${JSON.stringify(schema.type)}, got ${actual}`);
    }
  }
  if (typeof schema.pattern === "string" && typeof instance === "string") {
    if (!new RegExp(schema.pattern).test(instance)) errors.push(`${at}: pattern mismatch`);
  }
  if (typeof schema.minLength === "number" && typeof instance === "string") {
    if (instance.length < schema.minLength) errors.push(`${at}: shorter than minLength`);
  }
  if (Array.isArray(instance)) {
    if (typeof schema.maxItems === "number" && instance.length > schema.maxItems) {
      errors.push(`${at}: more than maxItems`);
    }
    if (typeof schema.minItems === "number" && instance.length < schema.minItems) {
      errors.push(`${at}: fewer than minItems`);
    }
    if (schema.items !== undefined) {
      instance.forEach((item, i) =>
        validateAgainst(schema.items as Schema, item, `${at}[${i}]`, errors),
      );
    }
  }
  if (instance !== null && typeof instance === "object" && !Array.isArray(instance)) {
    const obj = instance as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!Object.hasOwn(obj, key)) errors.push(`${at}: missing required property "${key}"`);
      }
    }
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.hasOwn(obj, key)) validateAgainst(sub, obj[key], `${at}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!Object.hasOwn(properties, key))
          errors.push(`${at}: additional property "${key}" not allowed`);
      }
    } else if (typeof schema.additionalProperties === "object" && schema.additionalProperties) {
      for (const [key, value] of Object.entries(obj)) {
        if (Object.hasOwn(properties, key)) continue;
        validateAgainst(schema.additionalProperties as Schema, value, `${at}.${key}`, errors);
      }
    }
  }
}

/** Validates `instance` against `schema` (after `assertSupportedSchema`). Empty = valid. */
export function checkSchema(schema: object, instance: unknown): string[] {
  assertSupportedSchema(schema);
  const errors: string[] = [];
  validateAgainst(schema as Schema, instance, "$", errors);
  return errors;
}

/** True when the schema declares `properties.input_digest` (design section 1, r10: the M3
 * computed/not_computed switch is this, never the presence or count of evaluation pairs). */
export function declaresInputDigest(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return false;
  const properties = (schema as Schema).properties;
  return (
    properties !== null &&
    typeof properties === "object" &&
    Object.hasOwn(properties, "input_digest")
  );
}
