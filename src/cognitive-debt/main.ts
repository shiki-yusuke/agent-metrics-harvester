#!/usr/bin/env node
// CLI entrypoint for `agent-metrics-cognitive-debt` (cognitive-debt-metrics/v0, DRAFT, authority
// none). Writes exactly one file (--out); logs go to stderr. See run.ts for exit codes. The same
// command also runs as `agent-metrics-harvester cognitive-debt ...` (src/cli/main.ts).

import { runCognitiveDebtCli } from "./cli.js";

void runCognitiveDebtCli(process.argv.slice(2));
