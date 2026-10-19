#!/usr/bin/env node
// tsc only emits compiled .js for .ts sources -- it does not copy the non-TypeScript fixture
// assets (vendored *.json / *.txt / *.mjs under test/contract/vendor) into dist/. This script
// mirrors those static assets into dist/ next to the compiled test files that read them at
// runtime, so `node --test dist/test/**/*.test.js` can resolve paths relative to its own
// location the same way the source test files do relative to theirs.

import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const copies = [
  [
    join(rootDir, "test", "contract", "vendor"),
    join(rootDir, "dist", "test", "contract", "vendor"),
  ],
  // Listed on their own as well (already inside the directory above) because
  // dist/src/cognitive-debt reads the release-evidence pin at runtime to decide the M3 status,
  // and the release-approval pin for the `ack.by_kind` keys: narrowing the entry above must not
  // silently drop them.
  [
    join(rootDir, "test", "contract", "vendor", "release-evidence"),
    join(rootDir, "dist", "test", "contract", "vendor", "release-evidence"),
  ],
  [
    join(rootDir, "test", "contract", "vendor", "release-approval"),
    join(rootDir, "dist", "test", "contract", "vendor", "release-approval"),
  ],
  [
    join(rootDir, "test", "contract", "vendor", "cognitive-ack"),
    join(rootDir, "dist", "test", "contract", "vendor", "cognitive-ack"),
  ],
];

for (const [src, dest] of copies) {
  if (!existsSync(src)) continue;
  cpSync(src, dest, { recursive: true });
  console.log(`copied ${src} -> ${dest}`);
}
