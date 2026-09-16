# Decision: Recover stale SQLite journals at boot instead of failing the container

**Date:** 2026-09-16
**Status:** Accepted
**Author:** SylphxAI

## Context

On 2026-09-16 the Epiow tenant (`env-019dff1bf14c74ae808a`) was in
`CrashLoopBackOff` for roughly 35 hours and served no traffic. The visible
symptom was identical on every restart:

```text
[entrypoint] [auth-store] Materializing OpenClaw SQLite auth store from ...
[entrypoint] [auth-store] Failed to materialize SQLite auth store: attempt to write a readonly database
```

`attempt to write a readonly database` is a SQLite error, not a filesystem
`EROFS`. Two independent conditions were needed to reach it:

1. An earlier cluster-wide storage fault made the tenant's `/data` mount
   read-only inside the Kata guest. A gateway run died with the same error and
   the pod was then OOM-killed.
2. The killed writer left a **rollback journal** on the volume. OpenClaw's
   read-only SQLite path (`prepareSqliteSnapshotSource`) treats a sidecar
   journal as "another writer owns this database" and opens a read-only
   snapshot, so the auth-store materializer's schema admission
   (`PRAGMA writable_schema = ON`) fails with `readonly database`.

Once the volume itself was writable again the crash loop persisted, because the
stale journal survived every restart. Recovery required an operator to clear the
volume by hand, which is exactly the manual step this repository exists to
remove.

Two defects made the failure reachable and unrecoverable:

- **No boot-time recovery.** The entrypoint had no step that lets SQLite roll a
  hot journal back, and no step that clears leftover OpenClaw writer-lock
  databases (`*.generation-lock.sqlite`, `*.generation-writer.sqlite`,
  `*.reindex-lock.sqlite`) after a kill.
- **Incomplete environment for the node-scoped run.** The auth-store
  materializer runs through `runuser -u node -- env ...` with only `HOME`,
  `OPENCLAW_STATE_DIR`, and `OPENCLAW_CONFIG_PATH`. OpenClaw resolves its
  private SQLite snapshot staging root from `XDG_CACHE_HOME` and
  `resolveRequiredOsHomeDir()`, so the missing XDG variables made the staging
  directory resolve outside the persistent volume. That is a second path to the
  same read-only snapshot fallback.

## Decision

- Add `sylphx/scripts/recover-sqlite-state.py`, run by the entrypoint as boot
  step 4b, before any OpenClaw writer starts. It opens each real
  `*.sqlite` database once so SQLite performs hot-journal rollback itself, then
  removes only SQLite sidecars (`-journal`, `-wal`, `-shm`) and the known
  OpenClaw writer-lock files.
- The recovery is deliberately narrow: it never deletes a database, a memory
  reindex temp file, workspace content, or any file that is not a SQLite
  sidecar or a known lock name. It reports `checked`, `removed`, and `failures`
  as JSON and never makes boot fail on its own error — a volume it cannot repair
  must still produce a clear log line instead of a silent loop.
- Pass the full XDG environment (`XDG_CACHE_HOME`, `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_STATE_HOME`) to the node-scoped auth-store
  materializer, matching what the entrypoint already exports for itself.
- Guard both with `sylphx/scripts/recover-sqlite-state.test.py`, wired into CI
  as the `sylphx scripts` job. The suite reproduces a genuine hot journal by
  SIGKILLing a writer mid-transaction, then asserts the journal is rolled back,
  the database becomes writable, uncommitted data is discarded, and only
  sidecar/lock files are removed.

## Consequences

- A storage fault or an OOM kill no longer requires manual PVC surgery. The
  tenant recovers on the next pod start.
- CI now exercises `sylphx/*` changes, which previously fell outside the
  `changed-scope` Node trigger and had no test lane at all.
- The recovery removes a hot journal by rolling it back, which discards
  uncommitted writes from the killed transaction. That is SQLite's own crash
  contract and is strictly safer than leaving the database unwritable.
- Follow-up, out of scope here: the storage fault that produced the read-only
  mount in the first place belongs to the cluster's storage layer, not to this
  image.
