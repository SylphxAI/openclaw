# MEMORY.md — Long-Term Memory

_Curated durable facts only. Keep this file under ~16k characters (bootstrap injects max 20k)._

## What belongs here
- Security / approval rules
- People + allowlists
- Credential **references** (`op://…`) — never plaintext tokens/keys
- Project / account maps
- Hard lessons that must survive session compaction

## What does NOT belong here
- Day-by-day narrative → `memory/YYYY-MM-DD.md`
- Secrets, PATs, private keys, AWS secret values
- Huge paste dumps (meeting notes, logs) → archive or daily memory

## Consolidate
- Skill: `memory-consolidate`
- Helper: `openclaw-memory-consolidate --workspace "$HOME/.openclaw/workspace"`
- After major work: consolidate; full prior MEMORY goes to `memory/archive/`.
