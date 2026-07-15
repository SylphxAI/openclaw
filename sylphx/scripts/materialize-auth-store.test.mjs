#!/usr/bin/env node
/**
 * Unit tests for materialize-auth-store module resolution.
 * Drives the real exported resolvers — no hard-coded hash expected value.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "materialize-auth-store.mjs");

const { resolveAuthStoreModulePath, listAuthStoreModuleCandidates } = await import(
  pathToFileURL(scriptPath).href
);

function withTempDist(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-store-dist-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body, "utf8");
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 1) Discovers hashed chunk under dist
withTempDist(
  {
    "auth-profiles-AbCdEf12.js": "export function saveAuthProfileStore() {}",
    "entry.js": "export {}",
  },
  (distDir) => {
    const resolved = resolveAuthStoreModulePath({ distDir });
    assert.equal(path.basename(resolved), "auth-profiles-AbCdEf12.js");
    const listed = listAuthStoreModuleCandidates(distDir);
    assert.deepEqual(listed.map((p) => path.basename(p)), ["auth-profiles-AbCdEf12.js"]);
  },
);

// 2) Explicit module wins even when dist has other hashes
withTempDist(
  {
    "auth-profiles-OLD.js": "export function saveAuthProfileStore() {}",
    "auth-profiles-NEW.js": "export function saveAuthProfileStore() {}",
  },
  (distDir) => {
    const explicit = path.join(distDir, "auth-profiles-NEW.js");
    const resolved = resolveAuthStoreModulePath({ distDir, modulePath: explicit });
    assert.equal(resolved, path.resolve(explicit));
  },
);

// 3) Missing dist fails closed with clear error
{
  const missing = path.join(os.tmpdir(), `no-such-dist-${Date.now()}`);
  assert.throws(
    () => resolveAuthStoreModulePath({ distDir: missing }),
    /dist directory not found/,
  );
}

// 4) CLI --resolve-only drives real entrypoint against temp dist with export
await withTempDist(
  {
    "auth-profiles-Z9y8x7.js": "export function saveAuthProfileStore() { return 'ok'; }",
  },
  (distDir) => {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--resolve-only", "--dist-dir", distDir],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(path.basename(parsed.resolved), "auth-profiles-Z9y8x7.js");
    assert.ok(parsed.candidates.some((c) => c.endsWith("auth-profiles-Z9y8x7.js")));
  },
);

// 5) Materialize end-to-end with fake saveAuthProfileStore
await withTempDist(
  {
    "auth-profiles-LiveTest1.js": `
      export function saveAuthProfileStore(store, agentDir, opts) {
        const fs = await_import_fs();
        // sync write marker for test
      }
      import fs from "node:fs";
      import path from "node:path";
      export function saveAuthProfileStore(store, agentDir) {
        fs.writeFileSync(path.join(agentDir, "materialized.marker"), JSON.stringify({
          keys: Object.keys(store.profiles||{}),
        }));
      }
    `,
  },
  (distDir) => {
    // rewrite clean module (previous multi-statement was messy)
    fs.writeFileSync(
      path.join(distDir, "auth-profiles-LiveTest1.js"),
      `
import fs from "node:fs";
import path from "node:path";
export function saveAuthProfileStore(store, agentDir) {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "materialized.marker"),
    JSON.stringify({ keys: Object.keys(store.profiles || {}) }),
  );
}
`,
      "utf8",
    );

    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-agent-"));
    const authPath = path.join(agentDir, "auth-profiles.json");
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        profiles: {
          "sylphx:default": { provider: "sylphx", type: "token", token: "x" },
        },
      }),
      "utf8",
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          scriptPath,
          "--dist-dir",
          distDir,
          "--agent-dir",
          agentDir,
          "--auth-profile",
          authPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const out = JSON.parse(result.stdout.trim());
      assert.equal(out.materialized, true);
      assert.equal(out.profileCount, 1);
      assert.ok(out.modulePath.endsWith("auth-profiles-LiveTest1.js"));
      assert.ok(fs.existsSync(path.join(agentDir, "materialized.marker")));
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  },
);

console.log("materialize-auth-store.test.mjs: all passed");
