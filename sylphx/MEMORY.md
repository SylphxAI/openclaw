# OpenClaw Deploy — Memory

## Architecture

### CAPI Cluster

**Cluster**: Talos Linux v1.12.4 + K8s v1.35.2. Six active nodes (3 CP + 3 worker). Immutable OS — no SSH, API-only config. VIP HA for CP failover.

- **Kubeconfig**: `~/.kube/capi-cluster` (API: `https://91.98.183.14:6443` — node4 public IP)
- **Internal cluster endpoint**: `https://10.10.0.240:6443` (Talos VIP, auto-failover between CPs)
- **Nodes**:

| Hostname | IP | Role | Server ID | Notes |
|----------|-----|------|-----------|-------|
| talos-2a014f82713b491 | 10.10.0.1 | CP | 2920324 (node1) | Legacy hostname, functional |
| compute-fsn1-2927556 | 10.10.0.2 | CP | 2927556 (node2) | Reprovisioned v3.1.0 |
| talos-10-10-0-4 | 10.10.0.4 | CP | 2932787 (node4) | Legacy hostname, functional |
| compute-fsn1-2938104 | 10.10.0.6 | Worker | 2938104 (node6) | MachineDeployment |
| compute-fsn1-2957069 | 10.10.0.7 | Worker | 2957069 (node7) | MachineDeployment |
| compute-fsn1-2958377 | 10.10.0.8 | Worker | 2958377 (node8) | MachineDeployment |

- **VIP**: `10.10.0.240` — Talos VIP for CP HA. Auto-failover < 5s.
- **IP Allocation**: Hosts 1-199, Reserved 200-239, VIPs 240-254
- **Gateway IP**: 91.98.183.14 (Cilium LB-IPAM)
- **DNS**: ALL 6 zones → 91.98.183.14 (83 Cloudflare A records)
- **CNI**: Cilium with Gateway API — per-domain HTTPS listeners, SNI-based TLS. `vlan-bpf-bypass=0` required (Broadcom NICs create >5 VLAN sub-interfaces, exceeding Cilium's macro limit).
- **TLS**: `*.claw.sylphx.com` + `*.sylphx.com` + `*.sylphx.app` SANs on `gateway-wildcard-tls` cert
- **Namespace PSS**: `pod-security.kubernetes.io/enforce: privileged` (required for DinD — openclaw + spiron namespaces)

**Core Services:**

| Service | Namespace | Details |
|---------|-----------|---------|
| **ArgoCD** | argocd | 55 apps, App-of-Apps pattern, `SylphxAI/platform` repo |
| **Registry** | registry | Zot v2.1.15 on Ceph RBD, `registry.sylphx.com`, htpasswd auth, ArgoCD-managed |
| **Ceph** | N/A (storage) | Hybrid cephadm+Rook. 3 MON, 4 MGR, 15 OSD (105 TiB), 2+ MDS, 4 RGW. Image: `quay.io/ceph/ceph:v19.2.3` |
| **CNPG** | cnpg-system | PostgreSQL operator — `sylphx-pg` (2 instances: pg-2, pg-3), 30 databases |
| **MySQL** | cubeage-mysql | Standalone mode (post-Percona CLONE disaster). Pod `mysql-standalone`, 14 databases. Backup CronJob 02:30 UTC. |
| **Redis** | redis | K8s deployment, ACL-based multi-tenant |
| **Monitoring** | monitoring | VictoriaMetrics (metrics), Grafana (dashboards), Loki (logs), Alloy (log collector) |
| **CI Runners** | ci-runners | Webhook-driven JIT. GitHub App ID 1299545. Ephemeral Kata CLH VMs. Labels: `[self-hosted, sylphx, linux, standard/large/xlarge]`. Ghost sweep every 30 min. |
| **Spiron** | spiron | 5 DinD instances (epiow, hypoidea, stanley, test, vanessa) — privileged, 4Gi memory |

### Storage Architecture

**Hybrid cephadm+Rook**: cephadm manages MON/MGR/MDS/RGW on dedicated storage nodes. Rook manages OSDs on K8s storage node + CSI on compute for volume mounts.

| Hostname | VLAN IP | Server ID | Role |
|----------|---------|-----------|------|
| storage-1 | 10.10.0.32 | 2960977 (node9) | cephadm (MON/MGR/MDS/RGW) |
| storage-2 | 10.10.0.30 | 2932729 (node3) | cephadm (MON/MGR/MDS/RGW) |
| storage-3 | 10.10.0.31 | 2933228 (node5) | cephadm (MON/MGR/MDS/RGW) |
| storage-4 | 10.10.0.33 | — | cephadm (4 OSDs) |
| storage-5 | 10.10.0.35 | — | cephadm (4 OSDs) |
| storage-6 | 10.10.0.36 | — | cephadm (4 OSDs) |
| storage-fsn1-2964886 | 10.10.0.37 | — | Rook (3 NVMe OSDs) |

- **Rook**: Upstream `v1.19.3`. ArgoCD auto-sync DISABLED for operator.
- **cephadm module**: ENABLED on storage nodes.
- **CSI RBD toleration**: `CSI_PLUGIN_TOLERATIONS` and `CSI_PROVISIONER_TOLERATIONS` for CP taint required in `rook-ceph-operator-config`.
- **PVCs**: Ceph RBD (sylphx: 256Gi, others: 50Gi each)

### Workspace Architecture

**The correct agent workspace is `/workspace`**, a stable symlink to `$HOME/.openclaw/workspace`.

- **Config**: `agents.defaults.workspace: "/workspace"` — keeps OpenClaw watchers scoped to a narrow managed workspace instead of the full persistent home tree.
- **Persistent backing path**: `/data/{instance}/home/.openclaw/workspace` after DooD host-visible path unification.
- **`/workspace` symlink**: recreated on every boot after `INSTANCE_NAME` path rewriting; the target directory must exist before the symlink is installed.
- **Durable home**: `$HOME=/data/{instance}/home` stores caches, credentials, browser state, Docker state, diagnostics, and runtime data that should not be watched as the agent workspace.
- **Legacy migration**: entrypoint copies known bootstrap files and links customer-visible top-level project directories from the old broad home into the narrow workspace when missing.
- **File locations**: `/workspace/MEMORY.md`, `/workspace/IDENTITY.md`, `/workspace/memory/*.md`, `/workspace/SOUL.md`, `/workspace/USER.md`, `/workspace/AGENTS.md`, `/workspace/TOOLS.md`, `/workspace/HEARTBEAT.md`, `$HOME/.openclaw/workspace-state.json`.

### Common Config

- **DinD**: Each pod runs nested `dockerd`. Entrypoint.sh section 13 starts dockerd at `/data/docker` when no host socket. `privileged: true` on pods.
- **Base image**: `registry.sylphx.com/library/openclaw-deploy-base:v2026.2.26-deps-v9` — Chromium 144, stealth MV3 extension, Xvfb, 381 fonts, 1password-cli, mcporter, nested dockerd, passwordless sudo for node user.
- **OpenClaw image**: `ghcr.io/sylphxai/openclaw:{sha}` (CI-built, tagged per git SHA + `:latest`)
- **OpenClaw source patches**: `Dockerfile.base` clones the pinned upstream tag, then applies audited patches from `patches/openclaw/` before dependency install/build. Remove a patch only after the same fix is present in the next pinned upstream release.

## Build Pipeline — Build Once, Deploy Seven

- **Architecture**: External CI (GitHub Actions on JIT runners) builds ONE image, Platform API + Reconciler deploys to 7 environments.
- **Runner**: BuildKit daemon mode with virtiofs `--xattr` annotation (`io.katacontainers.config.hypervisor.virtio_fs_extra_args`). Labels: `[self-hosted, sylphx, linux, xlarge]` for builds (Kata CLH VM + DinD sidecar).
- **Kata VM memory**: Hotplug works (verified, ~1s async). VMs get request + limit + 2Gi default overhead.
- **Registry**: GHCR (`ghcr.io/sylphxai/openclaw:{sha}` + `:latest`)
- **Platform API**: `POST /v1/projects/{PROJECT_ID}/deploy` with `{ envId, image }` — sets `desiredImage` + bumps `generation` + fires `triggerReconcile()`. URL is `/v1/...` NOT `/api/v1/...`.
- **Canary strategy**: Test env first → wait 60s → verify pod Running → remaining 6 in parallel (max 3).
- **Change detection**: Separate code-change (triggers build) vs config-change (triggers config update) paths.
- **`source_kind='image'`**: All 7 `project_services` rows — Platform webhook handler skips Kaniko builds.
- **CI API token**: `slx_cli_*` service token (token_type `cli` not `service`) scoped to openclaw project, stored as `PLATFORM_TOKEN` GitHub secret.
- **Workflow**: `.github/workflows/deploy.yml` — "OpenClaw CI/CD"
- **Docker Hub mirror**: ClusterIP `10.111.119.128` (NOT a DNS name)

## Instances

| Instance   | Subdomain                      | Telegram Bot          |
|------------|--------------------------------|-----------------------|
| sylphx     | sylphx.claw.sylphx.com        | @kylehelperbot        |
| ozyrix     | ozyrix.claw.sylphx.com        | @Cherylkarenbot       |
| wcloingod  | wcloingod.claw.sylphx.com     | @miyuki_wing_ai_bot   |
| tsefamily  | tsefamily.claw.sylphx.com     | @sagetsebot           |
| epiow      | epiow.claw.sylphx.com        | @epiowaibot           |
| cubeage    | cubeage.claw.sylphx.com       | @cubeagebot           |

## Deployment — Platform-Managed

- **Platform SSOT**: Project `openclaw` (org: `sylphx`, project_id: `d736cdd8-a99f-46c9-b27b-39d7ef9c6371`).
- **Data model**: 1 project → 7 environments (one per customer instance) → 1 service per environment.
- **7 Environments** (all `env_type: production`, `reconcilerManaged: true`, `auto_deploy: true`):

| Environment | Service | Env ID | K8s Deployment |
|-------------|---------|--------|----------------|
| Sylphx | openclaw-sylphx | `00ffebf8` | `openclaw-sylphx` |
| Ozyrix | openclaw-ozyrix | `3b6902aa` | `openclaw-ozyrix` |
| Cubeage | openclaw-cubeage | `ea436161` | `openclaw-cubeage` |
| Epiow | openclaw-epiow | `ad5dddc0` | `openclaw-epiow` |
| Wcloingod | openclaw-wcloingod | `4bf43408` | `openclaw-wcloingod` |
| Tsefamily | openclaw-tsefamily | `fa0d9672` | `openclaw-tsefamily` |
| Test | openclaw-test | `d97e23d6` | `openclaw-test` |

- **`reconcilerManaged: true`** = full SSA mode. Reconciler generates complete K8s Deployment/Service/Secret specs from Platform DB.
- **`deploy_app_id: openclaw`** = K8s namespace.
- **NOT in ArgoCD**: OpenClaw is a customer app — Platform is the single source of truth.
- **Config management**: `agents.yaml` → `python3 scripts/generate.py` → `instances/{id}/openclaw.json` → `scripts/migrate-to-managed.js` encrypts into `service_config_files` → reconciler mounts at `/data/openclaw.json` via K8s Secret subPath.
- **Health checks**: TCP socket probes (startup 10min, liveness 30s, readiness 10s) — generated by Platform.
- **Deployment strategy**: Recreate (auto-detected from RWO volume binding).
- **Runtime**: Kata (Cloud Hypervisor VM isolation) with `privileged: true` for DinD. Entrypoint.sh auto-detects virtiofs and uses `vfs` Docker storage driver.
- **Resources**: 8Gi/8Gi memory (requests=limits, required for Kata CLH pre-allocation), 500m/2000m CPU.
- **Volumes**: PVC `openclaw-{instance}-data` at `/data` plus pod-local emptyDir `/tmp` from `runtime.scratch` (`medium: "disk"`). Config file overlay at `/data/openclaw.json` from Secret.
- **Data mount watchdog**: entrypoint exits the gateway if `/data` is no longer mounted or `$HOME` becomes unavailable. A Ready pod with a missing `/data` mount causes session persistence failures and apparent memory loss; Kubernetes should replace it.
- **DNS order**: Node runs with `--dns-result-order=ipv4first`, and OpenClaw Telegram config locks `channels.telegram.network.dnsResultOrder: "ipv4first"`. The cluster does not provide reliable IPv6 egress to all SaaS APIs; Telegram `api.telegram.org` publishes AAAA records, and IPv6-first attempts can add 10s bot API timeouts before fallback.
- **Internal hooks**: Managed OpenClaw deploys lock `hooks.internal.enabled: false`. The upstream placeholder `BOOT.md` exists in workspaces but should not run an agent boot check on every gateway restart unless the customer intentionally installs a real hook.

## Backup

- **PostgreSQL**: CNPG ScheduledBackup — daily base backup 02:00 UTC to Ceph S3 (`s3://cnpg-backups/sylphx-pg`). WAL archiving active. 14-day retention. RPO ~5 min.
- **MySQL**: CronJob — daily `mysqldump --all-databases` 02:30 UTC, gzip to 50Gi PVC. 7-day retention.
- **Legacy**: restic to Backblaze B2, OpenClaw-specific backup to Hetzner Storage Box via SFTP (port 23).

## Sylphx AI Provider Proxy

- **Repo**: `SylphxAI/sylphx-ai`
- **Purpose**: OpenAI-compatible provider proxy and auto-router for managed OpenClaw instances.
- **Canonical provider URL**: `https://api.sylphx.ai/v1`
- **K8s service**: Platform-managed customer app in namespace `sylphx-ai-prod`, service `web` on port `3000`.
- **Public routing invariant**: `api.sylphx.ai` must be present on the `sylphx-ai-prod/web` HTTPRoute and Gateway listener. If it is missing, OpenClaw model calls fail with Cloudflare `404` even when pods, auth profiles, and tokens are healthy.
- **Legacy OAT proxy is retired for OpenClaw deploys**: do not point OpenClaw at `sylphx-oat-proxy-prod`, `oat-proxy.openclaw.svc.cluster.local`, or port `8787`.
- **Credential plane**: OpenClaw auth profiles use per-instance Sylphx AI client keys (`ik-*`) for `sylphx:default`. These are not Sylphx Platform runtime SDK keys (`sk_*`).
- **Config source of truth**: provider URL lives in `agents.yaml` and `scripts/config-lock.json` under `models.providers.sylphx.baseUrl`. Do not diagnose runtime provider routing from `ANTHROPIC_BASE_URL`; that env var is bootstrap compatibility only.
- **Provider idle timeout**: managed OpenClaw instances set `models.providers.sylphx.timeoutSeconds: 600` and `models.providers.anthropic.timeoutSeconds: 600`. Without this provider-scoped timeout, OpenClaw's default cloud-provider idle watchdog can abort `sylphx/executor` after roughly 120 seconds with "The model did not produce a response before the model idle timeout" even when Telegram delivery and `/v1/models` are healthy.

### Key Features

- **Executor model routing**: `sylphx/executor` resolves to an available upstream model through Sylphx AI.
- **Per-instance metering**: client key identity maps usage back to the OpenClaw instance, for example `epiow`.
- **Provider failover**: upstream provider/token selection happens inside Sylphx AI, not inside OpenClaw deploy scripts.
- **Per-client cascade invariant**: managed OpenClaw clients must have explicit Sylphx AI cascades. A null client cascade falls back to the global default, which can select provider-policy-blocked OpenRouter offerings and surface as no-response/model cooldown.
- **OpenAI-compatible API**: Managed Sylphx AI provider entries use `api: openai-responses` against `/v1/responses` so streaming usage, response events, and Gateway-native transport stay on the canonical path. Direct ZAI entries remain `openai-completions` because ZAI's public OpenAI-compatible endpoint is chat-completions compatible.

### Auth Flow

1. OpenClaw gateway selects model `sylphx/executor`.
2. Gateway reads token from `/data/<instance>/home/.openclaw/agents/main/agent/auth-profiles.json`, profile `sylphx:default`.
3. Gateway calls `https://api.sylphx.ai/v1/responses` with the `ik-*` token.
4. Sylphx AI maps the client key to an instance such as `epiow`, selects an upstream provider/token, and streams the response back.

### Provider Architecture

- `sylphx/executor` — primary for managed OpenClaw agents, routes to Sylphx AI.
- `sylphx/claude-sonnet-4-6` — explicit Sylphx AI route.
- `anthropic/claude-sonnet-4-6` — compatibility alias that still routes to Sylphx AI in managed deploys.
- `zai/glm-5` and `zai/glm-5-turbo` — direct provider entries kept available but not the default route.

### Secrets

Per-instance keys should be injected through the platform-managed app secret `SYLPHX_AI_API_KEY`, then materialized into `auth-profiles.json`. `ANTHROPIC_API_KEY` remains a bootstrap compatibility alias only for non-`sk-ant-` keys. Treat the auth profile as runtime truth; do not print raw keys in logs or docs.

## Required Secrets

### GitHub Actions (SylphxAI/openclaw-deploy repo)

- `KUBECONFIG` — CAPI cluster kubeconfig
- `GHCR_TOKEN` — GitHub Container Registry push token
- `PLATFORM_TOKEN` — `slx_cli_*` service token for Platform deploy API
- `HETZNER_SSH_KEY` — SSH private key for CAPHR

### Cloudflare DNS

- ALL 6 zones (sylphx.com, sylphx.app, cubeage.com, cubeace.com, gflask.com, epiow.com) → A → 91.98.183.14
- `*.claw.sylphx.com` → A → 91.98.183.14 (Proxied)
- SSL/TLS mode: Full (Strict)

### Registry Push Credentials

- `registry.sylphx.com` uses Zot with htpasswd auth
- Credentials managed via GitOps (`infra/addons/ci-runners/manifests/registry-push-auth.yaml`)
- DO NOT set passwords manually — Git is the single source of truth

## Stealth Browser

- **Chromium**: v144.0.7559.109 (Debian Bookworm)
- **Stealth wrapper**: `/usr/local/bin/chromium-stealth` — anti-detection flags
- **Stealth extension**: MV3, `world: "MAIN"` — spoofs WebGL (Intel UHD 630), device memory (8GB)
- **Xvfb**: Display :99 at 1920x1080 — headed mode in headless container
- **Config**: `browser.executablePath: "/usr/local/bin/chromium-stealth"`, `headless: false`, `noSandbox: true`

## Database Architecture

### PostgreSQL: CNPG `sylphx-pg` (2 instances: pg-2, pg-3)

- **Service**: `sylphx-pg-rw.cnpg-system.svc.cluster.local`
- **Admin user**: `sylphx` (superuser) — management only
- **Isolation**: `REVOKE CONNECT ON DATABASE ... FROM PUBLIC` + per-app `GRANT CONNECT`
- **Connection limits**: All app users `CONNECTION LIMIT 20`

| App User | Database(s) | App(s) |
|----------|-------------|--------|
| funbig2_tw_app | funbig2_tw | fun-big2-tw |
| funbigtwo_app | funbigtwo | fun-big2-hk |
| funshowhand_app | funshowhand | fun-showhand |
| mahjong_app | mahjong | fun-mahjong |
| texaspoker_app | texaspoker | fun-texas-holdem |
| trivia_app | sylphx_trivia, trivia_staging | trivia |
| puzzled_app | sylphx_puzzled, puzzled_staging | puzzled |
| epiow_app | epiow, epiow_staging | epiow |
| viral_app | viral, viral_staging | viral |
| sylphx_platform_app | sylphx_prod | sylphx-platform |
| bgca | bgca | bgca-web |
| cs_user | cs_crm, cs_crm_staging | cubeage-cs-agent |

### MySQL: `cubeage-mysql` namespace

- 500Gi Ceph RBD, MySQL 8.0, 14 databases
- Service: `cubeage-mysql.cubeage-mysql.svc.cluster.local`

### Redis (K8s deployment, `redis` namespace)

- ACL-based multi-tenant. Credentials managed via GitOps — see `/data/users.acl`.
- ACL users: `admin` (+@all), `epiow`, `puzzled`, `platform` (all `+@all -@admin -@dangerous +info`)
- Apps NOT using Redis: trivia, tryit/viral — env vars prefixed `# DISABLED_PHASE0:`

### Separate Databases (not yet consolidated)

- Plausible Analytics: postgres:16-alpine
- GlitchTip: postgres:16-alpine + redis:8-alpine
- Trigger.dev: postgres:14 + redis:7-alpine
- Cubeage Platform: redis:6

## CAPHR (Cluster API Provider Hetzner Robot)

**Deployed version**: v3.1.0 (`registry.sylphx.com/library/caphr:v3.1.0`)
**Repo**: `SylphxAI/cluster-api-provider-hetzner-robot` (local: `/Users/kyle/caphr`)

**Features (v3.1.0)**:
- Hostname: `compute-<dc>-<serverID>` (DC from HetznerRobotCluster.Spec.DC, defaults to fsn1)
- NIC: deviceSelector by MAC (auto-detected from rescue SSH)
- IPv6: dual-stack kubelet nodeIP
- EFI: post-install efibootmgr fix (PXE first)
- Cilium: startup taint (`node.cilium.io/agent-not-ready`)
- Max 8 hw reset retries then StateError
- serviceAccount.key injection from Talos secret bundle
- CRD: primaryMAC + dc fields

**MachineHealthChecks (live)**:
- `cp-health-check`: 3 CP nodes, `maxUnhealthy: 34%`, retryLimit: 2, timeout: 300s
- `worker-health-check`: workers, `maxUnhealthy: 1`, retryLimit: 3, timeout: 180s

**CAPI Controllers**:
- CAPHR: 1 replica (v3.1.0)
- CACPPT: 0 replicas (paused — no spare hosts for TCP rolling update)
- CABPT: 1 replica
- CAPI: 1 replica

**Decision**: NOT reprovisioning node1/node4 CPs — risk > benefit. They have all critical features (dual-stack, Cilium taint, provider-id). Only cosmetic differences (hostname, NIC naming).

## Sylphx Platform (SaaS Console)

- **Repo**: `SylphxAI/platform` — local clone at `/Users/kyle/SaaS/`
- **Platform DB**: `sylphx_prod` on `sylphx-pg` (via `sylphx_platform_app` user)
- **Unique constraint**: `app_environments` unique on `(app_id, name)`, NOT `(app_id, env_type)`

### Sylphx Controller (Event-Driven Reconciliation)

- 2 replicas (1 leader + 1 standby), `sylphx-controller` in `sylphx-platform` namespace
- **PG LISTEN/NOTIFY** for event-driven reconciliation
- **PG advisory lock** for leader election (key `957291438`)
- **K8s Watch** drift detection on `managed-by=sylphx-platform` resources
- **Fallback timers**: 30s reconcile, 60s gateway reconcile
- **Direct PG connection required**: Advisory locks are session-scoped — PgBouncer breaks them. Uses `DATABASE_URL_DIRECT`.
- **Drizzle ORM `db.query` banned**: Breaks when bundled by `bun build`. Use `db.select().from().innerJoin()`.
- **ESM output**: `controller/package.json` has `"type":"module"`, `server-only` shimmed.

## CI Runner System

- **Architecture**: Webhook-driven JIT (no ARC). `workflow_job.queued` → Platform spawns ephemeral K8s Job → runner picks up ONE job → exits.
- **Instance types**: standard (2 CPU/4Gi), large (4 CPU/8Gi), xlarge (8 CPU/16Gi)
- **Docker**: Kata VM + DinD sidecar, shared emptyDir for `/var/run/docker.sock`
- **Ghost sweep**: Every 30 min, data-driven from DB
- **Multi-org**: `github_app_installations` DB table, installation webhook handler auto-tracks
- **cancel-in-progress**: false (prevents ghost runner factory)

## Anima (Rust Replacement)

- K8s deployment in `anima` namespace
- PostgreSQL: `sylphx-pg` shared cluster. Databases: anima, anima_epiow, anima_hypoidea
- Data: `/data/anima/home/.anima/`
- Model: `anthropic/claude-sonnet-4-6`

## Decisions

- **Talos Linux**: Immutable OS, API-only, no SSH
- **ArgoCD GitOps**: All infra through Git
- **Cilium Gateway API**: Native K8s ingress, per-domain HTTPS, SNI-based TLS, LB-IPAM
- **CNPG**: PostgreSQL HA with automated failover
- **Hetzner over Fly.io**: 4x resources at 1/3 cost
- **Pre-built base images**: Config deploys <30s (vs 5-6 min cold builds)
- **Cloudflare proxy**: Free DDoS + WAF, Full (Strict) SSL
- **Per-tenant isolated DB clusters** (ADR-006): Dedicated Operator-managed cluster per customer
- **K8s Services as ClusterIP**: No port exposure — eliminates Docker/UFW bypass

## Known Issues

- **Cilium CNI chicken-and-egg**: Cilium on workers can't reach API via service IP. Requires `KUBERNETES_SERVICE_HOST=10.10.0.1` and `KUBERNETES_SERVICE_PORT=6443` on Cilium DaemonSet. Will recur on reinstall.
- **1 ArgoCD app OutOfSync (cnpg-cluster)**: Cosmetic — CNPG webhook mutates spec. App is Healthy with selfHeal.
- **Gateway reconciler**: Certificate upsert "Unknown error" + 422 duplicate listener on `main-gateway` (pre-existing)
- **Secret decryption failures**: bgca-prod and cs-agent environments (encrypted with different key)
- **Epiow + Platform share `ratelimit:*` Redis key namespace**: Apps hardcode prefixes
- **Cubeage Platform redis:6**: Not yet consolidated into shared Redis 8

## v2026.2.21 Breaking Change

`hooks.token` must differ from gateway token. Gateway validates they are distinct.

## 2026-04-03/04 Incident Recovery Progress

### Completed
- ✅ Platform DB (pg-sylphx-platform) — standalone PG pod running, data restored from Mar 26 RBD image
- ✅ Platform Controller — running with image `228bc3f89c5c`, reconciling all envs
- ✅ sylphx.com — 200 OK, web service running
- ✅ Registry — anonymous read enabled (ArgoCD sync paused), S3 backend
- ✅ Docker-cache — migrated to S3 (Ceph RGW), no PVC dependency
- ✅ Build pipeline — webhook verified, BuildKit job ran, image pushed
- ✅ LB NodePorts updated (80→30701, 443→31015)
- ✅ Gateway TLS certs — reconciled by controller
- ✅ Ceph — 12 OSDs, 3 MONs, 3.7 TiB, HEALTH_WARN (1 OSD down)
- ✅ NetworkPolicy fix — `allow-all-egress` workaround in sylphx-platform ns
- ✅ Kyverno — scaled down to unblock Percona operator

### Pending
- ❌ Percona MySQL (db-cubeage-platform) — CRD validation fails on existing cluster SSA patch. Need code fix: existing cluster path must emit full template, not minimal SSA patch. PVC with data exists in `db-cubeage-platform` namespace.
- ❌ CNPG databases — 38 resources provisioning/failed timeout. Most have existing CNPG clusters but reconciler sees them as timed out.
- ❌ Kyverno — scaled down, needs proper exclude for Percona operator SA
- ❌ ArgoCD registry sync — paused, needs anonymous read committed to git
- ❌ cubeage-platform be-web — image tag not found in registry
- ❌ 10.10.0.32 (compute-fsn1-2960977) — cordoned, VLAN connectivity issues from pods

### Key Workarounds Active
1. `allow-all-egress` NetworkPolicy in sylphx-platform (overrides restrictive app-policy)
2. Registry anonymous read (uncommitted, ArgoCD sync paused)
3. Kyverno admission controller scaled to 0
4. Standalone PG pod for platform DB (not CNPG managed)
5. `db-cubeage-platform` cluster_name restored but SSA patch validation fails
