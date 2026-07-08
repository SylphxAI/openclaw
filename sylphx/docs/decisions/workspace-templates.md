# Decision: Build-Time Workspace Template Generation

**Date:** 2026-02-12
**Status:** Accepted
**Author:** Kyle Tse

## Problem

The `workspace/` directory in the repo contained full copies of OpenClaw's default workspace templates (AGENTS.md, SOUL.md, TOOLS.md, etc.). This created several problems:

1. **Stale copies** — When OpenClaw updated its templates, our copies didn't change
2. **Maintenance burden** — Had to manually sync templates on every OpenClaw upgrade
3. **Layer violation** — This customer app repo was managing content owned by OpenClaw upstream

## Decision

Extract workspace templates from OpenClaw's own source tree at Docker build time using a Python script (`scripts/build-workspace-templates.py`).

The repo only stores:
- `workspace/agents-base-section.md` — Customer runtime conventions (bun, mcporter, config safety)
- `workspace/MEMORY.md` — Long-term memory stub (not part of OpenClaw's default bootstrap)

## Architecture

```
Layer 3: Instance (agent) — IDENTITY.md, USER.md, channels, memory → never overwritten
Layer 2: Customer app (us) — BASE section in AGENTS.md → refreshed every boot
Layer 1: OpenClaw (upstream) — Default templates → updated on upgrade
```

Build-time flow:
1. Builder stage clones OpenClaw source
2. `build-workspace-templates.py` reads `/app/docs/reference/templates/`
3. Strips YAML frontmatter from each template
4. Appends `agents-base-section.md` content to AGENTS.md
5. Copies MEMORY.md (extra file not in OpenClaw defaults)
6. Writes everything to `/app/workspace/`

Runtime flow (entrypoint.sh):
1. First boot: copies `/app/workspace/*` to `/workspace`, which resolves to `$HOME/.openclaw/workspace`
2. Every boot: refreshes `<!-- BASE-START -->` / `<!-- BASE-END -->` markers in AGENTS.md

## Alternatives Considered

### 1. Manual copies in repo (previous approach)
- ❌ Stale — copies drift from upstream on every OpenClaw release
- ❌ Maintenance burden — requires manual sync
- ❌ Layer violation — customer app repo owns upstream content

### 2. Let OpenClaw bootstrap + inject BASE on second boot
- ❌ First boot has no BASE section (timing race)
- ❌ Agent starts without infra conventions until next restart
- ✅ Simpler — no build-time extraction

### 3. Runtime read from OpenClaw source
- ❌ Fragile path dependency at runtime
- ❌ Source tree may not exist in production image (pruned)
- ✅ Always in sync

## Why Build-Time

- ✅ Always in sync with installed OpenClaw version
- ✅ BASE section available from first boot
- ✅ Zero maintenance — upgrading OpenClaw automatically picks up new templates
- ✅ Each layer owns its own content
- ✅ No runtime fragility

## Trade-offs

- Depends on `/app/docs/reference/templates/` path existing in the OpenClaw source tree
  - Confirmed stable: maps to `resolveWorkspaceTemplateDir()` in OpenClaw source
  - Build fails loudly if path is missing (script exits with error)
- Adds a build step (Python script) — minimal complexity, ~60 lines
- YAML frontmatter stripping must match OpenClaw's `stripFrontMatter()` — implemented identically

## Files Changed

- `workspace/` — Removed all template copies, kept `agents-base-section.md` + `MEMORY.md`
- `scripts/build-workspace-templates.py` — New build-time script
- `Dockerfile.base` — Replaced `COPY workspace/` with build-time generation
- `scripts/entrypoint.sh` — Updated comments (no logic changes)
- `README.md` — Documented new architecture
