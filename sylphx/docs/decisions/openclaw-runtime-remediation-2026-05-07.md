# Decision: OpenClaw Runtime Remediation 2026-05-07

**Date:** 2026-05-07
**Status:** Accepted
**Author:** SylphxAI

## Context

The Epiow OpenClaw instance showed intermittent "no response" behavior after the initial provider-route fix. Live evidence showed:

- `EMFILE: too many open files` while writing OpenClaw diagnostics.
- The pod was still Ready, but `/proc/mounts` no longer contained the `/data` PVC mount.
- `$HOME=/data/epiow/home` and `/workspace` pointed at the missing path, so OpenClaw failed to persist sessions with `ENOENT` and `EACCES`.
- A restart restored the `/data` virtiofs mount and the existing auth profile, confirming the PVC was not deleted.

Separately, Wcloingod routed `sylphx/auto` through the global Sylphx AI default cascade because its client row had no per-client cascade. The global first candidate was OpenRouter DeepSeek, which returned a provider policy `404` instead of producing an answer.

## Decision

- `/workspace` is narrowed to `$HOME/.openclaw/workspace`; `$HOME` remains `/data/<instance>/home`.
- Legacy broad-home workspace files are copied or linked into the narrow workspace on boot so existing customer-visible files do not disappear.
- The entrypoint checks the `/data` mount and `$HOME` writability before launch and continuously while the gateway is alive. If the mount disappears, the gateway is stopped so Kubernetes replaces the pod instead of serving a Ready-but-broken instance.
- The entrypoint also fail-closes on unusable guest OS DNS: empty `/etc/resolv.conf` or no `nameserver` line (the Kata/`kataShared` virtiofs class where kubelet DNS files never mount and libc returns `EAI_AGAIN` while `dig @10.96.0.10` still works). OpenClaw **does not** invent nameservers; Platform owns guest DNS file mounts. Opt-out for local non-Kata debug only: `OPENCLAW_REQUIRE_GUEST_DNS=false`.
- `runtime.scratch` declares `/tmp` as `medium: "disk"` emptyDir to keep scratch state off the persistent PVC without moving large Chromium/Docker/package-manager temp files into the memory cgroup.
- `config-lock` merges through a temporary file and does not promote known-good until the gateway has survived health checks.
- Shared OpenClaw tenants lock `agents.defaults.model` to `sylphx/auto`. Per-tenant model overrides should be explicit customer choices, not schema drift between equivalent string/object encodings.
- Managed Sylphx AI keys use `SYLPHX_AI_API_KEY`; `ANTHROPIC_API_KEY` is only a compatibility alias for non-Anthropic-shaped keys.
- Per-client Sylphx AI cascades must be explicit for managed OpenClaw tenants. Do not rely on the global default for customer agents.
- Do not carry tenant-specific `tools.deny` entries for document formats such as `pdf` unless the customer asked for that restriction. Document analysis is part of the expected RFI/RFP workflow.
- The image artifact boundary must stay explicit without crossing Docker stage
  boundaries. OpenClaw is built, pruned, and narrowed in place, matching the
  upstream single-stage Docker model. Install, build, UI build, production
  prune, source narrowing, and runtime gates must stay in one cache-mounted
  `RUN`: splitting those steps commits the pre-prune dev dependency graph into
  image history, causing the Platform BuildKit OCI export/rewrite path to fail
  on large runtime layers. The runtime gate follows OpenClaw's launcher
  contract: `openclaw.mjs` must be present, `dist/entry.(m)js` must exist,
  upstream `check-package-dist-imports` must pass before source narrowing removes
  build-only files, and the image `CMD` plus `/usr/local/bin/openclaw` wrapper
  must invoke `openclaw.mjs`. Workspace template generation uses OpenClaw's
  canonical `docs/reference/templates/` tree, including `HEARTBEAT.md`. Do not
  reintroduce a builder-stage `/app` copy, high-inode cross-stage `cp -a`,
  tarball transfer for `node_modules`, optional `warning-filter` hard gates,
  separate pre-prune install/build layers, or guessed entrypoint checks such as
  `dist/main.js`; those either overload BuildKit worker boundaries, preserve
  build-only payload in image history, or validate a file the OpenClaw launcher
  does not require.

## Operational Result

On 2026-05-07, Epiow was restarted after the broken `/data` mount was observed. After restart:

- `/data` and `/tmp` were both mounted as virtiofs in the Kata VM.
- `/data/epiow/home` existed and was writable.
- `sylphx:default` auth profile existed.
- `openclaw infer model run --local --model sylphx/auto --prompt "Say pong only." --json` returned `pong`.
- Node and dockerd FD counts returned to low steady-state values.

Wcloingod, Cubeage, and Ozyrix Sylphx AI client cascades were pinned to direct managed providers with `z-ai/glm-5.1` first. Wcloingod then routed to `z-ai/glm-5.1` and returned `200`.

## Follow-Up

- Rotate any credential that was ever committed into `agents.yaml`.
- Build and redeploy OpenClaw from this repo so the narrowed workspace,
  data-mount watchdog, and explicit runtime artifact assembly are active in
  every tenant.
- Retire legacy `openclaw` namespace deployments after confirming PVC migration/archive policy.
- Move platform AI serving fully out of the management plane into the BaaS/runtime plane.
