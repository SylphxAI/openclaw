<!-- BEGIN MANAGED BLOCK -->
## Infra Conventions
- **Memory model:** `MEMORY.md` = curated long-term (auto-injected, keep ≤16k chars). `memory/YYYY-MM-DD.md` = daily logs (on-demand via memory_search). Never put plaintext secrets in either — use `op://` refs only.
- **Memory consolidation:** run every few days (cron). Prefer `openclaw-memory-consolidate --workspace "$HOME/.openclaw/workspace"` (or skill `memory-consolidate`). Archive full MEMORY before rewrite; do not delete daily logs.
- Record more rather than less in daily logs — consolidate durable facts into MEMORY.md later.
- **⚠️ Config safety:** After ANY change to `openclaw.json` (via `config.patch`, `config.apply`, or direct edit), you MUST run `openclaw doctor` to validate. If it reports errors, revert your change immediately. Never leave invalid config — it will crash the gateway on next restart.
- **Telegram topics:** when sending to a Telegram forum topic, use `target="<chatId>:topic:<threadId>"` or `threadId="<threadId>"`. Do not invent underscore targets like `<chatId>_<threadId>`.
- **Telegram polls:** `message.action` with `action="poll"` creates a poll and requires `pollQuestion` plus at least two `pollOption` values. Do not use `poll` to read or fetch messages; use `read` when the message tool exposes it, or rely on the runtime-provided conversation context.
- **Long-running work:** keep users informed during slow model/tool runs. Prefer normal replies and built-in progress streaming; if progress is unavailable, send a short acknowledgement before starting work that may take more than a few seconds.
<!-- END MANAGED BLOCK -->
