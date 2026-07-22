#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Persistent Environment Entrypoint
# =============================================================================
# Runs as root. Sets up persistent directories on /data volume, generates
# config from template + env vars, bootstraps workspace, restores packages,
# then launches the main process.
#
# Persistence model:
#   /data/<tenant>/home -> node user's HOME
#                           (dotfiles, npm/bun cache, browser state, tool state)
#   /data/<tenant>/home/.openclaw/workspace
#                        -> agent workspace (projects, memory, identity)
#   /data/home          -> legacy fallback when INSTANCE_NAME is not set
#   /data/openclaw.json    -> generated from /app/config/openclaw.json + env vars
#   /data/overlay/usr-local -> overlayfs for /usr/local (manual binaries)
#   /data/package-state/   -> captured apt/pip state for restore on restart
# =============================================================================

DATA_DIR="/data"
PERSISTENT_HOME="$DATA_DIR/home"
WORKSPACE=""
OPENCLAW_STATE_DIR=""
LEGACY_WORKSPACE=""
CONFIG_TEMPLATE="/app/config/openclaw.json"
CONFIG_LIVE="$DATA_DIR/openclaw.json"
CONFIG_LOCK="/app/config-lock.json"
# Optional PVC-persisted override survives pod restarts when the image lock lags.
if [ -f "$DATA_DIR/config-lock.override.json" ]; then
  CONFIG_LOCK="$DATA_DIR/config-lock.override.json"
fi
WORKSPACE_TEMPLATE="/app/workspace"
NODE_UID=1000
NODE_GID=1000
GATEWAY_TOKEN_FILE="$DATA_DIR/.openclaw-gateway-token"
# Config safety net files
CONFIG_KNOWN_GOOD="$DATA_DIR/openclaw.json.known-good"
CONFIG_ROLLBACK_LOG="$DATA_DIR/config-rollback.log"
NODE_REPORT_DIR="$DATA_DIR/openclaw-reports"
OPENCLAW_DIAGNOSTICS_DIR="$DATA_DIR/openclaw-diagnostics"

set_workspace_paths() {
  OPENCLAW_STATE_DIR="$PERSISTENT_HOME/.openclaw"
  WORKSPACE="$OPENCLAW_STATE_DIR/workspace"
  LEGACY_WORKSPACE="$PERSISTENT_HOME"
}

log() { echo "[entrypoint] $*"; }

state_config_path() {
  printf '%s/openclaw.json\n' "$OPENCLAW_STATE_DIR"
}

migrate_state_dir_config_to_live() {
  local state_config
  state_config=$(state_config_path)

  if [ ! -f "$CONFIG_LIVE" ] && [ -f "$state_config" ]; then
    log "[config] Migrating existing state config $state_config -> $CONFIG_LIVE"
    cp "$state_config" "$CONFIG_LIVE"
    chown "$NODE_UID:$NODE_GID" "$CONFIG_LIVE" 2>/dev/null || true
  fi
}

sync_live_config_to_state_dir() {
  local state_config
  state_config=$(state_config_path)

  [ -f "$CONFIG_LIVE" ] || return
  mkdir -p "$OPENCLAW_STATE_DIR"

  if [ ! -f "$state_config" ] || ! cmp -s "$CONFIG_LIVE" "$state_config"; then
    cp "$CONFIG_LIVE" "$state_config"
    chown "$NODE_UID:$NODE_GID" "$state_config" 2>/dev/null || true
    log "[config] Mirrored runtime config to $state_config"
  fi
}

normalize_live_config_workspaces() {
  [ -f "$CONFIG_LIVE" ] || return

  local normalized_count
  normalized_count=$(PERSISTENT_HOME="$PERSISTENT_HOME" \
    WORKSPACE="$WORKSPACE" \
    LEGACY_WORKSPACE="$LEGACY_WORKSPACE" \
    INSTANCE_NAME="${INSTANCE_NAME:-}" \
    python3 - <<'PYEOF'
import json
import os

live_path = "/data/openclaw.json"
canonical_workspace = "/workspace"

persistent_home = os.environ["PERSISTENT_HOME"]
workspace = os.environ["WORKSPACE"]
legacy_workspace = os.environ["LEGACY_WORKSPACE"]
instance_name = os.environ.get("INSTANCE_NAME", "")

legacy_workspace_values = {
    persistent_home,
    workspace,
    legacy_workspace,
    "/data/home",
    "/data/home/.openclaw/workspace",
}
if instance_name:
    legacy_workspace_values.add(f"/data/{instance_name}/home")
    legacy_workspace_values.add(f"/data/{instance_name}/home/.openclaw/workspace")

with open(live_path, encoding="utf-8") as f:
    config = json.load(f)

changed_count = 0

def normalize(value):
    global changed_count
    if isinstance(value, dict):
        for key, child in list(value.items()):
            if key == "workspace" and child in legacy_workspace_values:
                value[key] = canonical_workspace
                changed_count += 1
            else:
                normalize(child)
    elif isinstance(value, list):
        for child in value:
            normalize(child)

normalize(config)

if changed_count:
    with open(live_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
        f.write("\n")

print(changed_count)
PYEOF
  )

  if [ "$normalized_count" != "0" ]; then
    chown "$NODE_UID:$NODE_GID" "$CONFIG_LIVE" 2>/dev/null || true
    sync_live_config_to_state_dir
    log "[config] Normalized $normalized_count legacy workspace path(s) to /workspace"
  fi
}

set_workspace_paths

ensure_workspace_directory() {
  if [ -L "$WORKSPACE" ]; then
    log "Replacing copied workspace symlink at $WORKSPACE with persistent directory"
    rm -f "$WORKSPACE"
  fi
}

select_persistent_home() {
  if [ -z "${INSTANCE_NAME:-}" ]; then
    return
  fi

  local host_visible_home="$DATA_DIR/$INSTANCE_NAME/home"
  local legacy_home="$PERSISTENT_HOME"

  if [ "$host_visible_home" = "$PERSISTENT_HOME" ]; then
    return
  fi

  if [ ! -d "$host_visible_home" ] && [ -d "$legacy_home" ] && [ -n "$(ls -A "$legacy_home" 2>/dev/null || true)" ]; then
    mkdir -p "$(dirname "$host_visible_home")"
    cp -a "$legacy_home/." "$host_visible_home/" 2>/dev/null || true
    log "Copied legacy persistent home $legacy_home -> $host_visible_home"
  fi

  PERSISTENT_HOME="$host_visible_home"
  set_workspace_paths
}

select_persistent_home

append_node_option_once() {
  local option="$1"
  case " ${NODE_OPTIONS:-} " in
    *" $option "*) ;;
    *) export NODE_OPTIONS="${NODE_OPTIONS:-}${NODE_OPTIONS:+ }$option" ;;
  esac
}

generate_gateway_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<'PYEOF'
import os
print(os.urandom(32).hex())
PYEOF
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
    printf '\n'
  fi
}

# ---------------------------------------------------------------------------
# Helper: substitute ${VAR_NAME} patterns with environment variable values
# Pure bash — no external dependencies (envsubst not guaranteed on all images)
#
# Safety: Uses bash indirect expansion (${!var}), NOT eval. Variable names
# are constrained to [A-Za-z_][A-Za-z0-9_]* by regex. Single-pass to prevent
# value-injection (env var values containing ${X} are NOT re-expanded).
# ---------------------------------------------------------------------------
envsubst_bash() {
  local input="$1"
  local output="$2"
  local content
  content=$(<"$input")

  # Collect all unique ${VAR_NAME} patterns first, then replace in one pass.
  # This prevents values containing ${...} from being re-expanded.
  local -A replacements=()
  local temp="$content"
  while [[ "$temp" =~ \$\{([A-Za-z_][A-Za-z0-9_]*)\} ]]; do
    local var_name="${BASH_REMATCH[1]}"
    replacements["$var_name"]="${!var_name:-}"
    # Remove this occurrence to find the next unique var
    temp="${temp/\$\{$var_name\}/}"
  done

  # Apply all replacements
  for var_name in "${!replacements[@]}"; do
    content="${content//\$\{$var_name\}/${replacements[$var_name]}}"
  done

  printf '%s\n' "$content" > "$output"
}

# ---------------------------------------------------------------------------
# 1. First-run: bootstrap persistent home from skeleton
# ---------------------------------------------------------------------------
if [ ! -d "$PERSISTENT_HOME" ] || [ -z "$(ls -A "$PERSISTENT_HOME" 2>/dev/null)" ]; then
  log "First run — creating persistent home at $PERSISTENT_HOME"
  mkdir -p "$PERSISTENT_HOME"
  chown "$NODE_UID:$NODE_GID" "$PERSISTENT_HOME"

  # Copy initial dotfiles from the container's /home/node
  if [ -d /home/node ]; then
    cp -a /home/node/. "$PERSISTENT_HOME/" 2>/dev/null || true
  fi
fi

# Ensure workspace exists. /workspace must stay narrow; pointing it at the
# whole persistent home makes OpenClaw watch caches, auth state, browser state,
# package-manager directories, and Docker-adjacent files.
ensure_workspace_directory
mkdir -p "$WORKSPACE" "$OPENCLAW_STATE_DIR" "$LEGACY_WORKSPACE"

# Ensure key directories exist inside persistent home
mkdir -p "$PERSISTENT_HOME/.npm" "$PERSISTENT_HOME/.bun" "$PERSISTENT_HOME/.cache" "$PERSISTENT_HOME/.local/bin"
mkdir -p "$NODE_REPORT_DIR" "$OPENCLAW_DIAGNOSTICS_DIR"

# Fix ownership on directories we just created (non-recursive, fast — 8 syscalls not millions)
chown "$NODE_UID:$NODE_GID" \
  "$PERSISTENT_HOME" \
  "$OPENCLAW_STATE_DIR" \
  "$WORKSPACE" \
  "$LEGACY_WORKSPACE" \
  "$PERSISTENT_HOME/.npm" \
  "$PERSISTENT_HOME/.bun" \
  "$PERSISTENT_HOME/.cache" \
  "$PERSISTENT_HOME/.local" \
  "$PERSISTENT_HOME/.local/bin" \
  "$NODE_REPORT_DIR" \
  "$OPENCLAW_DIAGNOSTICS_DIR"

migrate_legacy_home_workspace_entries() {
  [ "$WORKSPACE" != "$PERSISTENT_HOME" ] || return
  [ -d "$PERSISTENT_HOME" ] || return

  local copied=0
  local linked=0
  local name src dst

  for name in AGENTS.md AGENTS.dev.md BOOT.md BOOTSTRAP.md CLAUDE.md HEARTBEAT.md IDENTITY.md IDENTITY.dev.md MEMORY.md SOUL.md SOUL.dev.md TOOLS.md TOOLS.dev.md USER.md USER.dev.md; do
    src="$PERSISTENT_HOME/$name"
    dst="$WORKSPACE/$name"
    if [ -f "$src" ] && [ ! -e "$dst" ]; then
      cp -a "$src" "$dst" 2>/dev/null || true
      chown "$NODE_UID:$NODE_GID" "$dst" 2>/dev/null || true
      copied=$((copied + 1))
    fi
  done

  for name in memory skills; do
    src="$PERSISTENT_HOME/$name"
    dst="$WORKSPACE/$name"
    if [ -d "$src" ] && [ ! -e "$dst" ]; then
      ln -s "$src" "$dst" 2>/dev/null || true
      chown -h "$NODE_UID:$NODE_GID" "$dst" 2>/dev/null || true
      linked=$((linked + 1))
    fi
  done

  for src in "$PERSISTENT_HOME"/*; do
    [ -e "$src" ] || continue
    name=$(basename "$src")
    case "$name" in
      AGENTS.md|AGENTS.dev.md|BOOT.md|BOOTSTRAP.md|CLAUDE.md|HEARTBEAT.md|IDENTITY.md|IDENTITY.dev.md|MEMORY.md|SOUL.md|SOUL.dev.md|TOOLS.md|TOOLS.dev.md|USER.md|USER.dev.md|memory|skills)
        continue
        ;;
    esac
    dst="$WORKSPACE/$name"
    if [ -d "$src" ] && [ ! -e "$dst" ]; then
      ln -s "$src" "$dst" 2>/dev/null || true
      chown -h "$NODE_UID:$NODE_GID" "$dst" 2>/dev/null || true
      linked=$((linked + 1))
    fi
  done

  if [ "$copied" != "0" ] || [ "$linked" != "0" ]; then
    log "Migrated legacy broad-home workspace entries: copied=$copied linked=$linked"
  fi
}

migrate_legacy_home_workspace_entries

# ---------------------------------------------------------------------------
# 2. openclaw.json — bootstrap only, never overwrite runtime state
# ---------------------------------------------------------------------------
# The agent manages its own config at runtime via `gateway config.patch`.
# We only generate from template on FIRST BOOT (when no config exists yet).
# This prevents deploys from clobbering channels, cron jobs, model settings,
# or any other runtime changes the agent has made.
#
# To force a config reset: delete /data/openclaw.json and redeploy.
# ---------------------------------------------------------------------------
migrate_state_dir_config_to_live

if [ ! -f "$CONFIG_LIVE" ]; then
  if [ -f "$CONFIG_TEMPLATE" ]; then
    log "First boot — generating openclaw.json from template..."
    envsubst_bash "$CONFIG_TEMPLATE" "$CONFIG_LIVE"
    chown "$NODE_UID:$NODE_GID" "$CONFIG_LIVE"
    log "openclaw.json bootstrapped to $CONFIG_LIVE"
  elif [ -f "$CONFIG_LOCK" ]; then
    log "First boot — no template, seeding openclaw.json from config-lock..."
    cp "$CONFIG_LOCK" "$CONFIG_LIVE"
    chown "$NODE_UID:$NODE_GID" "$CONFIG_LIVE"
    log "openclaw.json seeded from config-lock"
  else
    log "No config template found at $CONFIG_TEMPLATE — starting unconfigured"
  fi
else
  log "openclaw.json exists — preserving runtime state (not overwriting)"
fi

sync_live_config_to_state_dir

# ---------------------------------------------------------------------------
# 2b. Gateway auth token — required by OpenClaw for non-loopback binds
# ---------------------------------------------------------------------------
# OpenClaw v2026.5.6 refuses `--bind lan` without a gateway auth path. The
# deployment remains customer-zero-knowledge by generating a stable per-instance
# token when the platform has not injected one explicitly.
# ---------------------------------------------------------------------------
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  if [ -f "$GATEWAY_TOKEN_FILE" ]; then
    OPENCLAW_GATEWAY_TOKEN=$(tr -d '\r\n' < "$GATEWAY_TOKEN_FILE")
  fi

  if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    OPENCLAW_GATEWAY_TOKEN=$(generate_gateway_token)
    umask 077
    printf '%s\n' "$OPENCLAW_GATEWAY_TOKEN" > "$GATEWAY_TOKEN_FILE"
    umask 022
    log "Generated persistent gateway token"
  else
    log "Loaded persistent gateway token"
  fi
else
  log "Using platform-injected gateway token"
fi

chmod 600 "$GATEWAY_TOKEN_FILE" 2>/dev/null || true
chown "$NODE_UID:$NODE_GID" "$GATEWAY_TOKEN_FILE" 2>/dev/null || true
export OPENCLAW_GATEWAY_TOKEN

# ---------------------------------------------------------------------------
# 3. Bootstrap workspace files + refresh base instructions
# ---------------------------------------------------------------------------
# /app/workspace/ is generated at Docker build time (not manually maintained):
#   - OpenClaw's default templates extracted from /app/docs/reference/templates/
#   - YAML frontmatter stripped
#   - Infra managed blocks appended (AGENTS.md, TOOLS.md)
#   - Extra files (MEMORY.md) copied from the repo
# See scripts/build-workspace-templates.py and Dockerfile.base for details.
#
# 3-layer architecture:
#   Layer 1 (OpenClaw): Default templates → updated on OpenClaw upgrade
#   Layer 2 (Infra):    Managed blocks in workspace files → refreshed every boot
#   Layer 3 (Agent):    IDENTITY.md, USER.md, memory → never overwritten
#
# On first boot: copy all template files to workspace.
# Every boot: refresh managed blocks (BEGIN/END MANAGED BLOCK) in workspace files.
# Agent-owned content outside the managed blocks is never touched.
# ---------------------------------------------------------------------------
if [ -d "$WORKSPACE_TEMPLATE" ] && [ -n "$(ls -A "$WORKSPACE_TEMPLATE" 2>/dev/null)" ]; then
  # Copy template files that don't already exist (e.g., MEMORY.md)
  for tmpl_file in "$WORKSPACE_TEMPLATE"/*; do
    fname=$(basename "$tmpl_file")
    if [ ! -f "$WORKSPACE/$fname" ]; then
      cp "$tmpl_file" "$WORKSPACE/$fname" 2>/dev/null || true
      chown "$NODE_UID:$NODE_GID" "$WORKSPACE/$fname" 2>/dev/null || true
      log "Copied workspace template: $fname"
    fi
  done
fi

# Refresh managed blocks in workspace files (generic — any .md with BEGIN/END MANAGED BLOCK)
for tmpl_file in "$WORKSPACE_TEMPLATE"/*.md; do
  [ -f "$tmpl_file" ] || continue
  fname=$(basename "$tmpl_file")
  dst_file="$WORKSPACE/$fname"
  # Only process template files that contain a managed block
  grep -q '<!-- BEGIN MANAGED BLOCK -->' "$tmpl_file" 2>/dev/null || continue
  [ -f "$dst_file" ] || continue
  python3 -c "
import sys, re
with open(sys.argv[1]) as f: src = f.read()
with open(sys.argv[2]) as f: dst = f.read()
pat = r'<!-- BEGIN MANAGED BLOCK -->.*?<!-- END MANAGED BLOCK -->'
base = re.search(pat, src, re.DOTALL)
if not base: sys.exit(0)
if re.search(pat, dst, re.DOTALL):
    new = re.sub(pat, base.group(0), dst, count=1, flags=re.DOTALL)
    if new != dst:
        with open(sys.argv[2], 'w') as f: f.write(new)
        print('updated')
    else:
        print('unchanged')
else:
    with open(sys.argv[2], 'a') as f: f.write('\n\n' + base.group(0) + '\n')
    print('appended')
" "$tmpl_file" "$dst_file" 2>/dev/null | while read -r status; do
    log "Managed block in $fname: $status"
  done
  chown "$NODE_UID:$NODE_GID" "$dst_file" 2>/dev/null || true
done

# ---------------------------------------------------------------------------
# 4. Install auth-profiles.json
# ---------------------------------------------------------------------------
# Preferred source order:
#   1. Baked file from the image when CI provided one
#   2. Platform-injected provider env keys for zero-Dockerfile/customer builds
#   3. Legacy /data auth store migration
#
# Merge strategy:
#   - First boot (no existing file): install from the selected source
#   - Subsequent boots: compare image hash vs installed hash
#     - If different: new keys deployed, replace file (fresh rate limit state)
#     - If same: keep existing file (preserves runtime state like cooldowns)
#
# Hash stored at /data/.auth-profiles.hash (outside agent dir to survive resets)
AUTH_SRC="/app/auth/auth-profiles.json"
AUTH_GENERATED_SRC="$DATA_DIR/.auth-profiles.generated.json"
AUTH_DEST_DIR="$OPENCLAW_STATE_DIR/agents/main/agent"
AUTH_DEST="$AUTH_DEST_DIR/auth-profiles.json"
LEGACY_AUTH_DEST="$DATA_DIR/agents/main/agent/auth-profiles.json"
AUTH_HASH="$DATA_DIR/.auth-profiles.hash"
AUTH_SQLITE_MATERIALIZER="/usr/local/lib/openclaw-materialize-auth-store.mjs"

mkdir -p "$AUTH_DEST_DIR"

if [ ! -f "$AUTH_SRC" ] && { [ -n "${SYLPHX_AI_API_KEY:-}" ] || [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${DIRECT_ANTHROPIC_API_KEY:-}" ] || [ -n "${OPENROUTER_API_KEY:-}" ] || [ -n "${OPENAI_API_KEY:-}" ]; }; then
  umask 077
  python3 - "$AUTH_GENERATED_SRC" <<'PYEOF'
import json
import os
import sys

output_path = sys.argv[1]
profiles = {}

sylphx_api_key = os.environ.get("SYLPHX_AI_API_KEY")
legacy_anthropic_api_key = os.environ.get("ANTHROPIC_API_KEY")
if not sylphx_api_key and legacy_anthropic_api_key and not legacy_anthropic_api_key.startswith("sk-ant-"):
    sylphx_api_key = legacy_anthropic_api_key

if sylphx_api_key:
    profiles["sylphx:default"] = {
        "provider": "sylphx",
        "token": sylphx_api_key,
        "type": "token",
    }

anthropic_api_key = os.environ.get("DIRECT_ANTHROPIC_API_KEY")
if not anthropic_api_key and legacy_anthropic_api_key and legacy_anthropic_api_key.startswith("sk-ant-"):
    anthropic_api_key = legacy_anthropic_api_key
if anthropic_api_key:
    profiles["anthropic:default"] = {
        "provider": "anthropic",
        "token": anthropic_api_key,
        "type": "token",
    }

openrouter_api_key = os.environ.get("OPENROUTER_API_KEY")
if openrouter_api_key:
    profiles["openrouter:fallback"] = {
        "provider": "openrouter",
        "token": openrouter_api_key,
        "type": "token",
    }

openai_api_key = os.environ.get("OPENAI_API_KEY")
if openai_api_key:
    profiles["openai:default"] = {
        "provider": "openai",
        "token": openai_api_key,
        "type": "token",
    }

with open(output_path, "w", encoding="utf-8") as f:
    json.dump({"version": 1, "profiles": profiles}, f, indent=2)
    f.write("\n")
PYEOF
  umask 022
  chown "$NODE_UID:$NODE_GID" "$AUTH_GENERATED_SRC" 2>/dev/null || true
  AUTH_SRC="$AUTH_GENERATED_SRC"
fi

if [ -f "$AUTH_SRC" ]; then
  # Count tokens from source (works regardless of which branch we take)
  TOKEN_COUNT=$(grep -o '"token"' "$AUTH_SRC" | wc -l)

  # Compute hash of new auth file
  NEW_HASH=$(sha256sum "$AUTH_SRC" | cut -d' ' -f1)
  OLD_HASH=""
  [ -f "$AUTH_HASH" ] && OLD_HASH=$(cat "$AUTH_HASH")

  # Determine action based on state
  if [ ! -f "$AUTH_DEST" ]; then
    ACTION="first boot"
  elif [ "$NEW_HASH" != "$OLD_HASH" ]; then
    ACTION="keys changed"
  else
    ACTION="unchanged"
  fi

  # Apply changes if needed
  if [ "$ACTION" != "unchanged" ]; then
    cp "$AUTH_SRC" "$AUTH_DEST"
    echo "$NEW_HASH" > "$AUTH_HASH"
  fi

  chown "$NODE_UID:$NODE_GID" "$OPENCLAW_STATE_DIR/agents" "$OPENCLAW_STATE_DIR/agents/main" "$AUTH_DEST_DIR" "$AUTH_DEST" 2>/dev/null || true
  [ -f "$AUTH_HASH" ] && chown "$NODE_UID:$NODE_GID" "$AUTH_HASH"
  log "auth-profiles.json ($TOKEN_COUNT setup tokens) — $ACTION"
elif [ ! -f "$AUTH_DEST" ] && [ -f "$LEGACY_AUTH_DEST" ]; then
  cp "$LEGACY_AUTH_DEST" "$AUTH_DEST"
  chown "$NODE_UID:$NODE_GID" "$OPENCLAW_STATE_DIR/agents" "$OPENCLAW_STATE_DIR/agents/main" "$AUTH_DEST_DIR" "$AUTH_DEST" 2>/dev/null || true
  log "auth-profiles.json migrated from legacy store to $AUTH_DEST"
else
  chown "$NODE_UID:$NODE_GID" "$OPENCLAW_STATE_DIR/agents" "$OPENCLAW_STATE_DIR/agents/main" "$AUTH_DEST_DIR" 2>/dev/null || true
  log "No auth-profiles.json found at $AUTH_SRC — setup tokens not configured"
fi

if [ -f "$AUTH_DEST" ]; then
  log "[auth-store] Materializing OpenClaw SQLite auth store from $AUTH_DEST ..."
  AUTH_MATERIALIZE_OUTPUT=$(runuser -u node -- env \
      HOME="$PERSISTENT_HOME" \
      OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" \
      OPENCLAW_CONFIG_PATH="$CONFIG_LIVE" \
      node "$AUTH_SQLITE_MATERIALIZER" \
      --agent-dir "$AUTH_DEST_DIR" \
      --auth-profile "$AUTH_DEST" 2>&1) || {
      log "[auth-store] Failed to materialize SQLite auth store: $AUTH_MATERIALIZE_OUTPUT"
      exit 1
    }
  log "[auth-store] $AUTH_MATERIALIZE_OUTPUT"
fi

# ---------------------------------------------------------------------------
# 5. Fix ownership — only full scan on first boot or ownership reset
# ---------------------------------------------------------------------------
# The recursive chown is a catastrophic bottleneck for large data volumes
# (79GB / millions of files = 2-5 min blocking startup). Instead, we:
#   1. Own directories at creation point (non-recursive, O(n) dirs)
#   2. Use a sentinel to run the full scan exactly once
#   3. To force re-scan: delete /data/.ownership-ok and restart
# ---------------------------------------------------------------------------
OWNERSHIP_SENTINEL="$DATA_DIR/.ownership-ok"
if [ ! -f "$OWNERSHIP_SENTINEL" ]; then
  log "First ownership fix — scanning $PERSISTENT_HOME (this is one-time)..."
  chown -R "$NODE_UID:$NODE_GID" "$PERSISTENT_HOME"
  chown "$NODE_UID:$NODE_GID" "$DATA_DIR"
  touch "$OWNERSHIP_SENTINEL"
  log "Ownership fix complete — subsequent boots will skip this"
else
  log "Ownership sentinel found — skipping recursive chown"
fi

# ---------------------------------------------------------------------------
# 6. Symlink /home/node -> persistent home
# ---------------------------------------------------------------------------
if [ ! -L /home/node ] || [ "$(readlink /home/node)" != "$PERSISTENT_HOME" ]; then
  rm -rf /home/node
  ln -sf "$PERSISTENT_HOME" /home/node
  log "Symlinked /home/node → $PERSISTENT_HOME"
fi

# ---------------------------------------------------------------------------
# 6b. DooD fix — unify all paths to host-visible root
# ---------------------------------------------------------------------------
# In Docker-outside-of-Docker, the user home path systems must agree:
#   1. $HOME (runtime env var, set in section 10 from PERSISTENT_HOME)
#   2. passwd home (os.userInfo().homedir → sandbox bind mount source)
#   3. workspace config (openclaw.json agents.defaults.workspace -> /workspace)
#
# Without this fix, HOME and passwd home can resolve through different path
# strings. OpenClaw and its tools compare paths as strings in several places, so
# the runtime must expose one canonical tenant home path while /workspace stays
# narrowed to the managed workspace directory.
#
# Fix: keep PERSISTENT_HOME on the host-visible path. Section 10 then exports
# HOME=$PERSISTENT_HOME; set_workspace_paths derives /workspace from that home.
# ---------------------------------------------------------------------------
if [ -n "${INSTANCE_NAME:-}" ]; then
  HOST_VISIBLE_HOME="/data/$INSTANCE_NAME/home"
  if [ -d "$HOST_VISIBLE_HOME" ]; then
    PERSISTENT_HOME="$HOST_VISIBLE_HOME"
    set_workspace_paths

    # Re-point symlink to host-visible path
    if [ "$(readlink /home/node 2>/dev/null)" != "$PERSISTENT_HOME" ]; then
      rm -f /home/node
      ln -sf "$PERSISTENT_HOME" /home/node
      log "Symlink /home/node → $PERSISTENT_HOME (DooD)"
    fi

    # Update passwd home for os.userInfo().homedir
    CURRENT_PASSWD_HOME=$(getent passwd node | cut -d: -f6)
    if [ "$CURRENT_PASSWD_HOME" != "$HOST_VISIBLE_HOME" ]; then
      usermod -d "$HOST_VISIBLE_HOME" node 2>/dev/null || true
    fi

    log "DooD paths unified: $HOST_VISIBLE_HOME"
  fi
fi

# WORKSPACE can change after the DooD host-visible home rewrite above. Recreate
# the final directories here so the /workspace symlink never points at a
# missing target.
ensure_workspace_directory
mkdir -p "$WORKSPACE" "$OPENCLAW_STATE_DIR" "$LEGACY_WORKSPACE"
chown "$NODE_UID:$NODE_GID" "$WORKSPACE" "$OPENCLAW_STATE_DIR" "$LEGACY_WORKSPACE"

# Create /workspace alias in main container — sandbox tools reference this path
# for image analysis, file reads, etc. Must be after section 6b (WORKSPACE may change).
if [ ! -e /workspace ] || [ -L /workspace ]; then
  ln -sfn "$WORKSPACE" /workspace
  log "Symlink /workspace → $WORKSPACE"
fi

# ---------------------------------------------------------------------------
# 7. Overlay /usr/local — persist manually installed binaries
# ---------------------------------------------------------------------------
# Only /usr/local gets an overlay (gh, cloudflared, etc.).
# Package managers redirect to HOME dirs instead of broad system overlays.
# On new image: clear overlay so fresh image /usr/local takes precedence.
# ---------------------------------------------------------------------------
OVERLAY_BASE="$DATA_DIR/overlay"
IMAGE_HASH_FILE="$DATA_DIR/.image-hash"
CURRENT_IMAGE_HASH=""
[ -f /app/.image-hash ] && CURRENT_IMAGE_HASH=$(cat /app/.image-hash)
[ -z "$CURRENT_IMAGE_HASH" ] && CURRENT_IMAGE_HASH=$(sha256sum /app/package.json 2>/dev/null | cut -d' ' -f1 || echo "unknown")

OLD_IMAGE_HASH=""
[ -f "$IMAGE_HASH_FILE" ] && OLD_IMAGE_HASH=$(cat "$IMAGE_HASH_FILE")

if [ "$CURRENT_IMAGE_HASH" != "$OLD_IMAGE_HASH" ]; then
  if [ -d "$OVERLAY_BASE/usr-local" ]; then
    log "New image detected — clearing /usr/local overlay"
    rm -rf "$OVERLAY_BASE/usr-local"
  fi
fi
echo "$CURRENT_IMAGE_HASH" > "$IMAGE_HASH_FILE"

mkdir -p "$OVERLAY_BASE/usr-local/upper" "$OVERLAY_BASE/usr-local/work"
if mount -t overlay overlay \
    -o "lowerdir=/usr/local,upperdir=$OVERLAY_BASE/usr-local/upper,workdir=$OVERLAY_BASE/usr-local/work" \
    /usr/local 2>/dev/null; then
  log "Overlay /usr/local mounted — manually installed binaries persist"
else
  log "Warning: /usr/local overlay failed — manual binaries won't persist across restarts"
fi

# ---------------------------------------------------------------------------
# 8. Persist apt cache — symlink for fast reinstalls
# ---------------------------------------------------------------------------
mkdir -p /data/cache/apt
# Preserve any .debs already in the container's cache
if [ -d /var/cache/apt/archives ] && [ ! -L /var/cache/apt/archives ]; then
  cp -n /var/cache/apt/archives/*.deb /data/cache/apt/ 2>/dev/null || true
  rm -rf /var/cache/apt/archives
fi
ln -sfn /data/cache/apt /var/cache/apt/archives
mkdir -p /data/cache/apt/partial
log "apt cache linked to /data/cache/apt"

# ---------------------------------------------------------------------------
# 9. Restore packages from captured state
# ---------------------------------------------------------------------------
# Reinstall user-installed apt packages (diff against base image snapshot).
# pip --user packages restore. npm/bun globals live in overlay or HOME.
# ---------------------------------------------------------------------------
PACKAGE_STATE="$DATA_DIR/package-state"

if [ -f "$PACKAGE_STATE/apt.txt" ] && [ -s "$PACKAGE_STATE/apt.txt" ]; then
  mapfile -t APT_PACKAGES < <(sed '/^[[:space:]]*$/d' "$PACKAGE_STATE/apt.txt")
  if [ "${#APT_PACKAGES[@]}" -gt 0 ]; then
    log "Restoring apt packages: ${APT_PACKAGES[*]}"
    apt-get update -qq 2>/dev/null || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${APT_PACKAGES[@]}" 2>/dev/null || {
      log "Warning: some apt packages failed to install"
    }
  fi
fi

if [ -f "$PACKAGE_STATE/pip.txt" ] && [ -s "$PACKAGE_STATE/pip.txt" ]; then
  log "Restoring pip --user packages..."
  pip3 install --user --break-system-packages -q -r "$PACKAGE_STATE/pip.txt" 2>/dev/null || {
    log "Warning: some pip packages failed to install"
  }
fi

# ---------------------------------------------------------------------------
# 10. Environment setup — XDG, package manager homes, PATH
# ---------------------------------------------------------------------------
export HOME="$PERSISTENT_HOME"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_RUNTIME_DIR="/run/user/$NODE_UID"
export OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_LIVE"

# Package manager homes — all on persistent volume
export BUN_INSTALL="$HOME/.bun"
export npm_config_prefix="$HOME/.npm-global"
export GOPATH="$HOME/go"
export CARGO_HOME="$HOME/.cargo"
export PIP_USER=1

# PATH: user-local bins first, then system
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$HOME/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Create all dirs
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR" && chown "$NODE_UID:$NODE_GID" "$XDG_RUNTIME_DIR"
mkdir -p "$HOME/.local/bin" "$HOME/.npm-global" "$HOME/.cargo" "$HOME/go"
chown "$NODE_UID:$NODE_GID" \
  "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" \
  "$HOME/.local" "$HOME/.local/bin" "$HOME/.npm-global" "$HOME/.cargo" "$HOME/go"

# Write persist-env.sh for interactive shells
PROFILE_D="$HOME/.persist-env.sh"
cat > "$PROFILE_D" << 'ENVEOF'
# Auto-generated by entrypoint — do not edit
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"
export OPENCLAW_STATE_DIR="$HOME/.openclaw"
export OPENCLAW_CONFIG_PATH="/data/openclaw.json"
export BUN_INSTALL="$HOME/.bun"
export npm_config_prefix="$HOME/.npm-global"
export GOPATH="$HOME/go"
export CARGO_HOME="$HOME/.cargo"
export PIP_USER=1
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$HOME/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENVEOF
chown "$NODE_UID:$NODE_GID" "$PROFILE_D"

# Ensure .bashrc sources persist-env.sh
BASHRC="$HOME/.bashrc"
if ! grep -q 'persist-env.sh' "$BASHRC" 2>/dev/null; then
  # shellcheck disable=SC2016
  printf '\n%s\n%s\n' \
    '# Persistent environment (added by entrypoint)' \
    '[ -f "$HOME/.persist-env.sh" ] && source "$HOME/.persist-env.sh"' >> "$BASHRC"
fi

# Remove legacy persist-wrappers references from .bashrc
if grep -q 'persist-wrappers' "$BASHRC" 2>/dev/null; then
  sed -i '/persist-wrappers/d' "$BASHRC"
fi

log "Persistent environment ready. HOME=$HOME"

# ---------------------------------------------------------------------------
# 10.5. Configure mcporter with Tavily MCP (first boot only)
# ---------------------------------------------------------------------------
MCPORTER_CONFIG="$HOME/.mcporter/mcporter.json"
if [ ! -f "$MCPORTER_CONFIG" ] && [ -n "${TAVILY_API_KEY:-}" ]; then
  mkdir -p "$(dirname "$MCPORTER_CONFIG")"
  cat > "$MCPORTER_CONFIG" <<MCPEOF
{
  "mcpServers": {
    "tavily": {
      "command": "bunx tavily-mcp",
      "env": {
        "TAVILY_API_KEY": "${TAVILY_API_KEY}"
      }
    }
  },
  "imports": []
}
MCPEOF
  chown "$NODE_UID:$NODE_GID" "$HOME/.mcporter" "$MCPORTER_CONFIG"
  log "mcporter configured with Tavily MCP (using bunx)"
fi

# ---------------------------------------------------------------------------
# 11. dbus + timezone (reduces browser detection surface)
# ---------------------------------------------------------------------------
# dbus: Chromium expects a running system bus — without it, stderr floods with
# dbus errors and some APIs (battery, UPower) behave differently than real systems.
if command -v dbus-daemon >/dev/null 2>&1; then
  mkdir -p /run/dbus
  if ! pgrep -x dbus-daemon >/dev/null 2>&1; then
    dbus-daemon --system --fork 2>/dev/null || true
    log "dbus system bus started"
  fi
fi

# Timezone: set from TZ env var if provided, so browser Intl API is consistent.
# TZ is set via docker-compose.yml env. Default to Europe/London if unset.
if [ -n "${TZ:-}" ]; then
  echo "$TZ" > /etc/timezone 2>/dev/null || true
  ln -sf "/usr/share/zoneinfo/$TZ" /etc/localtime 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 12. Start Xvfb virtual display (for non-headless browser)
# ---------------------------------------------------------------------------
if [ "${OPENCLAW_XVFB:-false}" = "true" ]; then
  if command -v Xvfb >/dev/null 2>&1; then
    # Kill any stale Xvfb from previous run
    rm -f /tmp/.X99-lock 2>/dev/null || true

    Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -nolisten unix &
    XVFB_PID=$!
    export DISPLAY=:99

    # Wait for Xvfb to be ready
    for _ in $(seq 1 10); do
      if [ -e /tmp/.X11-unix/X99 ]; then break; fi
      sleep 0.2
    done

    log "Xvfb running (PID=$XVFB_PID, DISPLAY=:99) — browser runs in headed mode"
  else
    log "Warning: OPENCLAW_XVFB=true but Xvfb not installed"
  fi
fi

# ---------------------------------------------------------------------------
# 13. Docker daemon for sandbox containers
# ---------------------------------------------------------------------------
# If DOCKER_HOST is set, an external Docker daemon is available (e.g. platform
# sidecar, remote daemon, or DooD socket mount). Use it directly — no local
# dockerd needed. This is the standard Docker convention, portable across all
# platforms (AWS ECS, Railway, bare metal, Kubernetes sidecar, etc.).
#
# If DOCKER_HOST is not set and dockerd is available, start a local daemon.
# This is the self-contained fallback for environments without external Docker.
# ---------------------------------------------------------------------------
if [ -n "${DOCKER_HOST:-}" ]; then
  log "Docker available via DOCKER_HOST=$DOCKER_HOST — skipping local daemon"
elif command -v dockerd >/dev/null 2>&1; then
  log "Starting Docker daemon..."
  mkdir -p /var/run/docker
  mkdir -p "$DATA_DIR/logs"
  chown "$NODE_UID:$NODE_GID" "$DATA_DIR/logs" 2>/dev/null || true

  DOCKER_DATA="$DATA_DIR/docker"
  DOCKER_STORAGE="overlay2"

  # Detect virtiofs/FUSE — overlay2 requires native filesystem (ext4/xfs).
  # On Kata VMs, volumes are virtiofs which lacks xattr + tmpfile for overlayfs.
  # Fix: loop-mount a sparse ext4 disk image as Docker's data-root.
  # On normal Linux (bare metal, runc containers), this block is skipped.
  FS_TYPE=$(findmnt -n -o FSTYPE --target "$DATA_DIR" 2>/dev/null || echo "unknown")
  if echo "$FS_TYPE" | grep -qE "virtiofs|v9fs|fuse"; then
    DOCKER_IMG="$DATA_DIR/.docker.img"
    DOCKER_DATA="$DATA_DIR/.docker-root"

    # Loop device nodes (Kata guest kernel has the module but no /dev/loop*)
    if [ ! -e /dev/loop0 ]; then
      for i in 0 1 2 3 4 5 6 7; do
        mknod -m 660 "/dev/loop$i" b 7 "$i" 2>/dev/null || true
      done
      mknod -m 660 /dev/loop-control c 10 237 2>/dev/null || true
    fi

    # Sparse ext4 disk image — physical size starts at 0, grows on write.
    # Fresh each boot (Docker data is cache, not user data).
    PVC_KB=$(df -k "$DATA_DIR" 2>/dev/null | tail -1 | awk '{print $2}')
    IMG_GB=$(( (PVC_KB * 80 / 100) / 1024 / 1024 ))
    [ "$IMG_GB" -lt 5 ] && IMG_GB=5
    truncate --size="${IMG_GB}G" "$DOCKER_IMG"
    mkfs.ext4 -qF "$DOCKER_IMG"
    mkdir -p "$DOCKER_DATA"
    if mount -o loop "$DOCKER_IMG" "$DOCKER_DATA"; then
      log "Docker data-root: loop-ext4 ${IMG_GB}G (overlay2 on $FS_TYPE)"
    else
      log "Warning: loop mount failed — Docker unavailable"
      DOCKER_STORAGE="vfs"
      DOCKER_DATA="$DATA_DIR/docker"
      mkdir -p "$DOCKER_DATA"
    fi
  else
    mkdir -p "$DOCKER_DATA"
  fi

  dockerd --storage-driver="$DOCKER_STORAGE" \
          --data-root="$DOCKER_DATA" \
          --iptables=false \
          --bridge=none \
          --log-level=warn \
          >"$DATA_DIR/logs/dockerd.log" 2>&1 &

  # Wait for Docker socket (up to 30s)
  for _ in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      log "Docker daemon ready"
      break
    fi
    sleep 1
  done

  if ! docker info >/dev/null 2>&1; then
    log "Warning: Docker daemon failed to start — sandbox containers unavailable"
  fi
else
  log "Docker not installed — sandbox containers unavailable"
fi

# ---------------------------------------------------------------------------
# 13.5. Fix Docker socket permissions for node user (DooD)
# ---------------------------------------------------------------------------
# When using Docker-outside-of-Docker, the host's docker.sock is mounted into
# the container. Its GID (e.g., 988 on Hetzner) may differ from the container's
# docker group (e.g., 102). Docker's group_add only applies to PID 1 (root),
# but runuser -u node creates a new process with node's groups from /etc/group.
# We must add node to the socket's actual GID so it has access after priv drop.
# ---------------------------------------------------------------------------
if [ -S /var/run/docker.sock ]; then
  DOCKER_SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
  if [ "$DOCKER_SOCK_GID" != "0" ]; then
    if ! id -G node 2>/dev/null | tr ' ' '\n' | grep -qx "$DOCKER_SOCK_GID"; then
      # Create a group with the host's GID if it doesn't exist in the container
      if ! getent group "$DOCKER_SOCK_GID" >/dev/null 2>&1; then
        groupadd -g "$DOCKER_SOCK_GID" docker-host 2>/dev/null || true
      fi
      DOCKER_HOST_GROUP=$(getent group "$DOCKER_SOCK_GID" | cut -d: -f1)
      if [ -n "$DOCKER_HOST_GROUP" ]; then
        usermod -aG "$DOCKER_HOST_GROUP" node 2>/dev/null || true
        log "Docker socket: added node to group $DOCKER_HOST_GROUP (GID=$DOCKER_SOCK_GID)"
      fi
    else
      log "Docker socket: node already has GID $DOCKER_SOCK_GID"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 13a. Config lock — enforce immutable fields from image on every boot
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 12b. ADR-1226 — retire Sylphx Auto product pins to Executor
# ---------------------------------------------------------------------------
# Managed PVC configs and optional /data/config-lock.override.json historically
# pinned agents.defaults.model to sylphx/auto. Auto is retired on Sylphx AI
# Gateway; rewrite only model product pins (never commands.native enums).
# ---------------------------------------------------------------------------
if [ -f "$CONFIG_LIVE" ] || [ -f "$DATA_DIR/config-lock.override.json" ]; then
  log "[auto-retire] Migrating sylphx/auto model pins to sylphx/executor ..."
  DATA_DIR="$DATA_DIR" python3 - <<'PYEOF'
import json
import os
from pathlib import Path

data_dir = Path(os.environ["DATA_DIR"])


def migrate_model_fields(data: dict) -> bool:
    changed = False
    agents = data.setdefault("agents", {}).setdefault("defaults", {})
    model = agents.get("model")
    if model in ("auto", "sylphx/auto"):
        agents["model"] = {"primary": "sylphx/executor", "fallbacks": []}
        changed = True
    elif isinstance(model, dict):
        if model.get("primary") in ("auto", "sylphx/auto"):
            model["primary"] = "sylphx/executor"
            changed = True
        fb = model.get("fallbacks") or []
        nfb = [
            "sylphx/executor" if x in ("auto", "sylphx/auto") else x
            for x in fb
        ]
        if nfb != list(fb):
            model["fallbacks"] = nfb
            changed = True
    models_map = agents.get("models")
    if isinstance(models_map, dict) and "sylphx/auto" in models_map:
        models_map.setdefault("sylphx/executor", models_map.pop("sylphx/auto"))
        changed = True
    for m in (
        ((data.get("models") or {}).get("providers") or {})
        .get("sylphx", {})
        .get("models")
        or []
    ):
        if isinstance(m, dict) and m.get("id") == "auto":
            m["id"] = "executor"
            if m.get("name") in (None, "Auto", "Sylphx Auto"):
                m["name"] = "Sylphx Executor"
            changed = True
    return changed


for rel in ("openclaw.json", "config-lock.override.json"):
    path = data_dir / rel
    if not path.exists():
        continue
    data = json.loads(path.read_text())
    if migrate_model_fields(data):
        path.write_text(json.dumps(data, indent=2) + "\n")
        print(f"[auto-retire] migrated {path}")
    else:
        print(f"[auto-retire] clean {path}")
PYEOF
fi

# Certain fields (model providers, elevated tools, exec security) are company-
# controlled and must never be modified by agents. On every boot we apply
# /app/config-lock.json as a JSON merge-patch-style overlay on top of the live
# PVC config — locked fields always win, null deletes locked legacy paths, and
# agent-modifiable fields (channels, model preference, cron, skills) are
# preserved exactly as the agent left them.
#
# The merge is staged through a temporary file. Known-good is promoted only
# after the gateway proves healthy; a bad lock must not poison rollback state.
# ---------------------------------------------------------------------------
if [ -f "$CONFIG_LOCK" ] && [ -f "$CONFIG_LIVE" ]; then
  log "[config-lock] Enforcing locked fields from $CONFIG_LOCK ..."
  CONFIG_LOCK_MERGED=$(mktemp "$DATA_DIR/openclaw.json.locked.XXXXXX")
  CONFIG_LOCK_PATH="$CONFIG_LOCK" CONFIG_LOCK_MERGED="$CONFIG_LOCK_MERGED" python3 - <<'PYEOF'
import copy, json, os

def apply_lock_patch(base, patch):
    """Recursively apply platform-owned config. None deletes a locked path."""
    if not isinstance(base, dict) or not isinstance(patch, dict):
        return copy.deepcopy(patch)

    result = copy.deepcopy(base)
    for k, v in patch.items():
        if v is None:
            result.pop(k, None)
        elif k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = apply_lock_patch(result[k], v)
        else:
            result[k] = copy.deepcopy(v)
    return result

live_path = "/data/openclaw.json"
lock_path = os.environ["CONFIG_LOCK_PATH"]
merged_path = os.environ["CONFIG_LOCK_MERGED"]

with open(live_path) as f:
    live = json.load(f)
with open(lock_path) as f:
    lock = json.load(f)

merged = apply_lock_patch(live, lock)

with open(merged_path, "w") as f:
    json.dump(merged, f, indent=2)
    f.write("\n")

print("[config-lock] Merge staged.")
PYEOF
  mv "$CONFIG_LOCK_MERGED" "$CONFIG_LIVE"
  chown "$NODE_UID:$NODE_GID" "$CONFIG_LIVE" 2>/dev/null || true
  sync_live_config_to_state_dir
  log "[config-lock] Done — locked fields enforced; known-good waits for health."
else
  log "[config-lock] Skipping — lock file or live config not found."
fi

normalize_live_config_workspaces

# ---------------------------------------------------------------------------
# 14. Config safety net v3 — boot-time diff (no markers needed)
# ---------------------------------------------------------------------------
# On boot, compare current config with known-good. If they differ AND the
# gateway fails to start, we know the config change caused the crash → rollback.
#
# This eliminates the race condition in v2 (polling-based .pending markers):
# a config change could crash the gateway within 2s (debounce time), before
# the 5s polling interval could set a .pending marker.
#
# Boot-time diff is race-free: if the VM restarted, the diff is already there.
# ---------------------------------------------------------------------------

# Clean up stale .pending markers from v2 (safe to remove)
rm -f "$DATA_DIR/openclaw.json.pending" 2>/dev/null || true

CONFIG_CHANGED=false
if [ -f "$CONFIG_KNOWN_GOOD" ]; then
  if [ -f "$CONFIG_LIVE" ] && ! cmp -s "$CONFIG_LIVE" "$CONFIG_KNOWN_GOOD"; then
    CONFIG_CHANGED=true
    log "[config-safety] Config differs from known-good — will auto-rollback if gateway fails to start"
  else
    log "[config-safety] Config matches known-good"
  fi
else
  log "[config-safety] No known-good config yet (first boot) — will establish after gateway proves healthy"
fi

# ---------------------------------------------------------------------------
# 15. Launch
# ---------------------------------------------------------------------------
append_node_option_once "--dns-result-order=ipv4first"
append_node_option_once "--report-on-fatalerror"
append_node_option_once "--report-uncaught-exception"
append_node_option_once "--report-directory=$NODE_REPORT_DIR"
export OPENCLAW_DIAGNOSTICS="${OPENCLAW_DIAGNOSTICS:-timeline}"
export OPENCLAW_DIAGNOSTICS_TIMELINE_PATH="${OPENCLAW_DIAGNOSTICS_TIMELINE_PATH:-$OPENCLAW_DIAGNOSTICS_DIR/timeline.jsonl}"
export OPENCLAW_DIAGNOSTICS_EVENT_LOOP="${OPENCLAW_DIAGNOSTICS_EVENT_LOOP:-1}"

log "Starting: $*"

cd /app

# ---------------------------------------------------------------------------
# Config safety watchdog v3 — boot-time diff eliminates race condition
#
# Phase 1 (30s): If gateway dies AND config changed since known-good → rollback
#   and exit 1 (Docker restarts container with restored config). No markers needed —
#   the diff was detected at boot time.
#
# Phase 2: Monitor for runtime config changes. Promote to known-good after 45s
#   of stability. If gateway dies after a runtime change → VM restarts → boot
#   detects diff → rollback. Clean and race-free.
# ---------------------------------------------------------------------------
config_safety_watchdog() {
  local gw_pid="$1"
  local config_changed="${2:-false}"

  gw_alive() { kill -0 "$gw_pid" 2>/dev/null; }
  config_mtime() { stat -c %Y "$CONFIG_LIVE" 2>/dev/null || echo 0; }

  log "[config-safety] Watchdog started (PID=$gw_pid, config_changed=$config_changed)"

  # --- Phase 1: Initial health check (30s) ---
  # If config changed since known-good AND gateway crashes → rollback
  local elapsed=0
  while [ "$elapsed" -lt 30 ]; do
    sleep 5
    elapsed=$((elapsed + 5))
    if ! gw_alive; then
      if [ "$config_changed" = "true" ] && [ -f "$CONFIG_KNOWN_GOOD" ]; then
        log "[config-safety] Gateway crashed within ${elapsed}s after config change — restoring known-good"
        cp "$CONFIG_KNOWN_GOOD" "$CONFIG_LIVE"
        chown "$NODE_UID:$NODE_GID" "$CONFIG_LIVE" 2>/dev/null || true
        sync_live_config_to_state_dir
        echo "$(date -Is) ROLLBACK — restored known-good after startup crash (died at ${elapsed}s)" >> "$CONFIG_ROLLBACK_LOG"
        exit 1  # Docker restarts container with restored config
      else
        log "[config-safety] Gateway crashed within ${elapsed}s (not config-related) — watchdog exiting"
        return
      fi
    fi
  done

  # Gateway survived 30s — promote current config to known-good
  cp "$CONFIG_LIVE" "$CONFIG_KNOWN_GOOD" 2>/dev/null || true
  sync_live_config_to_state_dir
  log "[config-safety] Config promoted to known-good (gateway healthy for 30s)"

  # --- Phase 2: Continuous monitoring for runtime config changes ---
  # After promotion, known-good = current. When agent changes config:
  #   - Gateway survives 45s → promote new config to known-good
  #   - Gateway crashes → container restarts → boot detects diff → rollback
  local last_mtime
  last_mtime=$(config_mtime)
  local change_time=0

  while gw_alive; do
    sleep 5

    local current_mtime
    current_mtime=$(config_mtime)

    if [ "$current_mtime" != "$last_mtime" ]; then
      last_mtime="$current_mtime"
      change_time=$(date +%s)
      log "[config-safety] Config change detected — will promote to known-good after 45s"
    fi

    # Promote after 45s of stability since last change
    if [ "$change_time" -gt 0 ]; then
      local now
      now=$(date +%s)
      if [ $((now - change_time)) -ge 45 ]; then
        cp "$CONFIG_LIVE" "$CONFIG_KNOWN_GOOD" 2>/dev/null || true
        sync_live_config_to_state_dir
        change_time=0
        log "[config-safety] Config promoted to known-good (survived 45s after change)"
      fi
    fi
  done

  log "[config-safety] Gateway exited — watchdog done"
}

data_mount_ok() {
  case "${OPENCLAW_REQUIRE_DATA_MOUNT:-true}" in
    false|0|no) return 0 ;;
  esac

  local line
  local mounted=false
  while IFS= read -r line; do
    case "$line" in
      *" $DATA_DIR "*) mounted=true; break ;;
    esac
  done < /proc/mounts

  [ "$mounted" = "true" ] && [ -d "$PERSISTENT_HOME" ] && [ -w "$PERSISTENT_HOME" ]
}

# ---------------------------------------------------------------------------
# Guest DNS integrity (Kata virtiofs / kubelet resolv files)
# ---------------------------------------------------------------------------
# Platform/CRI must mount kubelet-managed /etc/resolv.conf, /etc/hosts, and
# /etc/hostname into the Kata guest (visible as kataShared virtiofs). When
# those mounts are missing, the guest can present empty 0-byte stubs: libc
# getaddrinfo returns EAI_AGAIN for every hostname (api.sylphx.ai included)
# while dig @10.96.0.10 still works.
#
# Product contract (consumer fail-closed — same class as /data watchdog):
#   - Detect empty/missing OS resolver configuration.
#   - Exit so Kubernetes replaces the pod.
#   - Do NOT invent nameservers or rewrite resolv.conf (Platform owns mounts).
# Opt-out only for local non-Kata debugging: OPENCLAW_REQUIRE_GUEST_DNS=false
# ---------------------------------------------------------------------------
guest_dns_ok() {
  case "${OPENCLAW_REQUIRE_GUEST_DNS:-true}" in
    false|0|no) return 0 ;;
  esac

  if [ ! -s /etc/resolv.conf ]; then
    return 1
  fi
  # Require at least one nameserver line (kubelet ClusterFirst content).
  if ! grep -qE '^[[:space:]]*nameserver[[:space:]]+[^[:space:]]+' /etc/resolv.conf 2>/dev/null; then
    return 1
  fi
  return 0
}

data_runtime_state_ok() {
  data_mount_ok &&
    guest_dns_ok &&
    [ -s "$CONFIG_LIVE" ] &&
    [ -d "$OPENCLAW_STATE_DIR" ] &&
    [ -d "$OPENCLAW_DIAGNOSTICS_DIR" ] &&
    [ -w "$OPENCLAW_DIAGNOSTICS_DIR" ]
}

data_mount_watchdog() {
  local gw_pid="$1"
  while kill -0 "$gw_pid" 2>/dev/null; do
    sleep 10
    if ! data_runtime_state_ok; then
      if ! guest_dns_ok; then
        log "[data-watchdog] guest DNS unusable (empty/missing nameserver in /etc/resolv.conf); restarting gateway so Kubernetes replaces the pod"
      else
        log "[data-watchdog] persistent runtime state became unavailable; restarting gateway"
      fi
      kill "$gw_pid" 2>/dev/null || true
      return
    fi
  done
}

if ! guest_dns_ok; then
  log "[guest-dns] /etc/resolv.conf is empty or has no nameserver — Kata/kubelet DNS mounts missing or broken"
  log "[guest-dns] fail-closed: refusing to start (Platform owns guest DNS file mounts; OpenClaw will not invent nameservers)"
  exit 1
fi

if ! data_runtime_state_ok; then
  log "[data-watchdog] persistent runtime state is unavailable before launch"
  exit 1
fi

case "${OPENCLAW_RUN_AS_ROOT:-false}" in
  true|1|yes)
    log "Running as root (OPENCLAW_RUN_AS_ROOT=${OPENCLAW_RUN_AS_ROOT})"
    "$@" &
    GW_PID=$!
    ;;
  *)
    log "Running as node (UID=$NODE_UID)"
    runuser -u node -- "$@" &
    GW_PID=$!
    ;;
esac

config_safety_watchdog "$GW_PID" "$CONFIG_CHANGED" &
data_mount_watchdog "$GW_PID" &

# Forward signals to the gateway process
trap 'kill "$GW_PID" 2>/dev/null' TERM INT
wait $GW_PID
EXIT_CODE=$?
exit $EXIT_CODE
