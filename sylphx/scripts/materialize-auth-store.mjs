#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const options = {
    agentDir: process.env.OPENCLAW_AUTH_AGENT_DIR,
    authProfilePath: process.env.OPENCLAW_AUTH_PROFILE_PATH,
    modulePath: process.env.OPENCLAW_AUTH_STORE_MODULE ?? "/app/dist/auth-profiles-KCERmZal.js",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--agent-dir") {
      options.agentDir = argv[++index];
    } else if (arg === "--auth-profile") {
      options.authProfilePath = argv[++index];
    } else if (arg === "--module") {
      options.modulePath = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const stateDir = process.env.OPENCLAW_STATE_DIR
    ?? path.join(process.env.HOME ?? "/home/node", ".openclaw");
  options.agentDir ??= path.join(stateDir, "agents", "main", "agent");
  options.authProfilePath ??= path.join(options.agentDir, "auth-profiles.json");

  return options;
}

function readSourceStore(authProfilePath) {
  if (!fs.existsSync(authProfilePath)) {
    return null;
  }

  const parsed = JSON.parse(fs.readFileSync(authProfilePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || !parsed.profiles || typeof parsed.profiles !== "object") {
    throw new Error(`Invalid auth profile store: ${authProfilePath}`);
  }

  const profileIds = Object.keys(parsed.profiles);
  if (profileIds.length === 0) {
    throw new Error(`Auth profile store has no profiles: ${authProfilePath}`);
  }

  return { store: parsed, profileIds };
}

async function loadSaveAuthProfileStore(modulePath) {
  const specifier = modulePath.startsWith("file:")
    ? modulePath
    : pathToFileURL(path.resolve(modulePath)).href;
  const module = await import(specifier);
  if (typeof module.saveAuthProfileStore !== "function") {
    throw new Error(`Auth store module does not export saveAuthProfileStore: ${modulePath}`);
  }
  return module.saveAuthProfileStore;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = readSourceStore(options.authProfilePath);
  if (!source) {
    console.log(JSON.stringify({ materialized: false, reason: "auth_profile_missing" }));
    return;
  }

  const saveAuthProfileStore = await loadSaveAuthProfileStore(options.modulePath);
  saveAuthProfileStore(source.store, options.agentDir, { syncExternalCli: false });

  const providers = source.profileIds
    .map((profileId) => source.store.profiles[profileId]?.provider)
    .filter((provider) => typeof provider === "string" && provider.length > 0);

  console.log(JSON.stringify({
    materialized: true,
    profileCount: source.profileIds.length,
    providers,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
