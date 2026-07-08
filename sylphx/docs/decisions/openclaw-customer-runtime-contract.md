# Decision: OpenClaw Customer Runtime Contract

**Date:** 2026-05-06
**Status:** Accepted
**Author:** SylphxAI

## Context

OpenClaw runs as a customer app on Sylphx platform. The platform must stay zero-knowledge about OpenClaw-specific runtime semantics: no hard-coded OpenClaw service names, no application-owned paths, and no incident-specific Kubernetes manifests in the platform repo.

The Epiow OpenClaw instance repeatedly crashed with file-descriptor symptoms. The observed failure set had two classes:

- Node gateway aborts with `EMFILE: too many open files, close`, followed by a native `uv_fs_close` assertion.
- Kata sandbox/runtime churn with `SandboxChanged`, pod IP changes, transient `no route to host`, and restarts during heavy reads from `/tmp/openclaw`.

The steady-state process FD count was low, so the incident is not a simple monotonic FD leak. The likely pressure source is bursty watcher/log/sandbox activity amplified by broad workspace paths, high agent concurrency, Docker-in-Docker, and `/tmp` being mounted from the same persistent PVC as `/data`.

## Decision

OpenClaw declares its runtime requirements in `sylphx.json` and its image/config lock. The app repo declares one `openclaw` service template; Sylphx environments own the concrete instance fan-out such as `openclaw-epiow` and `openclaw-cubeage`.

- Durable state lives under `/data`.
- Scratch state lives under pod-local `/tmp`, declared through the Sylphx PaaS `runtime.scratch` contract.
- `/tmp` uses node-backed emptyDir by default, not `medium: "Memory"`, because OpenClaw runs Chromium, Docker, logs, package managers, and agent tools that can create large temporary files. A tmpfs `/tmp` would move that pressure into the pod memory cgroup.
- OpenClaw pins to `v2026.5.6` or newer so upstream watcher-limit handling is present.
- OpenClaw defaults its agent workspace to `/workspace`, which resolves to `/data/<tenant>/home/.openclaw/workspace`. Memory, identity, and project files remain visible there, while caches, auth state, browser state, Docker state, diagnostics, and runtime data stay under `$HOME` but outside the watched workspace tree.
- The runtime config single source of truth is `/data/openclaw.json`, and the entrypoint exports `OPENCLAW_CONFIG_PATH=/data/openclaw.json` before launching OpenClaw. `$HOME/.openclaw/openclaw.json` is only a compatibility mirror for CLI defaults and must not become an independent config store.
- Platform-owned config lives in `scripts/config-lock.json`. Boot applies it as a JSON merge-patch-style overlay against `/data/openclaw.json`: object fields merge recursively, arrays and scalars replace, and `null` deletes legacy paths such as `tools.deny`.
- Boot-time config migration normalizes legacy workspace values that point at `/data/<tenant>/home` or `$HOME/.openclaw/workspace` back to `/workspace`, so agent-level overrides cannot preserve an old path vocabulary after the default has been corrected.
- Provider auth profiles live in `$HOME/.openclaw/agents/main/agent/auth-profiles.json`, matching the OpenClaw agent auth-store lookup path. The entrypoint installs a baked auth file when present, otherwise synthesizes the profile from platform-injected provider env keys, and finally migrates the previous `/data/agents/main/agent/auth-profiles.json` location so restarts do not lose model credentials.
- Memory and skill hot-watchers are disabled by default. Search remains available on demand.
- Telegram channel capacity defaults are platform-owned. `channels.telegram.mediaMaxMb=100` is locked for every OpenClaw tenant, while tenant-specific Telegram group topology (`groups`, `groupAllowFrom`, topic rules) stays agent-owned runtime config.
- Gateway token auth is generated and persisted by the entrypoint because OpenClaw refuses non-loopback binds without an auth path. The OpenClaw control port is locked to `3000` in both image env (`OPENCLAW_GATEWAY_PORT`) and runtime config (`gateway.port`) so operator CLI commands, gateway RPC clients, and the web service all share the same endpoint instead of falling back to OpenClaw's local `18789` default. Control UI device auth, sandboxing, and exec approvals are disabled for this trusted single-tenant customer app. Sylphx platform remains responsible for the outer service boundary.
- Gateway and agent concurrency are bounded before scaling up with measured FD, inotify, CPU, memory, and sandbox metrics. The shared OpenClaw default is `agents.defaults.maxConcurrent=8`; raise beyond that only with tenant-level latency and resource evidence.
- Node diagnostic reports and OpenClaw timeline diagnostics are persisted under `/data` for post-crash analysis.

The Sylphx platform implements a generic trusted-agent runtime profile. It translates `runtime.scratch` into internal ephemeral volume bindings and filters conflicting PVC mounts at the same path. It does not know that `/tmp` belongs to OpenClaw, nor which services are OpenClaw services.

## Build Strategy

Sylphx BuildPack remains the default target for ordinary customer source apps:
detect source, synthesize a Dockerfile template, and keep the standard BuildKit
pipeline. OpenClaw is not ordinary application source in this repo. This repo
builds a pinned upstream OpenClaw release plus a broad runtime toolchain
including Chromium, Docker daemon support, fonts, diagnostics, provider auth
profiles, and workspace bootstrap assets.
Base image references intentionally stay as upstream Docker Official Image tags
in this customer repo. Sylphx Platform owns transparent base-image mirroring in
the build layer, so OpenClaw does not learn or publish internal registry
topology and production deploys do not depend on direct Docker Hub access.

For now, `Dockerfile.base` stays as the explicit image recipe because it is the
single source of truth for that upstream-product packaging. The platform gap is
not "generic BuildPack cannot detect Node"; it is the absence of a higher-level
"upstream source app" template/profile that can package a third-party product
with extra runtime tools while the customer repo declares only product version,
runtime profile, and channels. That should be added to Sylphx platform as a
generic capability before removing this Dockerfile.

## Consequences

The immediate configuration removes `/tmp` from the PVC/virtiofs path, reduces watcher pressure by narrowing `/workspace`, preserves the real tenant home path, and captures actionable crash artifacts. It does not pretend Docker-in-Docker inside Kata is ideal. That remains a pressure point because Docker overlay storage wants filesystem behavior closer to a native Linux backing filesystem than a shared VM filesystem.

The long-term clean design is to move sandbox execution out of the gateway container into a separately owned worker/runtime primitive, or to provide a first-class platform sandbox service. Until then, OpenClaw disables its own sandboxing, keeps Docker state isolated under `/data/.docker-root`, and avoids using `/tmp` or the broad home tree as persistent shared scratch.

## Validation

For each OpenClaw pod after deployment:

```bash
mount | grep ' /tmp '
df -h /tmp /data
cat /proc/sys/fs/inotify/max_user_watches
cat /proc/sys/fs/inotify/max_user_instances
ls -lah /data/openclaw-reports /data/openclaw-diagnostics
openclaw health --json
```

During load:

```bash
for pid in $(pidof node dockerd containerd); do
  printf '%s %s\n' "$pid" "$(ls "/proc/$pid/fd" | wc -l)"
done
find /tmp/openclaw -maxdepth 1 -type f -printf '%TY-%Tm-%Td %TH:%TM %s %p\n' | sort | tail
```
