---
name: memory-consolidate
description: Consolidate OpenClaw MEMORY.md into curated long-term memory under bootstrap limits; scrub secrets; archive full history for memory_search.
---

# Memory Consolidate

Use when MEMORY.md is large, truncated at bootstrap (`bootstrapMaxChars`, default 20000), contains secrets, or the operator asks to consolidate memory.

## OpenClaw memory model (SSOT)

| File | Role | Injection |
|------|------|-----------|
| `MEMORY.md` | Curated long-term facts | Auto-injected (truncated at bootstrap max) |
| `memory/YYYY-MM-DD.md` | Daily / episodic logs | On-demand via `memory_search` / `memory_get` |
| `memory/archive/` | Full pre-consolidation snapshots | On-demand only |

## Rules

1. **Never store plaintext secrets** (PATs, API keys, private keys, AWS secrets). Use `op://…` references only.
2. Prefer **short durable facts** in `MEMORY.md`; put narrative / day-by-day detail in `memory/*.md`.
3. Do **not** delete daily logs. Archive oversized `MEMORY.md` first, then rewrite curated form.
4. Stay under **~16k characters** in `MEMORY.md` (safe under 20k bootstrap default).
5. After rewrite: `openclaw memory index` (when embeddings available).

## Automated helper (Sylphx image)

```bash
openclaw-memory-consolidate \
  --workspace "$HOME/.openclaw/workspace" \
  --budget 16000
```

Options:

- `--scrub-only` — redact secrets without rewriting structure
- `--dry-run` — print actions only
- `--budget N` — consolidated MEMORY.md char budget (default 16000)

## Manual agent protocol

1. Scrub secrets in `MEMORY.md` + `memory/**/*.md`.
2. Copy current `MEMORY.md` → `memory/archive/MEMORY-full-<stamp>.md`.
3. Rewrite `MEMORY.md` with durable sections only:
   - Security / approval rules
   - Identity / people / allowlists
   - Credential **references** (`op://…`), never values
   - Project map / account map
   - Hard lessons / workflow rules
4. Add a short **Memory map** pointing at archive + daily logs.
5. Run `openclaw memory index` and `openclaw memory status`.
6. Optional: `openclaw memory promote` / REM tools when configured.

## Cron (recommended)

Every few days (agent-owned cron):

```text
Review MEMORY.md + recent memory/*.md. Scrub any secrets. Consolidate durable
facts into MEMORY.md under 16k chars. Archive full prior MEMORY if oversized.
Reply NO_REPLY if nothing material changed.
```
