// Copies non-TS assets into dist and marks the CLI executable.
import { copyFileSync, chmodSync, mkdirSync } from "node:fs";

mkdirSync("dist/src/pricing", { recursive: true });
copyFileSync("src/pricing/prices.json", "dist/src/pricing/prices.json");

// Root-level bin shim so `bin: dist/cli.js` works with rootDir ".".
import { writeFileSync } from "node:fs";
writeFileSync("dist/cli.js", '#!/usr/bin/env node\nimport "./src/cli.js";\n');
chmodSync("dist/cli.js", 0o755);
