#!/usr/bin/env node
/**
 * Guards the image prune keep-list for workspace packages required at runtime.
 * OpenClaw v2026.7+ links @openclaw/* into packages/*; dropping packages/
 * breaks gateway start.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile.base"), "utf8");

assert.match(
  dockerfile,
  /! -name packages/,
  "Dockerfile.base must keep packages/ after prune (workspace @openclaw/* links)",
);
assert.match(
  dockerfile,
  /test -d \/app\/packages/,
  "Dockerfile.base must assert /app/packages exists",
);
assert.match(
  dockerfile,
  /require\.resolve\('@openclaw\/ai'\)/,
  "Dockerfile.base must resolve @openclaw/ai at build time",
);

console.log("check-dockerfile-workspace-packages.mjs: ok");
