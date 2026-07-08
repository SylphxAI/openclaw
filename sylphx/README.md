# OpenClaw Multi-Instance Customer App

Customer app repo for deploying and managing multiple [OpenClaw](https://github.com/openclaw/openclaw) AI assistant instances on Sylphx. This repo owns the OpenClaw image, shared instance config, runtime contract, and app-level operational policy. Sylphx platform remains zero-knowledge and consumes one generic `openclaw` service template in [`sylphx.json`](sylphx.json); environment fan-out and concrete backend names are platform state.

```
                        ┌─────────────────────────────────┐
                        │       SylphxAI/platform          │
                        │   Platform CD → K8s reconcile    │
                        └──────────┬──────────────────────┘
                                   │
                                   ▼
                   ┌──────────────────────────────────┐
                   │   Cloudflare Edge (DDoS/WAF)      │
                   └──────────┬───────────────────────┘
                              │
                   ┌──────────▼───────────────────────┐
                   │  CAPI Talos K8s Cluster            │
                   │  Cilium Gateway API (HTTPS/TLS)    │
                   ├────────────────────────────────────┤
                   │  env-* namespaces                    │
                   │  ┌───────┬───────┬───────┬───────┐ │
                   │  │sylphx │ozyrix│wclo…  │tse…   │ │
                   │  │openclaw service template per env│ │
                   │  └───────┴───────┴───────┴───────┘ │
                   │  Ceph RBD PVCs (persistent data)    │
                   └─────────────────────────────────────┘
```

## Key Features

- **Declarative instances** — Define all instances in [`agents.yaml`](agents.yaml), generate configs with one command
- **Customer-owned runtime intent** — [`sylphx.json`](sylphx.json) declares the OpenClaw service template, health check, open access, and trusted-agent scratch requirements without Kubernetes vocabulary
- **Web Chat first** — Every instance ships with a built-in Web Chat UI. Users add Telegram, Slack, WhatsApp, or Discord at runtime — no infra changes needed
- **Browser anti-detection** — Chromium with stealth wrapper, WebGL spoofing, CDP injection extension, and realistic fingerprinting (see [details below](#browser-anti-detection))
- **GitOps deployment** — Push this repo → Sylphx syncs generic service records → builds images → pods update through the platform reconciler
- **Fully automated CI/CD** — Sylphx BuildKit pipeline builds and publishes content-addressed images
- **Self-contained** — Each instance gets durable `/data` on its own PVC and scratch `/tmp` on pod-local ephemeral storage
- **Trusted agent gateway** — OpenClaw runs with a deployment-generated gateway token, device auth and sandbox friction disabled, while Sylphx owns the low-level runtime projection

## How It Works

1. `sylphx.json` declares the customer app runtime contract: one `openclaw` service template, port, health path, open protection, and trusted-agent scratch intent
2. Sylphx platform syncs that generic declaration into service records and translates runtime intent into pods, services, routes, and scratch volumes without OpenClaw-specific knowledge
3. `Dockerfile.base` builds a pinned OpenClaw release with the runtime tools each instance needs
4. On first boot, the entrypoint bootstraps `openclaw.json`, narrow workspace files, and persistent state under `/data`
5. On every boot, `scripts/config-lock.json` re-applies safety-critical OpenClaw defaults without clobbering user-owned runtime config
6. Users interact via the Web Chat UI or connect their own channels

## Repository Structure

```
agents.yaml                  # Instance definitions (IDs, regions, config)
sylphx.json                  # Customer app runtime contract consumed by Sylphx platform
scripts/
  chromium-stealth.sh          # Stealth Chromium wrapper with anti-detection flags
  chromium-stealth-ext/        # Chrome extension for CDP injection + fingerprint spoofing
  config-lock.json             # Locked OpenClaw runtime defaults
  entrypoint.sh               # Container entrypoint (persistence, bootstrap, services)
Dockerfile.base               # Base image: Node 22 + Chromium + fonts + system deps
workspace/
  agents-base-section.md       # OpenClaw customer runtime conventions
  MEMORY.md                    # Stub for agent long-term memory
MEMORY.md                      # Customer app memory
```

Runtime decisions for this customer app are recorded under [`docs/decisions/`](docs/decisions/). Start with [`openclaw-customer-runtime-contract.md`](docs/decisions/openclaw-customer-runtime-contract.md) for the FD and `/tmp` stabilization model.

## Current Instances

| Instance | Subdomain | Owner |
|---|---|---|
| `sylphx` | sylphx.claw.sylphx.com | Main instance |
| `stanley2` | Stanley2 Sylphx environment | Stanley2 |
| `ozyrix` | ozyrix.claw.sylphx.com | Cheryl |
| `wcloingod` | wcloingod.claw.sylphx.com | Wcloingod |
| `tsefamily` | tsefamily.claw.sylphx.com | Tse Family |
| `epiow` | epiow.claw.sylphx.com | Epiow |
| `epiow2` | Epiow2 Sylphx environment | Epiow |
| `epiow3` | Epiow3 Sylphx environment | Epiow |
| `epiow4` | Epiow4 Sylphx environment | Epiow |
| `cubeage` | cubeage.claw.sylphx.com | Cubeage |

## Adding a New Instance

### 1. Define the instance

Add an entry to `agents.yaml`:

```yaml
instances:
  newuser:
```

### 2. Review runtime defaults

Confirm the shared defaults in `scripts/config-lock.json` are correct for the new instance. Do not fork OpenClaw config unless the instance has a real owner-specific requirement.

### 3. Create the Sylphx environment

Create the new Sylphx project environment from the existing `openclaw` service template. The concrete backend name, domain, PVC, and route belong to platform state, not this repo. Do not add per-customer service names to `sylphx.json`.

### 4. Set secrets

Add the instance credentials through the Sylphx project environment secret flow. Do not patch cluster Secrets manually; the customer app repository is the source of truth for runtime shape, and Sylphx environment secrets are the source of truth for secret values.

### 5. Deploy

```bash
git add -A && git commit -m "feat: add newuser instance" && git push origin main
```

Sylphx Platform CD picks up the push, builds the image, and rolls the matching environments automatically. Cloudflare wildcard DNS (`*.claw.sylphx.com`) routes to the new subdomain — no DNS changes needed.

### 6. Share access

Send the user:
- **Web Chat URL:** `https://newuser.claw.sylphx.com`
- **Gateway Token:** (the one you set in step 4)

Users can then add Telegram, Slack, WhatsApp, or Discord channels themselves at runtime through the OpenClaw UI.

## Configuration

### `agents.yaml`

```yaml
defaults:
  region: lhr
  node_options: "--max-old-space-size=4096 --dns-result-order=ipv4first"
  workspace: "/workspace"

deploy:
  domain: claw.sylphx.com

instances:
  sylphx:
  ozyrix:
  wcloingod:
  tsefamily:
  epiow:
  epiow2:
  epiow3:
  epiow4:
  cubeage:
```

Each instance inherits defaults. Override per-instance only when different.

### Runtime Contract

`sylphx.json` is the customer app contract consumed by Sylphx platform. It declares the product service template (`openclaw`) and product runtime intent. Concrete instance names such as `openclaw-epiow`, PVC names, namespaces, routes, and backend refs are platform-owned state.

### Secrets & Config Templating

Secrets are **never** stored in the repo. Sylphx project environment secrets hold credentials. The entrypoint substitutes `${VAR_NAME}` placeholders with environment variables injected at runtime.

Config is only bootstrapped on **first boot**. Subsequent deploys preserve runtime config, while `scripts/config-lock.json` re-applies platform-owned defaults such as bounded concurrency, disabled hot-watchers, diagnostics, and removed legacy keys. The lock uses JSON merge-patch-style semantics: object fields merge recursively, arrays and scalars replace, and `null` deletes a locked path.

---

<details>
<summary><h2>Browser Anti-Detection</h2></summary>

Every instance includes a hardened Chromium setup that passes major bot detection tests.

### Stealth Wrapper (`chromium-stealth.sh`)

Launches Chromium with anti-detection flags:
- Removes `navigator.webdriver` flag
- Disables automation infobars and Google telemetry
- Enables WebGL via SwiftShader (software rendering that still provides WebGL contexts)
- Sets realistic window size (1920x1080)
- Container-friendly settings (no-sandbox, dev-shm workaround)

### CDP Injection Extension (`chromium-stealth-ext/`)

A Chrome extension that runs at `document_start` on all pages:

| Override | What it does |
|---|---|
| `navigator.deviceMemory` | Reports 8 GB (headless default is 0 or 4) |
| `chrome.runtime` | Stubs with native-looking `toString()` methods |
| WebGL renderer/vendor | Spoofs to Intel UHD Graphics 630 (instead of SwiftShader) |
| `navigator.plugins` | Injects Chrome PDF Plugin (headless has empty array) |
| Permissions API | Returns `prompt` for notifications (headless returns `denied`) |

### How It Runs

Chromium runs in **headed mode** inside Xvfb (virtual framebuffer) at 1920x1080x24bit. This avoids the many detection vectors that differentiate headless from headed Chrome.

</details>

---

<details>
<summary><h2>Runtime Details</h2></summary>

### Cluster

- **Platform:** CAPI Talos Linux v1.12.4 + Kubernetes v1.35.0
- **Nodes:** 2 (control-plane + worker), Hetzner Dedicated (AX162-R series)
- **CNI:** Cilium with Gateway API (HTTPS ingress, LB-IPAM)
- **Storage:** Rook-Ceph block storage (RBD PVCs)
- **Registry:** `registry.sylphx.com`
- **Platform CD:** BuildKit jobs + platform reconciler for customer apps
- **Infra GitOps:** ArgoCD App-of-Apps pattern for platform infrastructure
- **DNS:** Cloudflare → `162.55.233.221` (all zones)
- **TLS:** cert-manager with Let's Encrypt, wildcard certs

### Base Image (`Dockerfile.base`)

Multi-stage build:
1. **Builder stage** — Clones OpenClaw source, builds with pnpm, prunes dev deps
2. **Runtime stage** — Debian Bookworm slim with:
   - Chromium + all rendering dependencies
   - 15+ font families (realistic browser fingerprint)
   - Docker-in-Docker (nested dockerd)
   - Python 3 + pip + venv
   - 1Password CLI (optional with `INSTALL_1PASSWORD_CLI=true`)
   - ClawHub CLI (skill marketplace)
   - Xvfb, dbus
3. **Workspace template generation** — Extracts OpenClaw's default templates from
   `docs/reference/templates/`, strips YAML frontmatter, appends customer runtime BASE section
   to AGENTS.md, and copies extra files (MEMORY.md).

Manual base-image overrides are tagged `{OPENCLAW_VERSION}-deps-{DEPS_VERSION}`. Current pinned release: `v2026.6.9`; current dependency generation: `v13`. Audited source patches under `patches/openclaw/`, if present, are applied immediately after cloning the upstream tag and before dependency installation.

### Workspace Template Architecture

We do **not** maintain copies of OpenClaw's default workspace templates in this repo. Instead, they are extracted from OpenClaw's source tree at Docker build time, ensuring templates stay in sync with the installed version.

**3-layer architecture:**

| Layer | Owner | Files | Updated |
|-------|-------|-------|---------|
| 1. OpenClaw | Upstream | AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md | On OpenClaw upgrade (image rebuild) |
| 2. Customer app | This repo | BASE section in AGENTS.md (bun, mcporter, config safety) | Every boot (marker refresh) |
| 3. Instance | Agent | IDENTITY.md, USER.md, memory files, cron, channels | Never overwritten |

### Container Entrypoint (`entrypoint.sh`)

16 clean sections, executed on every boot:

| # | Section | Runs |
|---|---------|------|
| 1 | Create persistent tenant home `/data/<tenant>/home` | First boot |
| 2 | Bootstrap `/data/openclaw.json` and mirror OpenClaw's default state config path | First boot and after safe config changes |
| 2b | Generate or load persistent gateway token | Every boot |
| 3 | Bootstrap workspace + refresh BASE markers | Every boot |
| 4 | Install auth-profiles.json into `$HOME/.openclaw/agents/main/agent` from baked file, provider env keys, or legacy migration | Every boot |
| 5 | Fix volume ownership | Every boot |
| 6 | Symlink `/home/node` to persistent home | Every boot |
| 7 | Overlay `/usr/local` — persist manually installed binaries | Every boot |
| 8 | Persist apt cache — symlink to `/data/cache/apt` | Every boot |
| 9 | Restore packages from captured state (apt diff + pip) | Every boot |
| 10 | Environment setup — XDG vars, package manager homes, PATH | Every boot |
| 10.5 | Configure mcporter + Tavily MCP | First boot |
| 11 | Start dbus + set timezone | Every boot |
| 12 | Start Xvfb virtual display | If enabled |
| 13 | Start Docker daemon | If available |
| 14 | Config safety net v3 (auto-rollback on crash) | Every boot |
| 15 | Launch OpenClaw + watchdog | Every boot |

### Persistence Model

6-layer architecture — agents never need to think about persistence:

| Layer | What | How |
|-------|------|-----|
| **HOME on /data** | Auth, dotfiles, caches, browser state, tool state | `/data/<tenant>/home` = persistent HOME outside the watched workspace |
| **Narrow workspace** | Agent-visible project and memory tree | `/workspace` -> `/data/<tenant>/home/.openclaw/workspace` |
| **XDG env vars** | All well-behaved tool state | `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, etc. |
| **Package manager redirect** | npm/bun/pip/go/cargo globals | `BUN_INSTALL`, `npm_config_prefix`, `PIP_USER=1`, etc. |
| **Overlay `/usr/local`** | Manually installed binaries (gh, cloudflared) | overlayfs with upper on `/data/overlay/` |
| **Package state capture** | apt/pip packages | `capture-package-state.sh` diffs against base image |
| **Apt cache** | Downloaded .deb files | Symlink to `/data/cache/apt` for fast reinstall |

Key paths on the persistent volume (Ceph RBD PVC):
- `/data/<tenant>/home` — User home, auth, dotfiles, caches, browser state, tool configs, and other runtime state outside the watched workspace
- `/data/<tenant>/home/.openclaw/workspace` — Agent-visible workspace, memory, identity, and project files. `/workspace` symlinks here on every boot.
- `/data/home` — Legacy fallback only when `INSTANCE_NAME` is not set
- `/data/openclaw.json` — Runtime config SSOT, exported through `OPENCLAW_CONFIG_PATH` and never overwritten by deploys
- `/data/<tenant>/home/.openclaw/openclaw.json` — Compatibility mirror for OpenClaw CLI defaults; entrypoint promotes `/data/openclaw.json` back to this path and normalizes legacy workspace paths to `/workspace`
- `/data/<tenant>/home/.openclaw/agents/main/agent/auth-profiles.json` — OpenClaw provider auth store, generated from `SYLPHX_AI_API_KEY`, `DIRECT_ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, and `OPENAI_API_KEY` when no baked file exists. `ANTHROPIC_API_KEY` is a compatibility alias only.
- `/data/overlay/usr-local/` — Overlay upper layer for /usr/local
- `/data/cache/apt/` — Cached .deb packages for fast restore
- `/data/package-state/` — Captured apt/pip package lists
- `/data/.docker-root` — Docker daemon storage when loop-ext4 mounting succeeds
- `/data/docker` — Docker daemon fallback storage

New image deploys automatically clear the `/usr/local` overlay and re-apply package state.

</details>

---

<details>
<summary><h2>CI/CD & Deployment</h2></summary>

### GitOps Flow

Deployments are driven by this customer app repo and reconciled by Sylphx platform:

1. **App change**: Edit `sylphx.json`, `Dockerfile.base`, `scripts/config-lock.json`, or entrypoint/runtime files
2. **Webhook sync**: Sylphx platform reads `sylphx.json` and updates generic service records
3. **Build**: Sylphx BuildKit K8s job builds and publishes the customer app image
4. **Reconcile**: Platform emits Kubernetes resources from generic service records
5. **Runtime boot**: Entry point preserves `/data/openclaw.json` and reapplies the platform config lock, including locked deletions for legacy paths

No SSH, no `docker compose`, no manual `kubectl apply`.

### Image Build Pipeline

```
Developer pushes to GitHub
  → GitHub App webhook → Sylphx Platform API
    → Sylphx BuildKit job
      → build and publish content-addressed image
        → platform reconciler rolls the service
```

### Build Base Image

Base image changes (`Dockerfile.base`, stealth scripts, entrypoint) trigger a rebuild:
- Built by the platform BuildKit pipeline in the cluster
- Published to `registry.sylphx.com` with the OpenClaw version and dependency version in the tag

</details>

---

## Operations

```bash
# Check pod status
kubectl get pod -A -l sylphx-service=openclaw

# View container logs
kubectl -n <env-namespace> logs deploy/openclaw --tail 100

# Check the concrete image currently deployed
kubectl -n <env-namespace> get deploy openclaw -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

## Disaster Recovery

Recovery is handled through Sylphx Platform CD + Ceph:

1. **Pod crash**: K8s auto-restarts. Data persists on Ceph PVC.
2. **Node failure**: Pod rescheduled to another node. Ceph PVC reattaches.
3. **Cluster rebuild**: Platform reconciles customer apps back from project/environment state. Ceph data survives if OSDs intact.
4. **Full disaster**: Restore from platform database backups and PVC snapshots, then redeploy through Sylphx Platform CD.

All secrets are stored in 1Password (vault: Sylphx, tag: `openclaw`).

## License

Private repository. All rights reserved.
