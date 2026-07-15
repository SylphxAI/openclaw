#!/usr/bin/env node
/**
 * Materialize OpenClaw JSON auth-profiles into the runtime SQLite auth store.
 *
 * The upstream dist chunk for auth-profiles is content-hashed
 * (`auth-profiles-<hash>.js`) and changes every OpenClaw release/build.
 * Never hard-code that hash — resolve it at runtime under /app/dist.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_DIST_DIR = "/app/dist";

function parseArgs(argv) {
  const options = {
    agentDir: process.env.OPENCLAW_AUTH_AGENT_DIR,
    authProfilePath: process.env.OPENCLAW_AUTH_PROFILE_PATH,
    modulePath: process.env.OPENCLAW_AUTH_STORE_MODULE,
    distDir: process.env.OPENCLAW_DIST_DIR ?? DEFAULT_DIST_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--agent-dir") {
      options.agentDir = argv[++index];
    } else if (arg === "--auth-profile") {
      options.authProfilePath = argv[++index];
    } else if (arg === "--module") {
      options.modulePath = argv[++index];
    } else if (arg === "--dist-dir") {
      options.distDir = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const stateDir =
    process.env.OPENCLAW_STATE_DIR ?? path.join(process.env.HOME ?? "/home/node", ".openclaw");
  options.agentDir ??= path.join(stateDir, "agents", "main", "agent");
  options.authProfilePath ??= path.join(options.agentDir, "auth-profiles.json");

  return options;
}

/**
 * Resolve the dist module that exports `saveAuthProfileStore`.
 * Prefer an explicit path (CLI / env), else scan dist for hashed chunks.
 *
 * @param {{ modulePath?: string, distDir: string }} options
 * @returns {string}
 */
export function resolveAuthStoreModulePath(options) {
  const explicit = options.modulePath?.trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`Auth store module not found: ${explicit}`);
    }
    return path.resolve(explicit);
  }

  const distDir = path.resolve(options.distDir);
  if (!fs.existsSync(distDir)) {
    throw new Error(`OpenClaw dist directory not found: ${distDir}`);
  }

  const names = fs.readdirSync(distDir);
  const preferred = names
    .filter((name) => {
      if (name === "auth-profiles.js" || name === "auth-profiles.mjs") return true;
      // tsdown content-hash chunks: auth-profiles-KCERmZal.js
      return /^auth-profiles[-.].+\.(js|mjs|cjs)$/.test(name);
    })
    .sort();

  if (preferred.length === 0) {
    // Broader fallback: any dist file whose name mentions auth-profile(s)
    const loose = names
      .filter((name) => /auth[-_]?profiles?/i.test(name) && /\.(js|mjs|cjs)$/.test(name))
      .sort();
    if (loose.length === 0) {
      throw new Error(
        `No auth-profiles* module under ${distDir}. Set OPENCLAW_AUTH_STORE_MODULE to the dist chunk that exports saveAuthProfileStore.`,
      );
    }
    preferred.push(...loose);
  }

  // Prefer exact auth-profiles-* over loose matches; return first existing file.
  // Callers that need export validation import via loadSaveAuthProfileStore.
  return path.join(distDir, preferred[0]);
}

/**
 * List candidate module paths for validation (tests / debugging).
 * @param {string} distDir
 * @returns {string[]}
 */
export function listAuthStoreModuleCandidates(distDir) {
  if (!fs.existsSync(distDir)) return [];
  return fs
    .readdirSync(distDir)
    .filter(
      (name) =>
        name === "auth-profiles.js" ||
        name === "auth-profiles.mjs" ||
        /^auth-profiles[-.].+\.(js|mjs|cjs)$/.test(name),
    )
    .sort()
    .map((name) => path.join(distDir, name));
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

/**
 * Try candidates until one exports saveAuthProfileStore.
 * @param {string[]} candidates
 */
async function loadSaveAuthProfileStoreFromCandidates(candidates) {
  const errors = [];
  for (const candidate of candidates) {
    try {
      return { saveAuthProfileStore: await loadSaveAuthProfileStore(candidate), modulePath: candidate };
    } catch (err) {
      errors.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `Could not load saveAuthProfileStore from any candidate:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
  );
}

async function main() {
  // Allow unit-style self-check without side effects
  if (process.argv.includes("--resolve-only")) {
    const options = parseArgs(process.argv.slice(2).filter((a) => a !== "--resolve-only"));
    const primary = resolveAuthStoreModulePath(options);
    const candidates = listAuthStoreModuleCandidates(options.distDir);
    // Prefer full candidate list when scanning so hash changes still work
    const tryList = options.modulePath ? [primary] : candidates.length > 0 ? candidates : [primary];
    const loaded = await loadSaveAuthProfileStoreFromCandidates(tryList);
    console.log(
      JSON.stringify({
        resolved: loaded.modulePath,
        candidates: tryList,
      }),
    );
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  const source = readSourceStore(options.authProfilePath);
  if (!source) {
    console.log(JSON.stringify({ materialized: false, reason: "auth_profile_missing" }));
    return;
  }

  const primary = resolveAuthStoreModulePath(options);
  const candidates = options.modulePath
    ? [primary]
    : (() => {
        const listed = listAuthStoreModuleCandidates(options.distDir);
        return listed.length > 0 ? listed : [primary];
      })();

  const { saveAuthProfileStore, modulePath } = await loadSaveAuthProfileStoreFromCandidates(candidates);
  saveAuthProfileStore(source.store, options.agentDir, { syncExternalCli: false });

  const providers = source.profileIds
    .map((profileId) => source.store.profiles[profileId]?.provider)
    .filter((provider) => typeof provider === "string" && provider.length > 0);

  console.log(
    JSON.stringify({
      materialized: true,
      profileCount: source.profileIds.length,
      providers,
      modulePath,
    }),
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
