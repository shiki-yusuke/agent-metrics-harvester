// Parses the optional `--empty-reason-config` JSON file into a `DashboardEmptyReasonConfig`
// (types.ts). Deliberately NOT wired into compute.ts / computeDashboardData's inputs: classifying
// *why* a panel is empty is an operational, publication-boundary judgment, never a measured
// quantity, so it must never touch the domain object the D9 compute/render split guards (see
// compute.ts's own header comment) -- it flows straight from this file to render.ts's
// presentation layer only.
//
// Validation here is strict and fails loudly, unlike aggregates-reader.ts's "skip a corrupt
// line" policy: an aggregate line is high-volume, untrusted pipeline data where skipping one bad
// line is the safe default; this file is a single human operator's deliberate, low-frequency
// publication decision, where a typo silently reaching the public page as unexplained "データな
// し" is the worse failure mode. A malformed config should stop the run, not degrade quietly.

import { readFile } from "node:fs/promises";
import type {
  DashboardEmptyReasonConfig,
  EmptyPanelReason,
  EmptyPanelReasonCode,
} from "./types.js";

export class EmptyReasonConfigError extends Error {}

const VALID_CODES: ReadonlySet<string> = new Set(["not_produced", "withheld", "insufficient_data"]);
const VALID_PANEL_KEYS: ReadonlySet<string> = new Set(["calibration", "attribution", "cohort"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseReason(panelKey: string, raw: unknown): EmptyPanelReason {
  if (!isPlainObject(raw)) {
    throw new EmptyReasonConfigError(`"${panelKey}" entry must be a JSON object`);
  }
  const { code, note } = raw;
  if (typeof code !== "string" || !VALID_CODES.has(code)) {
    throw new EmptyReasonConfigError(
      `"${panelKey}.code" must be one of "not_produced" | "withheld" | "insufficient_data", got ${JSON.stringify(code)}`,
    );
  }
  if (note !== undefined && typeof note !== "string") {
    throw new EmptyReasonConfigError(`"${panelKey}.note" must be a string when present`);
  }
  const extraKeys = Object.keys(raw).filter((k) => k !== "code" && k !== "note");
  if (extraKeys.length > 0) {
    throw new EmptyReasonConfigError(
      `"${panelKey}" entry has unrecognized field(s): ${extraKeys.join(", ")}`,
    );
  }
  return note !== undefined
    ? { code: code as EmptyPanelReasonCode, note }
    : { code: code as EmptyPanelReasonCode };
}

/** Pure parse + validate over an already-`JSON.parse`d value -- split out from the file-reading
 * wrapper below so tests can exercise validation without touching the filesystem. */
export function parseEmptyReasonConfig(raw: unknown): DashboardEmptyReasonConfig {
  if (!isPlainObject(raw)) {
    throw new EmptyReasonConfigError("empty-reason config must be a JSON object");
  }
  const result: { [k: string]: EmptyPanelReason } = {};
  for (const key of Object.keys(raw)) {
    if (!VALID_PANEL_KEYS.has(key)) {
      throw new EmptyReasonConfigError(
        `unrecognized panel key "${key}" in empty-reason config -- must be one of "calibration" | "attribution" | "cohort"`,
      );
    }
    result[key] = parseReason(key, raw[key]);
  }
  return result as DashboardEmptyReasonConfig;
}

export async function readEmptyReasonConfig(filePath: string): Promise<DashboardEmptyReasonConfig> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new EmptyReasonConfigError(
      `failed to read empty-reason config at "${filePath}": ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new EmptyReasonConfigError(
      `empty-reason config at "${filePath}" is not valid JSON: ${(err as Error).message}`,
    );
  }
  return parseEmptyReasonConfig(parsed);
}
