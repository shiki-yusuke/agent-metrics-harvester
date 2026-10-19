// Process wiring shared by both entry points of the command: the `agent-metrics-cognitive-debt`
// bin (main.ts) and `agent-metrics-harvester cognitive-debt ...` (src/cli/main.ts). Kept out of
// main.ts so importing it has no side effect.

import { runCognitiveDebt } from "./run.js";

export async function runCognitiveDebtCli(argv: readonly string[]): Promise<void> {
  try {
    process.exitCode = await runCognitiveDebt(argv, {
      stdout: (line) => process.stdout.write(line.endsWith("\n") ? line : `${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (err) {
    console.error("agent-metrics-cognitive-debt: fatal error");
    console.error(err);
    process.exitCode = 1;
  }
}
